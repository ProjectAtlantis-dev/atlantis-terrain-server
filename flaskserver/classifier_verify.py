#!/usr/bin/env python3
"""Verify the d12 classification ladder against data we already have.

For every verified tile this runs the full ladder with per-rung debug
dumps, stores the fresh coarse_v4 row (so the running client serves the
same labels the gallery shows), and measures the labels against every
independent reference available:

  - official water (Åbent Land / coastline masks) — the settled authority;
  - Asiaq buildings and roads — built footprints must not read GREEN, and
    must never fall in WATER (georegistration sanity);
  - Google satellite (debug reference only) — water-body agreement and
    "green painted on Google's bright bare rock". Google is late spring,
    so it is NOT the vegetation authority; its checks are structural.
    Flat dark ground Google confirms as water but the official mask lacks
    is reported as a LAKE DROPOUT candidate — an ingest gap, not a
    classifier error.

Gallery: sample/classifier_verify/index.html (regenerable, gitignored).

Usage:
    venv/bin/python classifier_verify.py 12-1373-784 [more tiles...]
    venv/bin/python classifier_verify.py --all            # every real d12
    venv/bin/python classifier_verify.py --all --reset    # purge stale rows
    venv/bin/python classifier_verify.py --no-google ...
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time

import numpy as np
from PIL import Image, ImageDraw

DB_PATH = os.path.join(os.path.dirname(__file__), "terrain.db")
OUT_DIR = os.path.join(
    os.path.dirname(__file__), "sample", "classifier_verify"
)
SIZE = 256
# Classifier rows the ladder supersedes: the old per-tile-percentile live
# classifier and the per-depth cook rows that defeated the ancestor walk.
STALE_SOURCES = ("coarse_d12_live_v1", "procedural_cook_v1")


def _real_texture(db, tile_id):
    row = db.execute(
        "SELECT texture, source FROM textures WHERE tile_id = ?", (tile_id,)
    ).fetchone()
    if row is None or row[0] is None:
        return None
    if "procedural" in (row[1] or "") or row[1] in (
        "ancestor_crop", "placeholder"
    ):
        return None
    return row[0]


def asiaq_built_mask(db, bbox, size):
    """Buildings + roads rasterized into the tile frame, image-oriented."""
    x0, y0, x1, y1 = (float(v) for v in bbox)
    pad = 50.0
    image = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(image)

    def to_px(x, y):
        return (
            (x - x0) / (x1 - x0) * (size - 1),
            (y1 - y) / (y1 - y0) * (size - 1),
        )

    count = 0
    for (ring_json,) in db.execute(
        "SELECT ring FROM buildings WHERE cx BETWEEN ? AND ? "
        "AND cy BETWEEN ? AND ?",
        (x0 - pad, x1 + pad, y0 - pad, y1 + pad),
    ):
        ring = json.loads(ring_json)
        draw.polygon([to_px(px, py) for px, py, *_ in ring], fill=255)
        count += 1
    meters_per_px = (x1 - x0) / size
    for path_json, width_m in db.execute(
        "SELECT path, width_m FROM roads WHERE cx BETWEEN ? AND ? "
        "AND cy BETWEEN ? AND ?",
        (x0 - pad, x1 + pad, y0 - pad, y1 + pad),
    ):
        path = json.loads(path_json)
        width_px = max(1, round(float(width_m or 4.0) / meters_per_px))
        draw.line(
            [to_px(px, py) for px, py, *_ in path],
            fill=255, width=width_px,
        )
        count += 1
    return np.asarray(image) > 127, count


def _google_water_read(google, slope=None):
    """Google pixels that read as water: dark with a blue lean.

    slope (our DEM, image-oriented) guards the reading: water cannot sit
    on sloped ground, and without the guard Google's shadowed crag
    crevices read as water on inland tiles — the classifier then scored
    IoU 0 against pure reference hallucination.
    """
    g = google.astype(np.float32)
    lum = g[..., 0] * 0.2126 + g[..., 1] * 0.7152 + g[..., 2] * 0.0722
    water = (g[..., 2] > g[..., 0] + 8) & (lum < 95)
    if slope is not None:
        water &= slope < 0.08
    return water


# Google's georegistration is shifted slightly SOUTH of ours (user-observed:
# their lakes land on mountainsides against our DEM), and their coloring is
# processed. So: structure-only comparisons, after estimating a per-tile
# rigid shift. ±12 px at 256 px / ~660 m ≈ ±31 m of search.
_MAX_SHIFT_PX = 12


def _best_shift(reference, moving, max_shift=_MAX_SHIFT_PX):
    """(dy, dx) to np.roll `moving` by so it best matches `reference`."""
    a = reference.astype(np.float32) - float(reference.mean())
    b = moving.astype(np.float32) - float(moving.mean())
    if not np.any(a) or not np.any(b):
        return 0, 0
    corr = np.fft.irfft2(
        np.fft.rfft2(a) * np.conj(np.fft.rfft2(b)), s=a.shape
    )
    window = np.full_like(corr, -np.inf)
    idx = np.arange(-max_shift, max_shift + 1)
    window[np.ix_(idx, idx)] = corr[np.ix_(idx, idx)]
    dy, dx = np.unravel_index(int(np.argmax(window)), corr.shape)
    if dy > corr.shape[0] // 2:
        dy -= corr.shape[0]
    if dx > corr.shape[1] // 2:
        dx -= corr.shape[1]
    return int(dy), int(dx)


def _gradient_magnitude(rgb):
    lum = rgb.astype(np.float32) @ np.asarray([0.2126, 0.7152, 0.0722])
    gy, gx = np.gradient(lum)
    return np.hypot(gx, gy)


def _register_google(google, our_water, spot_rgb, slope):
    """Shift-correct Google into our frame. Returns (google, (dy, dx)).

    Water shoreline is the strongest anchor when the tile has enough of
    it; otherwise correlate luminance edges against our SPOT texture
    (structure survives their color processing, palette does not).
    """
    if our_water is not None and 0.05 < float(our_water.mean()) < 0.95:
        shift = _best_shift(
            our_water.astype(np.float32),
            _google_water_read(google, slope).astype(np.float32),
        )
    else:
        shift = _best_shift(
            _gradient_magnitude(spot_rgb), _gradient_magnitude(google)
        )
    return np.roll(google, shift, axis=(0, 1)), shift


def _google_bright_rock(google):
    """Google pixels that read as bright bare rock: bright, hue-neutral."""
    g = google.astype(np.float32)
    lum = g[..., 0] * 0.2126 + g[..., 1] * 0.7152 + g[..., 2] * 0.0722
    excess = g[..., 1] - 0.5 * (g[..., 0] + g[..., 2])
    return (lum > 140) & (np.abs(excess) < 6)


def verify_tile(db, tile_id, out_dir, use_google=True):
    """Classify one tile, persist the row, measure, and dump panels.

    Returns the metrics dict, or None when the tile has no real texture or
    no heightmap yet.
    """
    from classifier.ladder import (
        GREEN, LAKE, WATER, LADDER_SOURCE, classify_ladder, macro_grain,
    )
    from classifier.hierarchy import d12_lake_prior
    from classifier.storage import COARSE_V4_SCHEMA, write_classifier_tile
    from coastline import read_water_mask
    from database import read_tile

    texture = _real_texture(db, tile_id)
    if texture is None:
        return None
    tile = read_tile(db, tile_id)
    if tile is None or tile.get("heightmap") is None:
        return None

    import io
    rgb = np.asarray(Image.open(io.BytesIO(texture)).convert("RGB"))
    try:
        water_mask = read_water_mask(db, tile_id)
        if water_mask is not None and water_mask.shape != tile["heightmap"].shape:
            water_mask = None
    except Exception:
        water_mask = None

    grain = None
    depth, col, row = (int(v) for v in tile_id.split("-"))
    shift = depth - 8
    if shift > 0:
        ancestor = read_tile(db, f"8-{col >> shift}-{row >> shift}")
        if ancestor is not None and ancestor.get("heightmap") is not None:
            grain = macro_grain(
                ancestor["heightmap"],
                float(ancestor["bbox"][2]) - float(ancestor["bbox"][0]),
            )
    lake_prior = d12_lake_prior(db, tile_id)
    if lake_prior is None:
        return None

    tile_dir = os.path.join(out_dir, tile_id)
    labels, stats = classify_ladder(
        rgb, tile["heightmap"], list(tile["bbox"]),
        water_mask=water_mask, grain=grain, lake_prior=lake_prior,
        output_size=SIZE, debug_dir=tile_dir,
    )
    write_classifier_tile(
        db, tile_id, labels,
        class_schema=COARSE_V4_SCHEMA, source=LADDER_SOURCE,
    )

    metrics = {"tile": tile_id, "stats": stats}

    built, feature_count = asiaq_built_mask(db, tile["bbox"], SIZE)
    metrics["asiaq_features"] = feature_count
    if np.any(built):
        built_n = int(np.count_nonzero(built))
        metrics["built_on_green_pct"] = 100.0 * float(
            np.count_nonzero(built & (labels == GREEN))
        ) / built_n
        metrics["built_on_water_pct"] = 100.0 * float(
            np.count_nonzero(built & (labels == WATER))
        ) / built_n
        overlay = np.asarray(
            Image.open(os.path.join(tile_dir, "step_12_final.png"))
        ).copy()
        overlay[built] = (255, 255, 0)
        Image.fromarray(overlay, "RGB").save(
            os.path.join(tile_dir, "asiaq_overlay.png")
        )

    if use_google:
        from classifier.ladder import physics_channels
        from google_ref import google_reference

        google = google_reference(tile["bbox"], size=SIZE)
        if google is not None:
            slope = physics_channels(
                tile["heightmap"],
                float(tile["bbox"][2]) - float(tile["bbox"][0]),
                SIZE,
            )["slope"]
            spot = np.asarray(
                Image.fromarray(rgb, "RGB").resize(
                    (SIZE, SIZE), Image.Resampling.BILINEAR
                )
            )
            google, shift = _register_google(
                google, (labels == WATER) | (labels == LAKE), spot, slope,
            )
            metrics["google_shift_px"] = list(shift)
            Image.fromarray(google, "RGB").save(
                os.path.join(tile_dir, "google.png")
            )
            g_water = _google_water_read(google, slope)
            # WATER (authority) ∪ LAKE (DEM flat-sheet catch): both claim
            # "this is not land", and Google is the water authority we
            # verify that claim against.
            our_water = (labels == WATER) | (labels == LAKE)
            union = np.count_nonzero(g_water | our_water)
            # A near-empty union (dry tile, a few speckles) makes IoU pure
            # noise — report only when either side claims real water.
            if union >= 0.005 * labels.size:
                metrics["water_iou_vs_google"] = float(
                    np.count_nonzero(g_water & our_water)
                ) / union
            green = labels == GREEN
            # Only report with a real green population: on near-greenless
            # tiles (ocean + islets) a handful of edge pixels made the
            # percentage scream 70% while meaning nothing.
            if np.count_nonzero(green) >= 0.02 * green.size:
                metrics["green_on_google_bright_rock_pct"] = 100.0 * float(
                    np.count_nonzero(green & _google_bright_rock(google))
                ) / int(np.count_nonzero(green))
            # Lake dropouts CAUGHT: Google water, missing from the
            # official mask, recovered by the DEM sheet detector. MISSED:
            # Google water we still call land — the number that has to
            # stay near zero.
            official = labels == WATER
            metrics["lake_dropout_caught_pct"] = 100.0 * float(
                np.count_nonzero(g_water & ~official & (labels == LAKE))
            ) / labels.size
            metrics["google_water_missed_pct"] = 100.0 * float(
                np.count_nonzero(g_water & ~our_water)
            ) / labels.size
        else:
            metrics["google"] = "unavailable"

    with open(os.path.join(tile_dir, "metrics.json"), "w") as handle:
        json.dump(metrics, handle, indent=2)
    return metrics


_PANELS = (
    ("step_01_texture.png", "SPOT texture"),
    ("google.png", "Google ref"),
    ("step_12_final.png", "ladder labels"),
    ("asiaq_overlay.png", "asiaq (yellow)"),
    ("step_05_sun.png", "sun"),
    ("step_07_veg_prior.png", "veg prior"),
    ("step_08_ridge_crests.png", "ridges"),
)


def _metric_line(metrics):
    stats = metrics["stats"]
    parts = [
        " ".join(
            f"{name} {value:.0%}"
            for name, value in stats["fractions"].items() if value >= 0.005
        ),
    ]
    grain = stats.get("grain")
    if grain and grain.get("strike_deg") is not None:
        parts.append(
            f"grain {grain['strike_deg']:.0f}° "
            f"(aniso {grain['anisotropy']:.2f})"
        )
    for key, label in (
        ("water_iou_vs_google", "water IoU(G)"),
        ("green_on_google_bright_rock_pct", "green-on-rock(G) %"),
        ("lake_dropout_caught_pct", "lake caught %"),
        ("google_water_missed_pct", "water missed %"),
        ("built_on_green_pct", "built-on-green %"),
        ("built_on_water_pct", "built-on-water %"),
    ):
        if key in metrics:
            parts.append(f"{label} {metrics[key]:.2f}")
    if stats.get("ridge_grain_alignment_deg") is not None:
        parts.append(
            f"ridge∥grain Δ{stats['ridge_grain_alignment_deg']:.0f}°"
        )
    if metrics.get("google_shift_px"):
        dy, dx = metrics["google_shift_px"]
        if dy or dx:
            parts.append(f"G shifted ({dy},{dx})px")
    return " · ".join(parts)


def build_gallery(out_dir, all_metrics):
    rows = []
    for metrics in all_metrics:
        tile = metrics["tile"]
        cells = "".join(
            f'<td><img src="{tile}/{fname}" loading="lazy">'
            f"<div>{label}</div></td>"
            for fname, label in _PANELS
            if os.path.exists(os.path.join(out_dir, tile, fname))
        )
        rows.append(
            f"<tr><th><a href='/pipeline.html?tile={tile}'>{tile}</a>"
            f"<div class=m>{_metric_line(metrics)}</div></th>{cells}</tr>"
        )
    html = (
        "<!doctype html><meta charset=utf-8>"
        "<title>d12 ladder verification</title>"
        "<style>body{background:#111;color:#ddd;font-family:sans-serif}"
        "img{width:220px;image-rendering:auto;display:block}"
        "td,th{padding:4px;text-align:left;vertical-align:top}"
        "th{max-width:240px;font-weight:normal}"
        "th a{color:#5af}.m{color:#8fb0cc;font-size:12px}"
        "td div{color:#6889a8;font-size:11px;text-align:center}</style>"
        "<h1>d12 classification ladder — verification</h1>"
        "<p>coarse_v4: "
        "<span style='background:rgb(150,105,210);padding:0 8px'>&nbsp;</span> grey "
        "<span style='background:rgb(150,225,60);padding:0 8px'>&nbsp;</span> green "
        "<span style='background:rgb(255,140,0);padding:0 8px'>&nbsp;</span> dark "
        "<span style='background:#fff;padding:0 8px'>&nbsp;</span> white "
        "<span style='background:rgb(255,42,161);padding:0 8px'>&nbsp;</span> water "
        "<span style='background:rgb(60,120,255);padding:0 8px'>&nbsp;</span> shadow"
        "<span style='background:rgb(255,230,90);padding:0 8px'>&nbsp;</span> sand · "
        "<span style='background:rgb(105,92,125);padding:0 8px'>&nbsp;</span> shore rock"
        "</p><p>Google is water/structure authority only (late spring: "
        "under-shows green, over-shows snow). Lake dropout % = Google-"
        "confirmed water missing from the official mask — ingest gap.</p>"
        f"<table>{''.join(rows)}</table>"
    )
    with open(os.path.join(out_dir, "index.html"), "w") as handle:
        handle.write(html)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tiles", nargs="*", help="tile ids (12-col-row)")
    parser.add_argument("--all", action="store_true",
                        help="every d12 tile with a real texture")
    parser.add_argument("--reset", action="store_true",
                        help="purge superseded classifier rows first")
    parser.add_argument("--no-google", action="store_true")
    parser.add_argument("--db", default=DB_PATH)
    parser.add_argument("--out", default=OUT_DIR)
    args = parser.parse_args()

    db = sqlite3.connect(args.db)
    if args.reset:
        placeholders = ",".join("?" * len(STALE_SOURCES))
        removed = db.execute(
            f"DELETE FROM classifier_tiles WHERE source IN ({placeholders})",
            STALE_SOURCES,
        ).rowcount
        db.commit()
        print(f"purged {removed} stale classifier rows "
              f"(sources: {', '.join(STALE_SOURCES)})", flush=True)

    tiles = list(args.tiles)
    if args.all:
        tiles += [
            tile_id for (tile_id,) in db.execute(
                "SELECT tile_id FROM textures WHERE tile_id LIKE '12-%' "
                "AND source NOT LIKE '%procedural%' "
                "AND source NOT IN ('ancestor_crop', 'placeholder') "
                "ORDER BY tile_id"
            ) if tile_id not in tiles
        ]
    if not tiles:
        parser.error("no tiles given (use tile ids or --all)")

    os.makedirs(args.out, exist_ok=True)
    all_metrics = []
    started = time.time()
    for index, tile_id in enumerate(tiles):
        metrics = verify_tile(
            db, tile_id, args.out, use_google=not args.no_google,
        )
        if metrics is not None:
            all_metrics.append(metrics)
        done = index + 1
        elapsed = time.time() - started
        eta = elapsed / done * (len(tiles) - done)
        print(
            f"[{done}/{len(tiles)} {100 * done // len(tiles)}%] {tile_id} "
            f"{'ok' if metrics else 'skipped'} · eta {eta:.0f}s",
            flush=True,
        )
    build_gallery(args.out, all_metrics)
    print(
        f"gallery: {os.path.join(args.out, 'index.html')} "
        f"({len(all_metrics)} tiles verified)",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
