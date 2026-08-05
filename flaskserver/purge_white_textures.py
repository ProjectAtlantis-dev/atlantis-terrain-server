"""One-time purge of white-fill textures cached before the WMS reject filter.

Dataforsyningen answers no-coverage requests (open ocean, e.g. west of Nuuk)
with a uniform white frame. Before fetch_dataforsyningen_texture() grew its
white-fill reject, those frames were cached as real imagery — and then cropped
into descendants as ancestor_crop / ancestor_crop_nodata, poisoning whole
subtrees with permanent white tiles.

Deleting them is self-healing: the tiles refetch on demand, and no-coverage
now resolves to ocean_nodata (flat deep-water blue) for all-ocean tiles.

Frames that mix real land imagery with white sea fill (the coastal coverage
boundary) are kept but REPAIRED in place: white pixels that the tile heightmap
says are ocean get filled with OCEAN_RGB — same per-pixel repair new fetches
get in serve_flask.

Usage:
    venv/bin/python purge_white_textures.py [--dry-run] [--db terrain.db]
"""

import argparse
import io
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

from database import GRID_N
from texture import is_white_fill, repair_white_ocean

# ancestor_crop* rows are placeholders by definition, so they can be judged
# more aggressively: mostly-white crops (a crop straddling a white parent's
# no-data edge) are garbage too. Real sources keep the strict uniform check
# so genuine snow/ice imagery is never touched.
CROP_SOURCES = {"ancestor_crop", "ancestor_crop_nodata", "ancestor_crop_ratelimit"}
CROP_WHITE_MIN_PCT = 90.0


def is_doomed(source: str, arr: np.ndarray) -> bool:
    if is_white_fill(arr):
        return True
    if source in CROP_SOURCES:
        white_pct = float((arr.min(axis=2) >= 245).mean() * 100.0)
        return white_pct > CROP_WHITE_MIN_PCT
    return False


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Purge/repair white-fill textures cached before the WMS reject filter."
    )
    ap.add_argument("--dry-run", action="store_true", help="report only, delete nothing")
    ap.add_argument("--db", default=str(Path(__file__).parent / "terrain.db"))
    args = ap.parse_args()

    db = sqlite3.connect(args.db)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=10000")

    rows = db.execute("SELECT tile_id, source FROM textures").fetchall()
    total = len(rows)
    print(f"Scanning {total} textures in {args.db} ...", flush=True)

    import zlib

    doomed: list[str] = []
    by_source: dict[str, int] = {}
    undecodable = 0
    repaired: list[tuple[bytes, str]] = []  # (new_jpeg, tile_id)
    no_heightmap = 0
    t0 = time.time()

    for i, (tile_id, source) in enumerate(rows):
        if i and i % 2000 == 0:
            elapsed = time.time() - t0
            eta = elapsed / i * (total - i)
            print(f"  {i / total * 100:5.1f}%  ({i}/{total})  eta {eta:4.0f}s", flush=True)
        blob = db.execute(
            "SELECT texture FROM textures WHERE tile_id = ?", (tile_id,)
        ).fetchone()[0]
        try:
            arr = np.array(Image.open(io.BytesIO(blob)).convert("RGB"))
        except (OSError, TypeError, ValueError):
            undecodable += 1
            doomed.append(tile_id)
            by_source[source] = by_source.get(source, 0) + 1
            continue
        if is_doomed(source, arr):
            doomed.append(tile_id)
            by_source[source] = by_source.get(source, 0) + 1
            continue
        # Partial white: repair sea-fill pixels in place using the heightmap.
        if (arr.min(axis=2) >= 250).mean() > 0.01:
            hm_row = db.execute(
                "SELECT heightmap FROM tiles WHERE tile_id = ?", (tile_id,)
            ).fetchone()
            if not hm_row or hm_row[0] is None:
                no_heightmap += 1
                continue
            hm = np.frombuffer(
                zlib.decompress(hm_row[0]), dtype=np.float32
            ).reshape(GRID_N, GRID_N)
            new_jpeg = repair_white_ocean(blob, hm)
            if new_jpeg is not None:
                repaired.append((new_jpeg, tile_id))

    print(f"\nWhite-fill / undecodable textures to delete: {len(doomed)} of {total}"
          f" ({undecodable} undecodable)")
    for source, n in sorted(by_source.items(), key=lambda kv: -kv[1]):
        print(f"  {source}: {n}")
    print(f"Partial-white textures to repair (white sea fill → OCEAN_RGB): {len(repaired)}")
    print(f"Partial-white skipped (no heightmap to mask with): {no_heightmap}")

    if not doomed and not repaired:
        print("Nothing to do.")
        return
    if args.dry_run:
        print("\n--dry-run: nothing changed.")
        return

    if doomed:
        params = [(t,) for t in doomed]
        db.executemany("DELETE FROM textures WHERE tile_id = ?", params)
    if repaired:
        db.executemany("UPDATE textures SET texture = ? WHERE tile_id = ?", repaired)
    db.commit()
    print(f"\nDeleted {len(doomed)} textures, repaired {len(repaired)} in place.")
    print("Restart the Flask server (in-memory caches) and hard-reload the browser.")


if __name__ == "__main__":
    sys.exit(main())
