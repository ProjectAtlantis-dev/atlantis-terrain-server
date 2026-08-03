"""Self-healing Asiaq Teknisk Grundkort ingestion.

Settlement zips (``*_TekniskGrundkort_SHP.zip``) live in ``grundkort/``
(gitignored). At server startup a background thread downloads any
configured settlement (``terrain_config.GRUNDKORT_SETTLEMENTS``) that is
missing locally — kortforsyning.asiaq.gl is an open file server, no
auth — then ingests any settlement whose buildings/roads rows are
missing. A fresh clone or a flushed terrain.db repopulates itself the
same way tiles and masks do; extra zips dropped in manually are ingested
too.

After ingest, buildings are synced into the asset server's ``assets.db``
as ``type='building'`` rows. Flask reads that catalog while processing
``/api/tiles`` and includes the matching buildings in the tile response;
the browser never contacts the asset server or a separate building endpoint.

Fresh-DB ordering is handled by deferral: buildings ingested before the
area's heightmaps exist get ``ground_sampled = 0`` (roof-derived ground
estimate); a background loop re-samples them from real heightmaps as
those stream in and re-syncs the fixed rows to assets.db.
"""
from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
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
DEMAND_RADIUS_M = 30_000.0
DEMAND_RETRY_AFTER_S = 300.0
_ingest_lock = threading.RLock()

# Mirrors the asset server's initDb DDL (server.ts) so seeding works even
# if the asset server has never run; both sides guard the cx/cy migration.
_ASSETS_SCHEMA = """
CREATE TABLE IF NOT EXISTS assets (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  lat         REAL NOT NULL,
  lon         REAL NOT NULL,
  heading_deg REAL NOT NULL DEFAULT 0,
  z           REAL,
  properties  TEXT NOT NULL DEFAULT '{}',
  saved_at    REAL,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


def _download_settlement(folder: str) -> None:
    """Fetch a settlement's SHP zip from the open Asiaq file server."""
    code = folder.split("_")[0]
    target = ZIP_DIR / f"{code}_TekniskGrundkort_SHP.zip"
    if target.exists():
        return
    url = f"{_FILES_URL}/{folder}/SHP/{target.name}"
    partial = target.with_name(target.name + ".part")
    log.info(f"[grundkort] downloading {target.name} from {url}")
    started = time.time()
    request = urllib.request.Request(
        url, headers={"User-Agent": "atlantis-terrain/grundkort"}
    )
    with urllib.request.urlopen(request, timeout=60) as response:
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
    partial.rename(target)
    log.info(
        f"[grundkort] {target.name} downloaded "
        f"({(target.stat().st_size) / 1e6:.0f} MB in {time.time() - started:.0f}s)"
    )


def _settlement_loaded(folder: str, db_path: Path = DB_PATH) -> bool:
    """Return whether this package has produced either vector layer."""
    settlement = _settlement_of(folder)
    if settlement is None or not db_path.exists():
        return False
    db = sqlite3.connect(str(db_path))
    try:
        return bool(
            db.execute(
                "SELECT 1 FROM buildings WHERE settlement = ? LIMIT 1",
                (settlement,),
            ).fetchone()
            or db.execute(
                "SELECT 1 FROM roads WHERE settlement = ? LIMIT 1",
                (settlement,),
            ).fetchone()
        )
    except sqlite3.OperationalError:
        return False
    finally:
        db.close()


def _settlement_of(name: str) -> str | None:
    match = re.match(r"(\d{4}[A-Z]{3})", name)
    return match.group(1) if match else None


def _ensure_schema(db) -> None:
    from ingest_buildings import BUILDINGS_SCHEMA
    from ingest_roads import ROADS_SCHEMA

    db.executescript(BUILDINGS_SCHEMA)
    db.executescript(ROADS_SCHEMA)
    columns = {row[1] for row in db.execute("PRAGMA table_info(buildings)")}
    if "ground_sampled" not in columns:
        db.execute(
            "ALTER TABLE buildings "
            "ADD COLUMN ground_sampled INTEGER NOT NULL DEFAULT 1"
        )
    db.commit()


