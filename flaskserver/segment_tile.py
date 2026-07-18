#!/usr/bin/env python3
"""Run geometry-aware segmentation for one cached terrain tile."""
from __future__ import annotations

import argparse
import io
import json
import sqlite3
import zlib
from pathlib import Path

import numpy as np
from PIL import Image

from classifier.segmentation import (
    SegmentationConfig,
    render_boundaries,
    segment_terrain_tile,
)
from classifier.official_water import classifier_water_mask
from database import GRID_N


def _load_cached_tile(db, tile_id):
    row = db.execute(
        "SELECT t.x_min, t.y_min, t.x_max, t.y_max, t.heightmap, x.texture "
        "FROM tiles t JOIN textures x USING (tile_id) WHERE t.tile_id = ?",
        (tile_id,),
    ).fetchone()
    if row is None or row[4] is None:
        raise ValueError(f"{tile_id} needs both a cached texture and heightmap")
    heightmap = np.frombuffer(
        zlib.decompress(row[4]), dtype=np.float32
    ).reshape((GRID_N, GRID_N)).copy()
    rgb = np.asarray(Image.open(io.BytesIO(row[5])).convert("RGB"))
    bbox = tuple(float(value) for value in row[:4])
    water_mask = classifier_water_mask(bbox, rgb.shape[1], rgb.shape[0])
    return rgb, heightmap, float(row[2] - row[0]), water_mask


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("tile_id", help="quadtree ID such as 12-1372-784")
    parser.add_argument("--db", default=str(Path(__file__).with_name("terrain.db")))
    parser.add_argument("--output", type=Path, default=Path("segmentation-output"))
    parser.add_argument("--segment-m", type=float, default=40.0)
    args = parser.parse_args()

    with sqlite3.connect(args.db) as db:
        rgb, heightmap, tile_size_m, water_mask = _load_cached_tile(
            db, args.tile_id
        )
    result = segment_terrain_tile(
        rgb,
        heightmap,
        tile_size_m,
        SegmentationConfig(target_segment_m=args.segment_m),
        water_mask=water_mask,
    )

    args.output.mkdir(parents=True, exist_ok=True)
    stem = args.output / args.tile_id
    Image.fromarray(rgb).save(stem.with_suffix(".original.jpg"), quality=92)
    np.save(stem.with_suffix(".labels.npy"), result.labels)
    Image.fromarray(render_boundaries(rgb, result.labels)).save(
        stem.with_suffix(".segments.png")
    )
    stem.with_suffix(".regions.json").write_text(
        json.dumps(result.regions, indent=2) + "\n"
    )
    print(
        f"{args.tile_id}: {len(result.regions)} regions; "
        f"wrote original, labels, segments, and region statistics to {args.output}"
    )


if __name__ == "__main__":
    main()
