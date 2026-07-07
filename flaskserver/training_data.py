"""Paired training samples: Google reference pixels + DEM-derived conditioning.

Exports per-tile training pairs for the terrain coloring/classification model:
the Google reference tile (target) aligned with our SPOT texture (coarse color
input) and per-pixel terrain conditioning channels computed from our own
ArcticDEM heightmap — slope, southness (north/south aspect) and a sun term
(incidence x terrain shadow). North and south slopes color differently in
Greenland, so aspect is a first-class training input, never pooled.

The sun/shadow math deliberately mirrors webserver/vegetation.js (grid-south
sun at 25 deg effective growing-season elevation, same shadow march taps) so
the channels a model trains on are exactly the channels the client can
recompute at runtime. Grid south (-y in EPSG:3413) deviates from true south by
only ~7 deg at Nuuk.

Same policy as LAAS_ASSETS.md: Google pixels are a measurement/training guide
only, never shipped as terrain. Output goes to sample/ (gitignored).

CLI (from flaskserver/):
    venv/bin/python training_data.py                  # every flown land tile at depth 14
    venv/bin/python training_data.py 14-5542-3157 --res 512 --zoom 18
    venv/bin/python training_data.py --aoi 64.14,-51.66,64.18,-51.54   # optional restriction

Per tile writes sample/training/<tid>/: sample.npz (google uint8 HxWx3,
coarse uint8 HxWx3, elev/slope/southness/sun float32 HxW, image-oriented,
row 0 = north) plus eyeball PNGs, and a top-level index.html gallery.
"""
import io
import json
import math
import sqlite3
import sys
from pathlib import Path

import numpy as np
from PIL import Image

from biomes import REFINED_NAMES, class_overlay, classify_field, refine_rock
from colored_log import get_logger
from coords import to_stereo
from database import GRID_N, _decompress_float32
from google_ref import get_google_ref, init_google_refs

log = get_logger("terrain.training")

DEFAULT_DEPTH = 14
MIN_GROUND_Z_LAND = 0.6   # land threshold, same convention as vegetation.js

# Sun model — keep in lockstep with webserver/vegetation.js
SUN_EL = 25 * math.pi / 180
SUN_SIN, SUN_COS, SUN_TAN = math.sin(SUN_EL), math.cos(SUN_EL), math.tan(SUN_EL)
SHADOW_MARCH_M = (8, 20, 50, 120, 300)


def _smoothstep(a, b, x):
  t = np.clip((x - a) / (b - a), 0.0, 1.0)
  return t * t * (3 - 2 * t)


def terrain_channels(hm, tile_size_m):
  """elev/slope/southness/sun from a (GRID_N, GRID_N) heightmap, row 0 = south.

  Returns dict of float32 (GRID_N, GRID_N) arrays in DB orientation (row index
  increases northward); caller flips to image orientation.
  """
  spacing = tile_size_m / (GRID_N - 1)
  # rows run south->north, so axis 0 gradient is d/dy toward north
  gy, gx = np.gradient(hm, spacing)
  slope = np.hypot(gx, gy)
  norm = np.sqrt(gx * gx + gy * gy + 1.0)
  # surface tilts toward south when ground rises northward (gy > 0)
  southness = gy / norm
  # incidence: normal . sun (sun due grid-south), flat ground normalized to 1
  insol = (gy * SUN_COS + SUN_SIN) / (norm * SUN_SIN)

  # terrain shadow: march south (decreasing row), find horizon tangent.
  # Taps clamp at the tile edge, same acceptable miss as vegetation.js.
  rows = np.arange(GRID_N, dtype=np.float32)
  horizon = np.zeros_like(hm)
  for d in SHADOW_MARCH_M:
    rf = np.clip(rows - d / spacing, 0.0, GRID_N - 1)
    r0 = np.floor(rf).astype(int)
    r1 = np.minimum(r0 + 1, GRID_N - 1)
    t = (rf - r0).astype(np.float32)[:, None]
    z_s = hm[r0, :] * (1 - t) + hm[r1, :] * t
    np.maximum(horizon, (z_s - hm - 1.0) / d, out=horizon)
  shade = 1.0 - _smoothstep(SUN_TAN * 0.7, SUN_TAN * 1.3, horizon)

  return {
    "elev": hm.astype(np.float32),
    "slope": slope.astype(np.float32),
    "southness": southness.astype(np.float32),
    "sun": (insol * shade).astype(np.float32),
  }


