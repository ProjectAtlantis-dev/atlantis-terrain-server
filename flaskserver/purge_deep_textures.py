#!/usr/bin/env python3
"""One-off script: purge non-enhanced textures deeper than ENHANCE_DEPTH.

These legacy textures predate the enhancement pipeline and conflict with it.
Heightmaps are preserved — only texture blobs are removed.

Usage:
    python purge_deep_textures.py [--dry-run]
"""

import argparse
import sqlite3
from pathlib import Path

from terrain_config import ENHANCE_DEPTH

DB_PATH = Path(__file__).parent / "terrain.db"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Show what would be deleted without deleting")
    parser.add_argument("--db", type=str, default=str(DB_PATH), help="Path to terrain.db")
    args = parser.parse_args()

    db = sqlite3.connect(args.db)

    # Count what we'd purge
    rows = db.execute(
        "SELECT t.tile_id, ti.depth, t.source, length(t.texture) as size_bytes "
        "FROM textures t "
        "JOIN tiles ti ON ti.tile_id = t.tile_id "
        f"WHERE ti.depth > {ENHANCE_DEPTH} "
        "AND t.source NOT IN ('dataforsyningen_enhanced', 'sentinel2_enhanced', 'upscaled')"
    ).fetchall()

    if not rows:
        print(f"Nothing to purge — no depth>{ENHANCE_DEPTH} non-enhanced textures found.")
        db.close()
        return

    # Summary by depth and source
    by_depth = {}
    by_source = {}
    total_bytes = 0
    for tile_id, depth, source, size in rows:
        by_depth[depth] = by_depth.get(depth, 0) + 1
        by_source[source] = by_source.get(source, 0) + 1
        total_bytes += size or 0

    print(f"Found {len(rows)} depth>{ENHANCE_DEPTH} non-enhanced textures ({total_bytes / 1024:.0f} KB)")
    print(f"  by depth:  {dict(sorted(by_depth.items()))}")
    print(f"  by source: {dict(sorted(by_source.items()))}")

    if args.dry_run:
        print("\n--dry-run: no changes made.")
        db.close()
        return

    cur = db.execute(
        "DELETE FROM textures WHERE tile_id IN ("
        "  SELECT t.tile_id FROM textures t "
        "  JOIN tiles ti ON ti.tile_id = t.tile_id "
        f"  WHERE ti.depth > {ENHANCE_DEPTH} "
        "  AND t.source NOT IN ('sentinel2_enhanced', 'upscaled')"
        ")"
    )
    db.commit()
    print(f"\nDeleted {cur.rowcount} textures.")

    # Vacuum to reclaim space
    print("Vacuuming database...")
    db.execute("VACUUM")
    db.close()
    print("Done.")


if __name__ == "__main__":
    main()
