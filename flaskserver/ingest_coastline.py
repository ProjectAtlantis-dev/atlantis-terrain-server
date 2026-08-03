"""Download Åbent Land Grønland 1:50k vector blocks for shoreline masks.

Fetches GL50 GeoPackages from the Dataforsyningen Databoks FTPS into
``gtk50_blocks/``. Once a block is local, ``coastline.py`` builds authoritative
sea masks from its vectors. Rendered-WMS lakes and watercourses remain in a
separate hydrography store. Masks are created lazily as terrain streams in.

Usage:
    ./venv/bin/python ingest_coastline.py 71_-1 71_-2
    ./venv/bin/python ingest_coastline.py --lat 64.18 --lon -51.72 --radius-km 60

Credentials come from .env (DATAFORSYNINGEN_FTP_USER / _PASS — the
account login, not the WMS token).
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

from colored_log import get_logger
from gtk50_vector import BLOCK_DIR, BLOCK_SIZE_M, block_name, block_path

log_ingest = get_logger("terrain.gtk50.ingest")

_FTP_BASE = "ftps://ftp.dataforsyningen.dk/DATABOKS_GROENLAND/Vektor_50000"


def _credentials(strict: bool = True) -> str | None:
    env = {}
    env_path = Path(__file__).parent / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                key, _, value = line.partition("=")
                env[key.strip()] = value.strip()
    user = env.get("DATAFORSYNINGEN_FTP_USER")
    password = env.get("DATAFORSYNINGEN_FTP_PASS")
    if not user or not password:
        if strict:
            sys.exit("DATAFORSYNINGEN_FTP_USER / _PASS missing from .env")
        return None
    return f"{user}:{password}"


def _remote_listing(creds: str) -> dict[str, int]:
    """Map block id -> byte size for every block the FTP offers."""
    out = subprocess.run(
        ["curl", "-s", "--max-time", "90", "--user", creds, f"{_FTP_BASE}/"],
        capture_output=True, text=True, check=True,
    ).stdout
    sizes: dict[str, int] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 9 or not parts[-1].endswith(".gpkg"):
            continue
        block = parts[-1].removeprefix("GL50_Vektordata_100km_").removesuffix(".gpkg")
        sizes[block] = int(parts[4])
    return sizes


def _blocks_around(lat: float, lon: float, radius_km: float) -> list[str]:
    from pyproj import Transformer

    to_utm = Transformer.from_crs(4326, 3184, always_xy=True)
    x, y = to_utm.transform(lon, lat)
    r = radius_km * 1000.0
    e_lo, e_hi = int((x - r) // BLOCK_SIZE_M), int((x + r) // BLOCK_SIZE_M)
    n_lo, n_hi = int((y - r) // BLOCK_SIZE_M), int((y + r) // BLOCK_SIZE_M)
    return [
        block_name(n, e)
        for n in range(n_lo, n_hi + 1)
        for e in range(e_lo, e_hi + 1)
    ]


def _refresh_cached_masks(blocks=None, *, fallback_only: bool = False) -> dict[str, int]:
    """Rebuild existing masks/classifier rows the given blocks cover.

    ``blocks`` scopes the work to tiles those block ids actually touch. Pass it
    whenever a specific block has just arrived: a full sweep re-derives every
    mask in the database, which is minutes of work to fix a handful of tiles,
    and on-demand downloads make that a per-block cost. ``None`` keeps the
    whole-table behaviour for the CLI, where a full re-derive is the point.

    On a fresh DB this is a no-op; on a populated one it swaps WMS-derived
    masks for vector ones and drops classifier rows that baked in the old
    water, letting both rebuild on demand.

    Returns a summary so callers can verify the rebuild actually produced
    vector masks. A block can download successfully and still leave tiles on
    the WMS fallback — if it does, that must be reported rather than assumed
    away, because the symptom on screen is an ordinary-looking fjord that is
    quietly wrong.
    """
    import sqlite3

    from coastline import cache_official_water_mask
    from gtk50_vector import (
        VECTOR_SOURCE,
        blocks_for_bbox,
        block_path,
        clear_block_cache,
    )

    # Every caller reaches the rebuild through here, so this is the one place
    # that has to guarantee freshly downloaded blocks are actually seen.
    clear_block_cache()

    db = sqlite3.connect(
        str(Path(__file__).parent / "terrain.db"), timeout=30.0,
    )
    db.execute("PRAGMA busy_timeout=30000")
    if fallback_only:
        # Restart recovery for the small crash window between the atomic block
        # rename and completion of its mask rebuild. Restrict this to tiles
        # that still lack vector authority so ordinary startup is a cheap
        # no-op rather than a full re-rasterisation of every local block.
        rows = db.execute(
            "SELECT h.tile_id, t.x_min, t.y_min, t.x_max, t.y_max "
            "FROM hydrography_masks h JOIN tiles t ON t.tile_id = h.tile_id "
            "LEFT JOIN coastline_masks c ON c.tile_id = h.tile_id "
            "AND c.source = ? WHERE c.tile_id IS NULL",
            (VECTOR_SOURCE,),
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT m.tile_id, t.x_min, t.y_min, t.x_max, t.y_max "
            "FROM (SELECT tile_id FROM coastline_masks UNION "
            "SELECT tile_id FROM hydrography_masks) m "
            "JOIN tiles t ON t.tile_id = m.tile_id"
        ).fetchall()
    wanted = set(blocks) if blocks is not None else None
    todo = []
    for tile_id, x0, y0, x1, y1 in rows:
        tile_blocks = blocks_for_bbox((x0, y0, x1, y1))
        if not all(block_path(b).exists() for b in tile_blocks):
            continue
        if wanted is not None and not wanted.intersection(tile_blocks):
            continue
        todo.append((tile_id, (x0, y0, x1, y1)))
    if not todo:
        db.close()
        return {"rebuilt": 0, "vector": 0, "fallback": 0}
    start = time.time()
    for index, (tile_id, bbox) in enumerate(todo, 1):
        cache_official_water_mask(db, tile_id, bbox)
        db.execute("DELETE FROM classifier_tiles WHERE tile_id = ?", (tile_id,))
        if index % 25 == 0 or index == len(todo):
            elapsed = time.time() - start
            eta = elapsed / index * (len(todo) - index)
            log_ingest.info(
                f"[gtk50-ingest] masks {index}/{len(todo)} "
                f"({100 * index // len(todo)}%) eta {eta:.0f}s"
            )
            sys.stdout.flush()
    db.commit()

    # Verify rather than assume: count how many of the tiles we just rebuilt
    # actually carry a vector-sourced mask now.
    placeholders = ",".join("?" for _ in todo)
    tile_ids = [tile_id for tile_id, _ in todo]
    vector = db.execute(
        f"SELECT COUNT(*) FROM coastline_masks "
        f"WHERE source = ? AND tile_id IN ({placeholders})",
        (VECTOR_SOURCE, *tile_ids),
    ).fetchone()[0]
    db.close()
    return {
        "rebuilt": len(todo),
        "vector": vector,
        "fallback": len(todo) - vector,
    }


def _local_block_ids() -> list[str]:
    prefix = "GL50_Vektordata_100km_"
    return sorted(
        path.stem.removeprefix(prefix)
        for path in BLOCK_DIR.glob(f"{prefix}*.gpkg")
    )


_block_download_locks: dict[str, threading.Lock] = {}
_block_download_locks_guard = threading.Lock()


def _block_download_lock(block: str) -> threading.Lock:
    with _block_download_locks_guard:
        return _block_download_locks.setdefault(block, threading.Lock())


def _download_block(block: str, creds: str) -> None:
    """Fetch one block, atomically and safely under concurrency.

    Downloading onto the final path is unsafe: an interrupted transfer leaves a
    truncated .gpkg there, and every later check treats the block as present
    because the file exists. ``_load_block`` swallows a missing table per
    ``sqlite3.OperationalError``, so a corrupt block silently rasterises as
    all-land and never retries.

    Staging alone is not enough either. The startup seed downloader and the
    on-demand scheduler run concurrently in the same process, so both can want
    the same block at once; a fixed ``.part`` name means two curl processes
    writing one file and racing the rename, producing exactly the truncated
    artifact staging was meant to prevent. The staging name is therefore unique
    per attempt, and a per-block lock keeps the two paths from duplicating the
    transfer at all.
    """
    lock = _block_download_lock(block)
    with lock:
        target = block_path(block)
        # Another waiter may have completed the download while this one blocked.
        if target.exists():
            log_ingest.info(
                f"[gtk50-ingest] {block}: already fetched by a concurrent "
                "download, skipping"
            )
            return
        staging = target.with_suffix(
            f"{target.suffix}.{os.getpid()}.{uuid.uuid4().hex[:8]}.part"
        )
        url = f"{_FTP_BASE}/{target.name}"
        try:
            subprocess.run(
                ["curl", "-sS", "--fail", "--max-time", "600", "--user", creds,
                 url, "-o", str(staging)],
                check=True,
            )
            # os.replace is atomic within a filesystem, so a reader either sees
            # the old absence or the complete file, never a partial one.
            staging.replace(target)
        finally:
            staging.unlink(missing_ok=True)


def ensure_gtk50_blocks() -> None:
    """Startup guard: fetch configured coastline blocks or scream.

    Called from a server startup thread. If blocks are missing and no
    Dataforsyningen login is configured, this logs a loud error so nobody
    silently ships WMS-decoded fjords.
    """
    from terrain_config import GTK50_BLOCKS

    # Repair any WMS-only rows covered by blocks that survived a prior process.
    # This makes refresh debt durable without a second state database: after a
    # crash or restart, the block on disk plus the fallback row are sufficient
    # evidence that the rebuild is still owed.
    local_blocks = _local_block_ids()
    if local_blocks:
        _refresh_cached_masks(local_blocks, fallback_only=True)

    missing = [b for b in GTK50_BLOCKS if not block_path(b).exists()]
    if not missing:
        return
    creds = _credentials(strict=False)
    if creds is None:
        log_ingest.error(
            "\n" + "=" * 72 + "\n"
            f"GTK50 VECTOR COASTLINE BLOCKS MISSING: {', '.join(missing)}\n"
            "No Dataforsyningen account login found (DATAFORSYNINGEN_FTP_USER /\n"
            "DATAFORSYNINGEN_FTP_PASS in flaskserver/.env), so they cannot be\n"
            "downloaded. Rendered WMS hydrography will still be retained, but it\n"
            "is not trusted as sea because it includes lakes and watercourses.\n"
            "Fix: create a free account at https://dataforsyningen.dk, put the\n"
            "login in flaskserver/.env, and restart. Or run manually:\n"
            f"  ./venv/bin/python ingest_coastline.py {' '.join(missing)}\n"
            + "=" * 72
        )
        return
    try:
        available = _remote_listing(creds)
        BLOCK_DIR.mkdir(exist_ok=True)
        downloaded: list[str] = []
        for block in missing:
            if block not in available:
                log_ingest.warning(
                    f"[gtk50-ingest] {block}: not offered by FTP (ice/ocean), skipping"
                )
                continue
            _download_block(block, creds)
            downloaded.append(block)
            log_ingest.info(
                f"[gtk50-ingest] startup download {block} "
                f"({available[block] / 1e6:.0f} MB)"
            )
    except Exception as exc:
        log_ingest.error(
            f"[gtk50-ingest] startup block download failed "
            f"({type(exc).__name__}: {exc}) — coastline falls back to WMS "
            "until the next restart"
        )
        return
    if downloaded:
        _refresh_cached_masks(downloaded)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("blocks", nargs="*", help="block ids, e.g. 71_-1")
    parser.add_argument("--lat", type=float)
    parser.add_argument("--lon", type=float)
    parser.add_argument("--radius-km", type=float, default=60.0)
    args = parser.parse_args()

    wanted = list(args.blocks)
    if args.lat is not None and args.lon is not None:
        wanted += _blocks_around(args.lat, args.lon, args.radius_km)
    if not wanted:
        parser.error("give block ids or --lat/--lon")

    creds = _credentials()
    if creds is None:
        raise RuntimeError("FTP credentials are required")
    available = _remote_listing(creds)
    BLOCK_DIR.mkdir(exist_ok=True)

    plan = []
    for block in dict.fromkeys(wanted):
        if block_path(block).exists():
            log_ingest.info(f"[gtk50-ingest] {block}: already local, skipping")
        elif block not in available:
            log_ingest.info(
                f"[gtk50-ingest] {block}: not offered by FTP (ice/ocean), skipping"
            )
        else:
            plan.append(block)

    total = sum(available[b] for b in plan)
    done = 0
    start = time.time()
    for index, block in enumerate(plan, 1):
        _download_block(block, creds)
        done += available[block]
        elapsed = time.time() - start
        eta = elapsed / done * (total - done) if done else 0.0
        log_ingest.info(
            f"[gtk50-ingest] {block} ({available[block] / 1e6:.0f} MB) "
            f"{index}/{len(plan)} ({100 * done // max(total, 1)}%) eta {eta:.0f}s"
        )
        sys.stdout.flush()

    _refresh_cached_masks(plan or None)
    local = sorted(p.name for p in BLOCK_DIR.glob("*.gpkg"))
    log_ingest.info(f"[gtk50-ingest] done — {len(local)} blocks local")


if __name__ == "__main__":
    main()