def _upsample_f32(arr, res):
  return np.array(Image.fromarray(arr, mode="F").resize((res, res), Image.Resampling.BILINEAR))


def _gray(arr, lo, hi):
  a = np.clip((arr - lo) / (hi - lo), 0, 1)
  return (np.stack([a, a, a], -1) * 255).astype(np.uint8)


def _diverging(arr):
  """southness -1..1 -> blue (north-facing) / white / red (south-facing)."""
  t = np.clip((arr + 1) / 2, 0, 1)
  r = np.where(t > 0.5, 1.0, 2 * t)
  b = np.where(t < 0.5, 1.0, 2 * (1 - t))
  g = 1.0 - np.abs(2 * t - 1) * 0.85
  return (np.stack([r, g, b], -1) * 255).astype(np.uint8)


def render_channel(chans, chan):
  """Visualize one terrain channel as an RGB uint8 image (shared by the CLI
  exports and the /api/channel debug endpoint)."""
  if chan == "southness":
    return _diverging(chans["southness"])
  if chan == "slope":
    return _gray(chans["slope"], 0.0, 1.0)
  if chan == "sun":
    return _gray(chans["sun"], 0.0, 1.3)
  e = chans["elev"]
  return _gray(e, float(np.nanmin(e)), float(np.nanmax(e)) + 1e-6)


def export_tile(db, tid, out_root, zoom=None, res=512, refresh=False):
  row = db.execute(
    "SELECT t.x_min, t.y_min, t.x_max, t.y_max, t.heightmap, t.source, x.texture "
    "FROM tiles t LEFT JOIN textures x ON x.tile_id = t.tile_id "
    "WHERE t.tile_id = ?", (tid,)).fetchone()
  if row is None:
    print(f"{tid}: not in tiles table, skipping")
    return None
  bbox, hm_blob, hm_source, tex_blob = row[:4], row[4], row[5], row[6]
  if hm_blob is None or tex_blob is None:
    print(f"{tid}: missing heightmap or texture, skipping")
    return None

  jpeg, z = get_google_ref(db, tid, bbox, resolution=res, zoom=zoom, refresh=refresh)
  if jpeg is None:
    print(f"{tid}: google fetch failed, skipping")
    return None
  # cache may hold a higher-res ref from an earlier run — normalize to res
  google = np.array(Image.open(io.BytesIO(jpeg)).convert("RGB")
                    .resize((res, res), Image.Resampling.LANCZOS))
  coarse = np.array(Image.open(io.BytesIO(tex_blob)).convert("RGB")
                    .resize((res, res), Image.Resampling.LANCZOS))

  hm = _decompress_float32(hm_blob, (GRID_N, GRID_N))
  tile_size_m = bbox[2] - bbox[0]
  chans = terrain_channels(hm, tile_size_m)
  # upsample to res and flip to image orientation (row 0 = north)
  chans = {k: _upsample_f32(v, res)[::-1].copy() for k, v in chans.items()}

  d = out_root / tid
  d.mkdir(parents=True, exist_ok=True)
  np.savez_compressed(
    d / "sample.npz", google=google, coarse=coarse,
    **chans,
    bbox=np.array(bbox, dtype=np.float64),
    meta=json.dumps({"tile": tid, "google_zoom": z, "res": res,
                     "m_per_px": tile_size_m / res, "dem_source": hm_source}))

  Image.fromarray(google).save(d / "google.png")
  Image.fromarray(coarse).save(d / "coarse.png")
  # both label stages, for eyeball-tuning thresholds in biomes.py
  field = classify_field(google)
  refined = refine_rock(google, tile_size_m / res, field, slope=chans["slope"],
                        google_zoom=z)
  Image.fromarray(class_overlay(google, field)).save(d / "field.png")
  Image.fromarray(class_overlay(google, refined, names=REFINED_NAMES)).save(d / "refined.png")
  for chan in ("elev", "slope", "southness", "sun"):
    Image.fromarray(render_channel(chans, chan)).save(d / f"{chan}.png")

  stats = {k: [round(float(np.nanpercentile(v, p)), 3) for p in (5, 50, 95)]
           for k, v in chans.items()}
  print(f"{tid}: z={z} {tile_size_m / res:.2f} m/px  "
        f"slope p50={stats['slope'][1]}  southness p5/50/95={stats['southness']}  "
        f"sun p5/50/95={stats['sun']}")
  return {"tile": tid, "google_zoom": z, "stats": stats}


