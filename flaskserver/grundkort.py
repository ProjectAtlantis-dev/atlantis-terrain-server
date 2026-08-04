"""Self-healing Asiaq Teknisk Grundkort ingestion.

Settlement zips (``*_TekniskGrundkort_SHP.zip``) live in ``grundkort/``
(gitignored). A background worker conditionally refreshes configured
settlements (``terrain_config.GRUNDKORT_SETTLEMENTS``) at least weekly using
the source server's ETag/Last-Modified validators. Re-ingestion happens only
when the normalized SHP/DBF/PRJ payload changes, so a repackaged archive or a
DBF export-date change does not churn the asset catalog. A fresh clone or a
flushed assets.db repopulates itself the same way tiles and masks do; extra
zips dropped in manually are ingested too.

Buildings and roads are ingested directly into ``assets.db``. Flask reads
that catalog while processing
``/api/tiles`` and includes the matching buildings in the tile response;
the browser never contacts the asset server or a separate building endpoint.

Fresh-DB ordering is handled by deferral: buildings ingested before the
area's heightmaps exist keep ``groundSampled=false`` in their asset properties;
a background loop re-samples them from real heightmaps as those stream in.
"""
from __future__ import annotations

import json
import hashlib
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from email.utils import formatdate
from pathlib import Path
from typing import Callable

from colored_log import get_logger
from terrain_config import GRUNDKORT_SETTLEMENTS

log = get_logger("terrain.grundkort")

ZIP_DIR = Path(__file__).resolve().parent / "grundkort"
DB_PATH = Path(__file__).resolve().parent / "terrain.db"
ASSETS_DB_PATH = Path(__file__).resolve().parent.parent / "assetserver" / "assets.db"
_FILES_URL = "https://kortforsyning.asiaq.gl/files"
_GROUND_RETRY_S = 60.0
REFRESH_POLL_S = 24 * 60 * 60
# The daily scheduler can notice a TTL boundary up to one poll late. A six-day
# TTL therefore guarantees a successful source check at least once per week.
REFRESH_INTERVAL_S = 6 * 24 * 60 * 60
DEMAND_RADIUS_M = 30_000.0
DEMAND_RETRY_AFTER_S = 300.0
_ingest_lock = threading.RLock()


def _refresh_metadata_path(target: Path) -> Path:
    return target.with_name(target.name + ".refresh.json")