def ensure_grundkort(db_path: Path = DB_PATH) -> None:
    """Download configured settlements, ingest missing rows. Idempotent."""
    ZIP_DIR.mkdir(exist_ok=True)
    for folder in GRUNDKORT_SETTLEMENTS:
        try:
            ensure_settlement(folder, db_path)
        except Exception as exc:
            log.warning(
                f"[grundkort] acquisition of {folder} failed "
                f"({type(exc).__name__}: {exc}) — will retry next startup"
            )
    # Manually dropped archives remain supported and are ingested at startup.
    for zip_path in sorted(ZIP_DIR.glob("*.zip")):
        ensure_settlement_archive(zip_path, db_path)
    zips = sorted(ZIP_DIR.glob("*.zip"))
    if not zips:
        log.info("[grundkort] no settlement zips in grundkort/ — buildings/roads stay empty")
        return

    db = sqlite3.connect(str(db_path))
    _, pending = repair_unsampled_ground(db)
    db.close()
    sync_buildings_to_assets(db_path)
    sync_roads_to_assets(db_path)
    if pending:
        log.info(
            f"[grundkort] {pending} building grounds still estimated — "
            f"retrying every {_GROUND_RETRY_S:.0f}s as heightmaps arrive"
        )
        threading.Thread(
            target=_ground_retry_loop, args=(db_path,), daemon=True
        ).start()


def ensure_settlement(folder: str, db_path: Path = DB_PATH) -> None:
    """Download and ingest one Asiaq settlement package, idempotently."""
    with _ingest_lock:
        ZIP_DIR.mkdir(exist_ok=True)
        _download_settlement(folder)
        code = folder.split("_")[0]
        ensure_settlement_archive(
            ZIP_DIR / f"{code}_TekniskGrundkort_SHP.zip", db_path
        )


def ensure_settlement_archive(zip_path: Path, db_path: Path = DB_PATH) -> None:
    """Ingest missing vector layers from one already-local archive."""
    with _ingest_lock:
        settlement = _settlement_of(zip_path.name)
        if settlement is None:
            log.warning(f"[grundkort] cannot infer settlement from {zip_path.name}, skipping")
            return
        db = sqlite3.connect(str(db_path))
        try:
            _ensure_schema(db)
            missing_buildings = not db.execute(
                "SELECT 1 FROM buildings WHERE settlement = ? LIMIT 1", (settlement,)
            ).fetchone()
            missing_roads = not db.execute(
                "SELECT 1 FROM roads WHERE settlement = ? LIMIT 1", (settlement,)
            ).fetchone()
        finally:
            db.close()
        if missing_buildings:
            import ingest_buildings

            log.info(f"[grundkort] {settlement}: buildings missing, ingesting {zip_path.name}")
            ingest_buildings.ingest(zip_path, db_path)
        if missing_roads:
            import ingest_roads

            log.info(f"[grundkort] {settlement}: roads missing, ingesting {zip_path.name}")
            ingest_roads.ingest(zip_path, db_path)
        if missing_buildings or missing_roads:
            sync_buildings_to_assets(db_path)
            sync_roads_to_assets(db_path)


def ensure_grundkort_async() -> None:
    def _run() -> None:
        try:
            ensure_grundkort()
        except Exception as exc:
            log.error(f"[grundkort] startup ingest failed: {type(exc).__name__}: {exc}")

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


def repair_unsampled_ground(db) -> tuple[int, int]:
    """Re-sample estimated building grounds; return (fixed, still_pending)."""
    try:
        rows = db.execute(
            "SELECT building_id, cx, cy, ring FROM buildings WHERE ground_sampled = 0"
        ).fetchall()
    except sqlite3.OperationalError:
        return 0, 0  # schema not ensured yet
    if not rows:
        return 0, 0
    from ingest_buildings import GroundSampler

    sampler = GroundSampler(db)
    if not sampler.tiles:
        return 0, len(rows)
    fixed = 0
    for building_id, cx, cy, ring_json in rows:
        ground = sampler.sample(cx, cy)
        if ground is None:
            continue
        roof_min = min(z for _, _, z in json.loads(ring_json))
        db.execute(
            "UPDATE buildings SET ground_z = ?, ground_sampled = 1 "
            "WHERE building_id = ?",
            (round(min(ground, roof_min - 0.5), 2), building_id),
        )
        fixed += 1
    if fixed:
        db.commit()
        log.info(f"[grundkort] re-sampled ground for {fixed} buildings from heightmaps")
    return fixed, len(rows) - fixed


def _ensure_assets_schema(adb) -> None:
    adb.execute("PRAGMA journal_mode=WAL")
    adb.executescript(_ASSETS_SCHEMA)
    columns = {row[1] for row in adb.execute("PRAGMA table_info(assets)")}
    for column in ("cx", "cy", "min_x", "min_y", "max_x", "max_y"):
        if column not in columns:
            adb.execute(f"ALTER TABLE assets ADD COLUMN {column} REAL")
    adb.execute("CREATE INDEX IF NOT EXISTS idx_assets_cxy ON assets(cx, cy)")
    adb.execute(
        "CREATE INDEX IF NOT EXISTS idx_assets_bounds "
        "ON assets(type, min_x, max_x, min_y, max_y)"
    )
    adb.commit()