def candidate_tiles(db, depth, aoi=None, min_land=0.2):
  """Depth-N tiles with heightmap + texture + enough land, optionally
  restricted to a lat/lon AOI. Default is everything flown at that depth."""
  sql = ("SELECT t.tile_id, t.heightmap FROM tiles t "
         "JOIN textures x ON x.tile_id = t.tile_id "
         "WHERE t.depth = ? AND t.heightmap IS NOT NULL ")
  params = [depth]
  if aoi:
    lat0, lon0, lat1, lon1 = aoi
    xs, ys = [], []
    for lat in (lat0, lat1):
      for lon in (lon0, lon1):
        x, y = to_stereo(lat, lon)
        xs.append(x)
        ys.append(y)
    sql += "AND t.x_max > ? AND t.x_min < ? AND t.y_max > ? AND t.y_min < ? "
    params += [min(xs), max(xs), min(ys), max(ys)]
  out = []
  for tid, blob in db.execute(sql + "ORDER BY t.tile_id", params):
    hm = _decompress_float32(blob, (GRID_N, GRID_N))
    if float(np.mean(hm > MIN_GROUND_Z_LAND)) >= min_land:
      out.append(tid)
  return out


def write_gallery(out_root):
  tiles = sorted(p.parent.name for p in out_root.glob("*/sample.npz"))
  cols = ["coarse", "google", "field", "refined", "elev", "slope", "southness", "sun"]
  rows_html = []
  for tid in tiles:
    cells = "".join(
      f'<td><img src="{tid}/{c}.png" loading="lazy"><br><small>{c}</small></td>'
      for c in cols)
    rows_html.append(
      f'<tr><th>{tid}<br><small><a href="http://localhost:5173/compare.html'
      f'?tile={tid}">compare</a></small></th>{cells}</tr>')
  (out_root / "index.html").write_text(
    "<!doctype html><meta charset=utf-8><title>training pairs</title>"
    "<style>body{background:#111;color:#ddd;font-family:sans-serif}"
    "img{width:220px;image-rendering:auto}td,th{padding:4px;text-align:left}"
    "</style><h1>Training pairs — headlands SE of Nuuk airport</h1>"
    "<p>target = google; inputs = coarse + elev/slope/southness/sun "
    "(southness: red = south-facing, blue = north-facing)</p>"
    f"<table>{''.join(rows_html)}</table>")
  print(f"gallery: {out_root / 'index.html'}  ({len(tiles)} tiles)")


def _cli(argv):
  import argparse
  import os

  db_path = os.environ.get("TERRAIN_DB_PATH", "").strip() or str(Path(__file__).parent / "terrain.db")
  ap = argparse.ArgumentParser(description="Export Google-vs-terrain training pairs.")
  ap.add_argument("tile_ids", nargs="*",
                  help="explicit tiles; omit for every flown land tile at --depth")
  ap.add_argument("--aoi", default=None, help="optional lat0,lon0,lat1,lon1 restriction")
  ap.add_argument("--depth", type=int, default=DEFAULT_DEPTH)
  ap.add_argument("--land-frac", type=float, default=0.2,
                  help="min fraction of grid nodes above sea level (default 0.2)")
  ap.add_argument("--res", type=int, default=512, help="output px per tile (default 512)")
  ap.add_argument("--zoom", type=int, default=None, help="force Google zoom (default: auto, capped at 18)")
  ap.add_argument("--out", default=str(Path(__file__).parent / "sample" / "training"))
  ap.add_argument("--refresh", action="store_true", help="bypass google_refs cache")
  ap.add_argument("--db", default=db_path)
  args = ap.parse_args(argv)

  db = sqlite3.connect(args.db)
  init_google_refs(db)
  out_root = Path(args.out)
  out_root.mkdir(parents=True, exist_ok=True)

  aoi = tuple(float(v) for v in args.aoi.split(",")) if args.aoi else None
  tids = args.tile_ids or candidate_tiles(db, args.depth, aoi=aoi, min_land=args.land_frac)
  if not tids:
    print("no tiles with heightmap+texture found — fly the area first so the DB fills in")
    return
  print(f"exporting {len(tids)} tiles")
  ok = 0
  for i, tid in enumerate(tids, 1):
    if export_tile(db, tid, out_root, zoom=args.zoom, res=args.res, refresh=args.refresh):
      ok += 1
    if i % 50 == 0:
      print(f"--- {i}/{len(tids)} done ({ok} ok)")
  write_gallery(out_root)


if __name__ == "__main__":
  _cli(sys.argv[1:])
