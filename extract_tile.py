#!/usr/bin/env python3
"""Extract texture, heightmap, and metadata for a single tile from terrain.db."""

import json
import sqlite3
import sys
import zlib
from pathlib import Path

import numpy as np
from PIL import Image

TILE_ID = "10-344-199"
DB_PATH = Path(__file__).parent / "flaskserver" / "terrain.db"
OUT_DIR = Path(__file__).parent / "sample"
GRID_N = 65  # heightmap grid size


def main():
    if len(sys.argv) > 1:
        tile_id = sys.argv[1]
    else:
        tile_id = TILE_ID

    out_dir = Path(__file__).parent / "sample" / tile_id
    out_dir.mkdir(parents=True, exist_ok=True)

    db = sqlite3.connect(str(DB_PATH))
    db.row_factory = sqlite3.Row

    # ── tile row (heightmap + metadata) ──
    tile = db.execute(
        "SELECT * FROM tiles WHERE tile_id = ?", (tile_id,)
    ).fetchone()
    if not tile:
        print(f"Tile {tile_id} not found in tiles table")
        sys.exit(1)

    # heightmap → 16-bit grayscale PNG
    hm_blob = tile["heightmap"]
    if hm_blob:
        hm = np.frombuffer(zlib.decompress(hm_blob), dtype=np.float32).reshape(
            (GRID_N, GRID_N)
        )
        hm_min, hm_max = float(hm.min()), float(hm.max())
        hm_range = hm_max - hm_min
        if hm_range < 1e-6:
            hm16 = np.zeros_like(hm, dtype=np.uint16)
        else:
            hm16 = ((hm - hm_min) / hm_range * 65535).round().astype(np.uint16)
        img = Image.new("I;16", (GRID_N, GRID_N))
        img.putdata(hm16.flatten().tolist())
        img.save(str(out_dir / "heightmap.png"))
        print(f"Heightmap: {GRID_N}x{GRID_N} 16-bit PNG, min={hm_min:.2f}m max={hm_max:.2f}m mean={hm.mean():.2f}m")
    else:
        hm = None
        hm_min = hm_max = hm_range = None
        print("Heightmap: not available")

    # confidence map
    cm_blob = tile["confidence_map"]
    if cm_blob:
        cm = np.frombuffer(zlib.decompress(cm_blob), dtype=np.uint8).reshape(
            (GRID_N, GRID_N)
        )
        Image.fromarray(cm, mode="L").save(str(out_dir / "confidence_map.png"))
        print(f"Confidence map: {GRID_N}x{GRID_N} 8-bit PNG, min={cm.min()} max={cm.max()}")

    # ── texture ──
    tex = db.execute(
        "SELECT texture, source, updated_at FROM textures WHERE tile_id = ?",
        (tile_id,),
    ).fetchone()
    if tex:
        jpeg_bytes = tex["texture"]
        with open(out_dir / "texture.jpg", "wb") as f:
            f.write(jpeg_bytes)
        print(f"Texture: {len(jpeg_bytes)} bytes, source={tex['source']}")
    else:
        print("Texture: not available")

    # ── water mask ──
    wm = db.execute(
        "SELECT mask_png, source, coverage FROM water_masks WHERE tile_id = ?",
        (tile_id,),
    ).fetchone()
    if wm:
        with open(out_dir / "water_mask.png", "wb") as f:
            f.write(wm["mask_png"])
        print(f"Water mask: source={wm['source']} coverage={wm['coverage']:.2%}")
    else:
        print("Water mask: not in DB")

    # ── metadata ──
    bbox = [tile["x_min"], tile["y_min"], tile["x_max"], tile["y_max"]]
    size_m = tile["x_max"] - tile["x_min"]
    resolution_m = size_m / (GRID_N - 1)

    meta = {
        "tile_id": tile_id,
        "depth": tile["depth"],
        "col": tile["col"],
        "row": tile["row"],
        "bbox_epsg3413": {
            "x_min": tile["x_min"],
            "y_min": tile["y_min"],
            "x_max": tile["x_max"],
            "y_max": tile["y_max"],
        },
        "tile_size_m": round(size_m, 2),
        "heightmap_grid": f"{GRID_N}x{GRID_N}",
        "heightmap_resolution_m": round(resolution_m, 2),
        "source": tile["source"],
        "geometric_error": tile["geometric_error"],
        "parent_id": tile["parent_id"],
        "updated_at": tile["updated_at"],
    }
    if hm is not None:
        meta["elevation"] = {
            "min_m": round(hm_min, 2),
            "max_m": round(hm_max, 2),
            "mean_m": round(float(hm.mean()), 2),
            "range_m": round(hm_range, 2),
        }
        meta["heightmap_encoding"] = {
            "format": "16-bit grayscale PNG",
            "decode": "elevation_m = (pixel / 65535) * range_m + min_m",
            "min_m": hm_min,
            "max_m": hm_max,
        }
    if tex:
        meta["texture"] = {
            "source": tex["source"],
            "size_bytes": len(jpeg_bytes),
            "updated_at": tex["updated_at"],
        }

    with open(out_dir / "metadata.json", "w") as f:
        json.dump(meta, f, indent=2)

    print(f"\nMetadata written to {out_dir / 'metadata.json'}")
    print(f"All files saved to {out_dir}/")

    db.close()


if __name__ == "__main__":
    main()
