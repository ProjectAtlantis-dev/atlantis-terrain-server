#!/usr/bin/env python3
"""Calibrate the ladder's shadow constants on mapped mountain lakes.

A mapped Åbent Land lake is a KNOWN-ALBEDO, KNOWN-FLAT surface: any
brightness variation across it is illumination, never ground cover. Lakes
half-darkened by a north wall therefore hand us labeled shadow pixels, and
their lit halves the lit-water baseline — ground truth for two things the
ladder currently hand-picks:

  1. SHADOW_MAX_LUMINANCE — where does "reads dark" actually sit for this
     imagery source, measured on surfaces whose albedo we know;
  2. the horizon-march sun model — does predicted shade actually co-locate
     with observed darkening (separation of the two populations).

Samples every d12 tile that has both a hydrography (inland water) mask and
real WMS imagery. Luminance is exposure-normalized exactly the way the
ladder normalizes it, so the recommended threshold drops straight into
classifier/ladder.py.

Usage:
    venv/bin/python shadow_calibration.py [--limit N]
Writes sample/shadow_calibration/summary.json (+ per-population stats).
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sqlite3
import sys
import time

import numpy as np
from PIL import Image

DB_PATH = os.path.join(os.path.dirname(__file__), "terrain.db")
OUT_DIR = os.path.join(os.path.dirname(__file__), "sample", "shadow_calibration")
SIZE = 256

# Predicted-sun cut points defining the two probe populations. Deliberately
# leaves a gap: pixels with ambiguous predictions belong to neither.
SUN_SHADOWED_MAX = 0.35   # matches the ladder's SUN_SHADOW_MAX
SUN_LIT_MIN = 0.70


def _tiles(db, limit=None):
    rows = db.execute(
        "SELECT h.tile_id FROM hydrography_masks h "
        "JOIN textures t ON t.tile_id = h.tile_id "
        "WHERE h.tile_id LIKE '12-%' AND t.source NOT LIKE '%procedural%' "
        "AND t.source NOT IN ('ancestor_crop', 'placeholder') "
        "ORDER BY h.tile_id"
    ).fetchall()
    ids = [r[0] for r in rows]
    return ids[:limit] if limit else ids


def collect_samples(db, tile_id):
    """(sun_pred, normalized_luminance) arrays over the tile's lake pixels."""
    from classifier import ladder
    from coastline import read_hydrography_mask
    from database import read_tile
    from terrain_upscale import _resize_bilinear

    tile = read_tile(db, tile_id)
    if tile is None or tile.get("heightmap") is None:
        return None
    hydro = read_hydrography_mask(db, tile_id)
    if hydro is None or not np.any(hydro):
        return None
    texture = db.execute(
        "SELECT texture FROM textures WHERE tile_id = ?", (tile_id,)
    ).fetchone()
    if texture is None or texture[0] is None:
        return None

    rgb = np.asarray(
        Image.open(io.BytesIO(texture[0])).convert("RGB").resize(
            (SIZE, SIZE), Image.Resampling.BILINEAR
        ),
        dtype=np.float32,
    )
    luminance = rgb @ np.asarray([0.2126, 0.7152, 0.0722], dtype=np.float32)
    tile_size = float(tile["bbox"][2]) - float(tile["bbox"][0])
    channels = ladder.physics_channels(tile["heightmap"], tile_size, SIZE)
    sun = channels["sun"]

    lake = _resize_bilinear(
        np.flipud(hydro.astype(np.float64)), SIZE, SIZE
    ) >= 0.5
    # Erode one step so shoreline mixed pixels don't pollute the albedo
    # assumption (a beach pixel inside the mask is not lake surface).
    from scipy import ndimage
    lake = ndimage.binary_erosion(lake, iterations=2)
    if np.count_nonzero(lake) < 64:
        return None

    # Exposure gain exactly as the ladder computes it (lit land median →
    # reference), so thresholds transfer verbatim.
    lit_land = (sun > ladder.SUN_SHADOW_MAX) & ~lake
    if not np.any(lit_land):
        return None
    gain = float(np.clip(
        ladder.REFERENCE_LIT_MEDIAN / max(float(np.median(luminance[lit_land])), 1.0),
        *ladder.EXPOSURE_GAIN_RANGE,
    ))
    return sun[lake], luminance[lake] * gain


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--db", default=DB_PATH)
    args = parser.parse_args()

    db = sqlite3.connect(args.db)
    tiles = _tiles(db, args.limit)
    print(f"{len(tiles)} lake tiles to sample", flush=True)

    shadowed, lit = [], []
    started = time.time()
    for index, tile_id in enumerate(tiles):
        try:
            result = collect_samples(db, tile_id)
        except Exception as exc:
            print(f"  {tile_id}: skipped ({type(exc).__name__}: {exc})",
                  flush=True)
            result = None
        if result is not None:
            sun, lum = result
            shadowed.append(lum[sun < SUN_SHADOWED_MAX])
            lit.append(lum[sun > SUN_LIT_MIN])
        done = index + 1
        if done % 50 == 0 or done == len(tiles):
            elapsed = time.time() - started
            eta = elapsed / done * (len(tiles) - done)
            print(
                f"[{done}/{len(tiles)} {100 * done // len(tiles)}%] "
                f"eta {eta:.0f}s", flush=True,
            )

    shadowed = np.concatenate(shadowed) if shadowed else np.empty(0)
    lit = np.concatenate(lit) if lit else np.empty(0)
    if shadowed.size < 1000 or lit.size < 1000:
        print("not enough samples to calibrate", flush=True)
        return 1

    def stats(arr):
        return {
            "n": int(arr.size),
            "p5": float(np.percentile(arr, 5)),
            "p25": float(np.percentile(arr, 25)),
            "median": float(np.median(arr)),
            "p75": float(np.percentile(arr, 75)),
            "p95": float(np.percentile(arr, 95)),
        }

    # Threshold candidate: equal-error point between the two populations —
    # the luminance where a pixel is as likely shadowed-lake as lit-lake.
    grid = np.linspace(0, 255, 512)
    shadow_cdf = np.searchsorted(np.sort(shadowed), grid) / shadowed.size
    lit_cdf = np.searchsorted(np.sort(lit), grid) / lit.size
    # P(shadow pixel above t) = 1 - shadow_cdf; P(lit pixel below t) = lit_cdf
    equal_error = float(grid[int(np.argmin(np.abs((1 - shadow_cdf) - lit_cdf)))])
    # Separation quality: AUC of luminance separating the two populations.
    both = np.concatenate([shadowed, lit])
    ranks = np.argsort(np.argsort(both))
    auc = 1.0 - (
        (ranks[: shadowed.size].sum() / shadowed.size - (shadowed.size - 1) / 2)
        / lit.size
    )

    summary = {
        "tiles_sampled": len(tiles),
        "shadowed_lake_luminance": stats(shadowed),
        "lit_lake_luminance": stats(lit),
        "equal_error_luminance": equal_error,
        "sun_model_auc": float(auc),
        "current_SHADOW_MAX_LUMINANCE": 85.0,
        "note": (
            "luminance is exposure-normalized exactly as classifier/"
            "ladder.py normalizes it; equal_error_luminance is the "
            "data-derived candidate for SHADOW_MAX_LUMINANCE"
        ),
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "summary.json"), "w") as handle:
        json.dump(summary, handle, indent=2)
    print(json.dumps(summary, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