def sync_buildings_to_assets(
    db_path: Path = DB_PATH, assets_db_path: Path = ASSETS_DB_PATH
) -> int:
    """Upsert every terrain.db building into assets.db as type='building'.

    Keeps a manually-set ``enabled`` flag intact on update. Ring vertices
    stay absolute EPSG:3413; the asset server shifts them per request.
    """
    from coords import to_wgs84

    db = sqlite3.connect(str(db_path))
    try:
        rows = db.execute(
            "SELECT building_id, b_number, use_type, cx, cy, ground_z, ring "
            "FROM buildings"
        ).fetchall()
    except sqlite3.OperationalError:
        rows = []
    db.close()
    if not rows:
        return 0

    adb = sqlite3.connect(str(assets_db_path))
    _ensure_assets_schema(adb)
    for building_id, b_number, use_type, cx, cy, ground_z, ring_json in rows:
        ring = json.loads(ring_json)
        xs = [point[0] for point in ring]
        ys = [point[1] for point in ring]
        lat, lon = to_wgs84(cx, cy)
        properties = json.dumps({
            "b": b_number,
            "use": use_type,
            "groundZ": ground_z,
            "ring": ring,
        })
        adb.execute(
            "INSERT INTO assets "
            "(id, type, enabled, lat, lon, heading_deg, z, properties, cx, cy, "
            "min_x, min_y, max_x, max_y, updated_at) "
            "VALUES (?, 'building', 1, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) "
            "ON CONFLICT(id) DO UPDATE SET "
            "lat=excluded.lat, lon=excluded.lon, z=excluded.z, "
            "properties=excluded.properties, cx=excluded.cx, cy=excluded.cy, "
            "min_x=excluded.min_x, min_y=excluded.min_y, "
            "max_x=excluded.max_x, max_y=excluded.max_y, "
            "updated_at=CURRENT_TIMESTAMP",
            (
                building_id, float(lat), float(lon), ground_z, properties, cx, cy,
                min(xs), min(ys), max(xs), max(ys),
            ),
        )
    adb.commit()
    adb.close()
    log.info(f"[grundkort] synced {len(rows)} buildings into {assets_db_path.name}")
    return len(rows)


def sync_roads_to_assets(
    db_path: Path = DB_PATH, assets_db_path: Path = ASSETS_DB_PATH
) -> int:
    """Upsert terrain.db road/path centerlines into the shared asset catalog."""
    from coords import to_wgs84

    db = sqlite3.connect(str(db_path))
    try:
        rows = db.execute(
            "SELECT road_id, kind, category, name, width_m, cx, cy, path FROM roads"
        ).fetchall()
    except sqlite3.OperationalError:
        rows = []
    db.close()
    if not rows:
        return 0

    adb = sqlite3.connect(str(assets_db_path))
    _ensure_assets_schema(adb)
    for road_id, kind, category, name, width_m, cx, cy, path_json in rows:
        path = json.loads(path_json)
        xs = [point[0] for point in path]
        ys = [point[1] for point in path]
        lat, lon = to_wgs84(cx, cy)
        properties = json.dumps({
            "kind": kind,
            "category": category,
            "name": name,
            "widthM": width_m,
            "path": path,
        })
        adb.execute(
            "INSERT INTO assets "
            "(id,type,enabled,lat,lon,heading_deg,z,properties,cx,cy,"
            "min_x,min_y,max_x,max_y,updated_at) "
            "VALUES (?,'road',1,?,?,0,NULL,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) "
            "ON CONFLICT(id) DO UPDATE SET "
            "lat=excluded.lat,lon=excluded.lon,properties=excluded.properties,"
            "cx=excluded.cx,cy=excluded.cy,min_x=excluded.min_x,min_y=excluded.min_y,"
            "max_x=excluded.max_x,max_y=excluded.max_y,updated_at=CURRENT_TIMESTAMP",
            (
                road_id, float(lat), float(lon), properties, cx, cy,
                min(xs), min(ys), max(xs), max(ys),
            ),
        )
    adb.commit()
    adb.close()
    log.info(f"[grundkort] synced {len(rows)} roads into {assets_db_path.name}")
    return len(rows)


def _ground_retry_loop(db_path: Path) -> None:
    """Retry ground re-sampling until no building is left on an estimate."""
    while True:
        time.sleep(_GROUND_RETRY_S)
        db = sqlite3.connect(str(db_path))
        fixed, pending = repair_unsampled_ground(db)
        db.close()
        if fixed:
            sync_buildings_to_assets(db_path)
        if pending == 0:
            log.info("[grundkort] all building grounds sampled from heightmaps")
            return
