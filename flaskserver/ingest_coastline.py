"""Download Åbent Land Grønland 1:50k vector blocks for shoreline masks.

Fetches GL50 GeoPackages from the Dataforsyningen Databoks FTPS into
``gtk50_blocks/``. Once a block is local, ``coastline.py`` builds sea
masks from its vectors instead of decoding the rendered WMS map — the
masks themselves are still created lazily per tile as terrain streams in.

Usage:
    ./venv/bin/python ingest_coastline.py 71_-1 71_-2
    ./venv/bin/python ingest_coastline.py --lat 64.18 --lon -51.72 --radius-km 60

Credentials come from .env (DATAFORSYNINGEN_FTP_USER / _PASS — the
account login, not the WMS token).
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

from colored_log import get_logger
from gtk50_vector import BLOCK_DIR, BLOCK_SIZE_M, block_name, block_path

log_ingest = get_logger("terrain.gtk50.ingest")

_FTP_BASE = "ftps://ftp.dataforsyningen.dk/DATABOKS_GROENLAND/Vektor_50000"


def _credentials() -> str:
    env = {}
    for line in (Path(__file__).parent / ".env").read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip()
    user = env.get("DATAFORSYNINGEN_FTP_USER")
    password = env.get("DATAFORSYNINGEN_FTP_PASS")
    if not user or not password:
        sys.exit("DATAFORSYNINGEN_FTP_USER / _PASS missing from .env")
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


def _refresh_cached_masks() -> None:
    """Rebuild any existing masks/classifier rows the new blocks cover.

    On a fresh DB this is a no-op; on a populated one it swaps WMS-derived
    masks for vector ones and drops classifier rows that baked in the old
    water, letting both rebuild on demand.
    """
    import sqlite3

    from coastline import cache_official_water_mask
    from gtk50_vector import blocks_for_bbox, block_path

    db = sqlite3.connect(str(Path(__file__).parent / "terrain.db"))
    rows = db.execute(
        "SELECT m.tile_id, t.x_min, t.y_min, t.x_max, t.y_max "
        "FROM coastline_masks m JOIN tiles t ON t.tile_id = m.tile_id"
    ).fetchall()
    todo = [
        (tile_id, (x0, y0, x1, y1))
        for tile_id, x0, y0, x1, y1 in rows
        if all(block_path(b).exists() for b in blocks_for_bbox((x0, y0, x1, y1)))
    ]
    if not todo:
        db.close()
        return
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
    db.close()


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
        target = block_path(block)
        url = f"{_FTP_BASE}/{target.name}"
        subprocess.run(
            ["curl", "-sS", "--max-time", "600", "--user", creds, url,
             "-o", str(target)],
            check=True,
        )
        done += available[block]
        elapsed = time.time() - start
        eta = elapsed / done * (total - done) if done else 0.0
        log_ingest.info(
            f"[gtk50-ingest] {block} ({available[block] / 1e6:.0f} MB) "
            f"{index}/{len(plan)} ({100 * done // max(total, 1)}%) eta {eta:.0f}s"
        )
        sys.stdout.flush()

    _refresh_cached_masks()
    local = sorted(p.name for p in BLOCK_DIR.glob("*.gpkg"))
    log_ingest.info(f"[gtk50-ingest] done — {len(local)} blocks local")


if __name__ == "__main__":
    main()