def _read_refresh_metadata(target: Path) -> dict:
    try:
        value = json.loads(_refresh_metadata_path(target).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _write_refresh_metadata(target: Path, metadata: dict) -> None:
    path = _refresh_metadata_path(target)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(
        json.dumps(metadata, ensure_ascii=False, sort_keys=True), encoding="utf-8"
    )
    temporary.replace(path)


def _archive_content_digest(path: Path) -> str:
    """Hash source payloads while ignoring the DBF last-update date."""
    from ingest_buildings import SOURCE_LAYER as building_layer
    from ingest_roads import SOURCE_LAYERS as road_layers

    digest = hashlib.sha256()
    with zipfile.ZipFile(path) as archive:
        names = {Path(name).name.upper(): name for name in archive.namelist()}
        for layer in (building_layer, *road_layers):
            for suffix in ("SHP", "DBF", "PRJ"):
                member_name = f"{layer}.{suffix}"
                digest.update(member_name.encode("ascii"))
                archive_name = names.get(member_name)
                if archive_name is None:
                    digest.update(b"\0missing")
                    continue
                data = archive.read(archive_name)
                if suffix == "DBF" and len(data) >= 4:
                    # Bytes 1-3 are YY/MM/DD and change when Asiaq republishes
                    # an otherwise identical shapefile export.
                    data = data[:1] + b"\0\0\0" + data[4:]
                digest.update(data)
    return digest.hexdigest()


def _download_settlement(folder: str, *, now: float | None = None) -> bool:
    """Refresh a settlement archive when due; return source-content change."""
    code = folder.split("_")[0]
    target = ZIP_DIR / f"{code}_TekniskGrundkort_SHP.zip"
    checked_at = time.time() if now is None else now
    metadata = _read_refresh_metadata(target)
    try:
        previous_check = float(metadata.get("checkedAt", 0))
    except (TypeError, ValueError):
        previous_check = 0
    current_digest = metadata.get("contentDigest")
    if target.exists() and checked_at - previous_check < REFRESH_INTERVAL_S:
        if not isinstance(current_digest, str):
            current_digest = _archive_content_digest(target)
        return current_digest != metadata.get("ingestedDigest")

    url = f"{_FILES_URL}/{folder}/SHP/{target.name}"
    partial = target.with_name(target.name + ".part")
    headers = {"User-Agent": "atlantis-terrain/grundkort"}
    if target.exists():
        if metadata.get("etag"):
            headers["If-None-Match"] = str(metadata["etag"])
        if metadata.get("lastModified"):
            headers["If-Modified-Since"] = str(metadata["lastModified"])
        elif not metadata.get("etag"):
            headers["If-Modified-Since"] = formatdate(
                target.stat().st_mtime, usegmt=True
            )
    log.info(f"[grundkort] checking {target.name} for source updates")
    started = time.time()
    request = urllib.request.Request(url, headers=headers)
    try:
        response = urllib.request.urlopen(request, timeout=60)
    except urllib.error.HTTPError as exc:
        if exc.code != 304 or not target.exists():
            raise
        if not isinstance(current_digest, str):
            current_digest = _archive_content_digest(target)
        metadata.update({
            "checkedAt": checked_at,
            "contentDigest": current_digest,
            "etag": exc.headers.get("ETag") or metadata.get("etag"),
            "lastModified": (
                exc.headers.get("Last-Modified") or metadata.get("lastModified")
            ),
        })
        _write_refresh_metadata(target, metadata)
        log.info(f"[grundkort] {target.name} is current")
        return current_digest != metadata.get("ingestedDigest")

    try:
        with response:
            total = int(response.headers.get("Content-Length") or 0)
            done = 0
            next_report = 0.1
            with open(partial, "wb") as out:
                while chunk := response.read(1 << 20):
                    out.write(chunk)
                    done += len(chunk)
                    if total and done / total >= next_report:
                        elapsed = time.time() - started
                        eta = elapsed / done * (total - done)
                        log.info(
                            f"[grundkort] {target.name}: {done * 100 // total}% "
                            f"eta {eta:.0f}s"
                        )
                        next_report += 0.1
            next_digest = _archive_content_digest(partial)
            partial.replace(target)
            metadata.update({
                "checkedAt": checked_at,
                "contentDigest": next_digest,
                "etag": response.headers.get("ETag"),
                "lastModified": response.headers.get("Last-Modified"),
            })
    finally:
        partial.unlink(missing_ok=True)
    _write_refresh_metadata(target, metadata)
    log.info(
        f"[grundkort] {target.name} refreshed "
        f"({(target.stat().st_size) / 1e6:.0f} MB in {time.time() - started:.0f}s)"
    )
    return next_digest != metadata.get("ingestedDigest")


def _mark_archive_ingested(target: Path) -> None:
    metadata = _read_refresh_metadata(target)
    digest = metadata.get("contentDigest")
    if not isinstance(digest, str):
        digest = _archive_content_digest(target)
        metadata["contentDigest"] = digest
    metadata["ingestedDigest"] = digest
    _write_refresh_metadata(target, metadata)


def _settlement_loaded(folder: str, assets_db_path: Path = ASSETS_DB_PATH) -> bool:
    """Return whether this package has produced either vector layer."""
    settlement = _settlement_of(folder)
    if settlement is None or not assets_db_path.exists():
        return False
    db = sqlite3.connect(str(assets_db_path))
    try:
        from ingest_buildings import SOURCE_LAYER as building_layer
        from ingest_roads import SOURCE_LAYERS as road_layers
        return bool(
            db.execute(
                "SELECT 1 FROM assets WHERE type=? AND id LIKE ? LIMIT 1",
                (building_layer, f"{settlement}_%"),
            ).fetchone()
            or db.execute(
                "SELECT 1 FROM assets WHERE type IN (?,?) "
                "AND id LIKE ? LIMIT 1",
                (*road_layers, f"{settlement}_%"),
            ).fetchone()
        )
    except sqlite3.OperationalError:
        return False
    finally:
        db.close()


def _settlement_of(name: str) -> str | None:
    match = re.match(r"(\d{4}[A-Z]{3})", name)
    return match.group(1) if match else None


def ensure_grundkort(db_path: Path = DB_PATH) -> None:
    """Download configured settlements, ingest missing rows. Idempotent."""
    ZIP_DIR.mkdir(exist_ok=True)
    for folder in GRUNDKORT_SETTLEMENTS:
        try:
            ensure_settlement(folder, db_path)
        except Exception as exc:
            log.warning(
                f"[grundkort] acquisition of {folder} failed "
                f"({type(exc).__name__}: {exc}) — will retry during refresh"
            )
    # Manually dropped archives remain supported and are ingested at startup.
    for zip_path in sorted(ZIP_DIR.glob("*.zip")):
        ensure_settlement_archive(zip_path, db_path)
    zips = sorted(ZIP_DIR.glob("*.zip"))
    if not zips:
        log.info("[grundkort] no settlement zips in grundkort/ — buildings/roads stay empty")
        return

    db = sqlite3.connect(str(db_path))
    _, pending = repair_unsampled_ground(db, ASSETS_DB_PATH)
    db.close()
    if pending:
        log.info(
            f"[grundkort] {pending} building grounds still estimated — "
            f"retrying every {_GROUND_RETRY_S:.0f}s as heightmaps arrive"
        )
        threading.Thread(
            target=_ground_retry_loop, args=(db_path,), daemon=True
        ).start()


def ensure_settlement(folder: str, db_path: Path = DB_PATH) -> None:
    """Refresh and ingest one Asiaq settlement package idempotently."""
    with _ingest_lock:
        ZIP_DIR.mkdir(exist_ok=True)
        source_changed = _download_settlement(folder)
        code = folder.split("_")[0]
        target = ZIP_DIR / f"{code}_TekniskGrundkort_SHP.zip"
        ingested = ensure_settlement_archive(
            target, db_path, force=source_changed
        )
        if source_changed and ingested:
            _mark_archive_ingested(target)


def ensure_settlement_archive(
    zip_path: Path, db_path: Path = DB_PATH, *, force: bool = False
) -> bool:
    """Ingest missing layers, or every layer after a source-content change."""
    with _ingest_lock:
        settlement = _settlement_of(zip_path.name)
        if settlement is None:
            log.warning(f"[grundkort] cannot infer settlement from {zip_path.name}, skipping")
            return False
        from asset_catalog import connect
        from ingest_buildings import SOURCE_LAYER as building_layer
        from ingest_roads import SOURCE_LAYERS as road_layers
        db = connect(ASSETS_DB_PATH)
        try:
            missing_buildings = not db.execute(
                "SELECT 1 FROM assets WHERE type=? AND id LIKE ? LIMIT 1",
                (building_layer, f"{settlement}_%"),
            ).fetchone()
            missing_roads = not db.execute(
                "SELECT 1 FROM assets WHERE type IN (?,?) "
                "AND id LIKE ? LIMIT 1",
                (*road_layers, f"{settlement}_%"),
            ).fetchone()
        finally:
            db.close()
        if missing_buildings or force:
            import ingest_buildings

            reason = "source changed" if force else "buildings missing"
            log.info(f"[grundkort] {settlement}: {reason}, ingesting {zip_path.name}")
            if ingest_buildings.ingest(zip_path, db_path, ASSETS_DB_PATH) != 0:
                raise RuntimeError(f"building ingest failed for {zip_path.name}")
        if missing_roads or force:
            import ingest_roads

            reason = "source changed" if force else "roads missing"
            log.info(f"[grundkort] {settlement}: {reason}, ingesting {zip_path.name}")
            if ingest_roads.ingest(zip_path, ASSETS_DB_PATH) != 0:
                raise RuntimeError(f"road ingest failed for {zip_path.name}")
        return bool(missing_buildings or missing_roads or force)


def ensure_grundkort_async() -> None:
    def _run() -> None:
        try:
            ensure_grundkort()
        except Exception as exc:
            log.error(f"[grundkort] startup ingest failed: {type(exc).__name__}: {exc}")
        while True:
            time.sleep(REFRESH_POLL_S)
            for folder in GRUNDKORT_SETTLEMENTS:
                try:
                    ensure_settlement(folder)
                except Exception as exc:
                    log.warning(
                        f"[grundkort] refresh of {folder} failed "
                        f"({type(exc).__name__}: {exc}) — retrying on next daily check"
                    )

    threading.Thread(target=_run, daemon=True).start()


class GrundkortDemand:
    """Single-worker acquisition queue driven by camera position."""

    def __init__(
        self,
        *,
        centres: tuple[tuple[str, float, float], ...],
        acquire: Callable[[str], None],
        loaded: Callable[[str], bool],
        radius_m: float = DEMAND_RADIUS_M,
        retry_after_s: float = DEMAND_RETRY_AFTER_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._centres = centres
        self._acquire = acquire
        self._loaded = loaded
        self._radius_sq = radius_m * radius_m
        self._retry_after_s = retry_after_s
        self._clock = clock
        # Settlement archives vary from a few MB to tens of MB. Serial work
        # avoids competing downloads and concurrent bulk SQLite writes.
        self._pool = ThreadPoolExecutor(max_workers=1)
        self._lock = threading.RLock()
        self._enabled = False
        self._inflight: set[str] = set()
        self._failed_at: dict[str, float] = {}

    def enable(self) -> None:
        with self._lock:
            self._enabled = True

    def request_for_point(self, qx: float, qy: float) -> list[str]:
        nearby = [
            folder
            for folder, cx, cy in self._centres
            if (cx - qx) ** 2 + (cy - qy) ** 2 <= self._radius_sq
        ]
        scheduled: list[str] = []
        with self._lock:
            if not self._enabled:
                return scheduled
            now = self._clock()
            for folder in nearby:
                if folder in self._inflight or self._loaded(folder):
                    continue
                failed_at = self._failed_at.get(folder)
                if failed_at is not None and now - failed_at < self._retry_after_s:
                    continue
                self._inflight.add(folder)
                scheduled.append(folder)
        for folder in scheduled:
            log.info(f"[grundkort-demand] {folder}: queued from camera demand")
            self._pool.submit(self._run, folder)
        return scheduled

    def _run(self, folder: str) -> None:
        try:
            self._acquire(folder)
            with self._lock:
                self._failed_at.pop(folder, None)
            log.info(f"[grundkort-demand] {folder}: acquisition complete")
        except Exception as exc:
            with self._lock:
                self._failed_at[folder] = self._clock()
            log.warning(
                f"[grundkort-demand] {folder}: {type(exc).__name__}: {exc}; "
                f"retrying after {self._retry_after_s:.0f}s on later demand"
            )
        finally:
            with self._lock:
                self._inflight.discard(folder)

    def status(self) -> dict[str, list[str]]:
        with self._lock:
            return {"inflight": sorted(self._inflight)}


_default_demand_lock = threading.Lock()
_default_demand: GrundkortDemand | None = None


def default_demand() -> GrundkortDemand:
    global _default_demand
    with _default_demand_lock:
        if _default_demand is None:
            from coords import to_stereo
            from grundkort_catalog import SETTLEMENTS

            centres = tuple(
                (folder, *to_stereo(lat, lon)) for folder, lat, lon in SETTLEMENTS
            )
            _default_demand = GrundkortDemand(
                centres=centres,
                acquire=ensure_settlement,
                loaded=_settlement_loaded,
            )
        return _default_demand


def enable_demand() -> None:
    default_demand().enable()


def request_for_point(qx: float, qy: float) -> list[str]:
    return default_demand().request_for_point(qx, qy)


def demand_status() -> dict[str, list[str]]:
    return default_demand().status()


def repair_unsampled_ground(
    terrain_db: sqlite3.Connection,
    assets_db_path: Path = ASSETS_DB_PATH,
) -> tuple[int, int]:
    """Re-sample estimated building grounds; return (fixed, still_pending)."""
    if not assets_db_path.exists():
        return 0, 0
    assets_db = sqlite3.connect(str(assets_db_path))
    try:
        from ingest_buildings import SOURCE_LAYER
        rows = assets_db.execute(
            "SELECT id,cx,cy,properties FROM assets "
            "WHERE type=? "
            "AND json_extract(properties,'$.groundSampled')=0",
            (SOURCE_LAYER,),
        ).fetchall()
    except sqlite3.OperationalError:
        assets_db.close()
        return 0, 0  # schema not ensured yet
    if not rows:
        assets_db.close()
        return 0, 0
    from ingest_buildings import GroundSampler

    sampler = GroundSampler(terrain_db)
    if not sampler.tiles:
        assets_db.close()
        return 0, len(rows)
    fixed = 0
    for building_id, cx, cy, raw_properties in rows:
        ground = sampler.sample(cx, cy)
        if ground is None:
            continue
        properties = json.loads(raw_properties)
        roof_min = min(z for _, _, z in properties["ring"])
        ground = round(min(ground, roof_min - 0.5), 2)
        properties["groundZ"] = ground
        properties["groundSampled"] = True
        assets_db.execute(
            "UPDATE assets SET z=?,properties=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
            (ground, json.dumps(properties, ensure_ascii=False), building_id),
        )
        fixed += 1
    if fixed:
        assets_db.commit()
        log.info(f"[grundkort] re-sampled ground for {fixed} buildings from heightmaps")
    assets_db.close()
    return fixed, len(rows) - fixed


def _ground_retry_loop(db_path: Path) -> None:
    """Retry ground re-sampling until no building is left on an estimate."""
    while True:
        time.sleep(_GROUND_RETRY_S)
        db = sqlite3.connect(str(db_path))
        fixed, pending = repair_unsampled_ground(db, ASSETS_DB_PATH)
        db.close()
        if pending == 0:
            log.info("[grundkort] all building grounds sampled from heightmaps")
            return
