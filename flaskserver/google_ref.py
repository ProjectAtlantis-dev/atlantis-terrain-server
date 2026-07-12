"""Google satellite reference tiles, warped onto our EPSG:3413 tile grid.

Debug/QA tool: pulls Google XYZ satellite tiles (web mercator), stitches and
reprojects them to a tile's exact 3413 bbox so the result is pixel-aligned
with our own /api/texture/<tile_id>.jpg. Used to sanity-check Dataforsyningen
imagery and the vegetation classifier against an independent reference.
NOT part of the texture pipeline — Google imagery is never served as terrain.

Served via GET /api/google/<tile_id>.jpg (cached in google_refs table).

CLI:
    python google_ref.py 14-5628-2936 14-5689-2955 --res 512 --out /tmp/cmp
writes <tile>_ours.png, <tile>_google.png and <tile>_sbs.png (side by side).
"""
import io
import math
import os
import sqlite3
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from rasterio.crs import CRS
from rasterio.transform import from_bounds as transform_from_bounds
from rasterio.warp import Resampling as WarpResampling, reproject

# texture.py hard-requires DATAFORSYNINGEN_TOKEN at import; when run as a CLI
# (outside runFlaskServer, which sources .env) load it the same way.
if "DATAFORSYNINGEN_TOKEN" not in os.environ:
  _env = Path(__file__).parent / ".env"
  if _env.exists():
    for _line in _env.read_text().splitlines():
      _line = _line.strip()
      if _line and not _line.startswith("#") and "=" in _line:
        k, v = _line.split("=", 1)
        os.environ.setdefault(k.strip().removeprefix("export "), v.strip().strip('"'))

from colored_log import get_logger
from texture import S2_HALF_EXTENT, _bbox_to_3857, _fetch_url

log = get_logger("terrain.google")

GOOGLE_URL = "https://mt{server}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}"

# Native max zoom observed around Nuuk (z19+ is server-side upsampled mush;
# verified 2026-07-07 by Laplacian detail-gain probe: z17→18 ratio 4.2,
# z18→19 ratio 2.3). Override per call if Google upgrades their imagery.
GOOGLE_MAX_ZOOM = 18


def _choose_google_zoom(bbox_3857, resolution, max_zoom=GOOGLE_MAX_ZOOM):
  """Smallest zoom whose source pixels are at least as fine as the output."""
  merc_mpp = (bbox_3857[2] - bbox_3857[0]) / resolution
  full_extent = 2 * S2_HALF_EXTENT
  z = math.ceil(math.log2(full_extent / (merc_mpp * 256)))
  return max(1, min(max_zoom, z))


def fetch_google_texture(bbox, resolution=512, zoom=None, max_zoom=GOOGLE_MAX_ZOOM):
  """Fetch Google satellite imagery for a 3413 bbox, warped to that bbox.

  Returns (jpeg_bytes, zoom) or (None, zoom) on failure. Same stitch+warp
  approach as fetch_sentinel2_texture, but XYZ source is Google and the
  default output resolution is higher (this is a close-up inspection tool).
  """
  bbox_3857 = _bbox_to_3857(bbox)
  z = zoom if zoom is not None else _choose_google_zoom(bbox_3857, resolution, max_zoom)

  full_extent = 2 * S2_HALF_EXTENT
  tile_span = full_extent / (1 << z)

  tx_min = max(0, int((bbox_3857[0] + S2_HALF_EXTENT) / tile_span))
  tx_max = min((1 << z) - 1, int((bbox_3857[2] + S2_HALF_EXTENT) / tile_span))
  ty_min = max(0, int((S2_HALF_EXTENT - bbox_3857[3]) / tile_span))
  ty_max = min((1 << z) - 1, int((S2_HALF_EXTENT - bbox_3857[1]) / tile_span))

  n_tx = tx_max - tx_min + 1
  n_ty = ty_max - ty_min + 1
  n_tiles = n_tx * n_ty
  if n_tiles > 64:
    log.warning(f"[GOOGLE FETCH] too many source tiles ({n_tiles}) at z={z}, skipping")
    return None, z

  src_tile_px = 256
  src_img = np.zeros((n_ty * src_tile_px, n_tx * src_tile_px, 3), dtype=np.uint8)

  fetched = 0
  failed = 0
  for ty_idx, ty in enumerate(range(ty_min, ty_max + 1)):
    for tx_idx, tx in enumerate(range(tx_min, tx_max + 1)):
      url = GOOGLE_URL.format(server=(tx + ty) % 4, x=tx, y=ty, z=z)
      data = _fetch_url(url, timeout=15)
      if data is None:
        failed += 1
        continue
      try:
        arr = np.array(Image.open(io.BytesIO(data)).convert("RGB"))
        src_img[ty_idx * src_tile_px:(ty_idx + 1) * src_tile_px,
                tx_idx * src_tile_px:(tx_idx + 1) * src_tile_px] = arr
        fetched += 1
      except Exception as e:
        log.warning(f"[GOOGLE FETCH] decode error z={z}/{ty}/{tx}: {e}")
        failed += 1

  if fetched == 0:
    log.error(f"[GOOGLE FETCH] TOTAL FAILURE: 0/{n_tiles} tiles at z={z}")
    return None, z
  if failed > 0:
    log.warning(f"[GOOGLE FETCH] partial: {fetched}/{n_tiles} ok at z={z}")

  src_x_min = -S2_HALF_EXTENT + tx_min * tile_span
  src_y_max = S2_HALF_EXTENT - ty_min * tile_span
  src_transform = transform_from_bounds(
    src_x_min, src_y_max - n_ty * tile_span, src_x_min + n_tx * tile_span, src_y_max,
    src_img.shape[1], src_img.shape[0])

  dst_transform = transform_from_bounds(bbox[0], bbox[1], bbox[2], bbox[3],
                                        resolution, resolution)
  dst_img = np.zeros((resolution, resolution, 3), dtype=np.uint8)
  for band in range(3):
    reproject(
      source=src_img[:, :, band],
      destination=dst_img[:, :, band],
      src_transform=src_transform,
      src_crs=CRS.from_epsg(3857),
      dst_transform=dst_transform,
      dst_crs=CRS.from_epsg(3413),
      resampling=WarpResampling.lanczos,
    )

  buf = io.BytesIO()
  Image.fromarray(dst_img).save(buf, format="JPEG", quality=88)
  return buf.getvalue(), z


# ---------------------------------------------------------------------------
# DB cache (google_refs table in terrain.db)
# ---------------------------------------------------------------------------

def init_google_refs(db):
  db.execute("""
    CREATE TABLE IF NOT EXISTS google_refs (
        tile_id    TEXT PRIMARY KEY,
        zoom       INTEGER NOT NULL,
        resolution INTEGER NOT NULL,
        texture    BLOB NOT NULL,
        updated_at TEXT NOT NULL
    )""")
  db.commit()


def read_google_ref(db, tile_id, min_resolution=0):
  row = db.execute(
    "SELECT texture, zoom, resolution FROM google_refs WHERE tile_id = ?",
    (tile_id,),
  ).fetchone()
  if row is None or row[2] < min_resolution:
    return None
  return row


def write_google_ref(db, tile_id, jpeg_bytes, zoom, resolution):
  db.execute(
    """INSERT INTO google_refs (tile_id, zoom, resolution, texture, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(tile_id) DO UPDATE SET
         zoom=excluded.zoom, resolution=excluded.resolution,
         texture=excluded.texture, updated_at=excluded.updated_at""",
    (tile_id, zoom, resolution, jpeg_bytes),
  )
  db.commit()


def get_google_ref(db, tile_id, bbox, resolution=512, zoom=None, refresh=False):
  """Cached fetch. Returns (jpeg_bytes, zoom) or (None, zoom)."""
  if not refresh:
    row = read_google_ref(db, tile_id, min_resolution=resolution)
    if row is not None:
      return row[0], row[1]
  jpeg, z = fetch_google_texture(bbox, resolution=resolution, zoom=zoom)
  if jpeg is not None:
    write_google_ref(db, tile_id, jpeg, z, resolution)
  return jpeg, z


# ---------------------------------------------------------------------------
# CLI: side-by-side composites for a list of tile ids
# ---------------------------------------------------------------------------

def _cli(argv):
  import argparse
  import os
  from pathlib import Path

  db_path = os.environ.get("TERRAIN_DB_PATH", "").strip() or str(Path(__file__).parent / "terrain.db")

  ap = argparse.ArgumentParser(description="Pull Google reference imagery for tiles, "
                                           "aligned to our grid, plus side-by-side composites.")
  ap.add_argument("tile_ids", nargs="+", help="e.g. 14-5628-2936")
  ap.add_argument("--res", type=int, default=512, help="output px per tile (default 512)")
  ap.add_argument("--zoom", type=int, default=None, help="force Google zoom (default: auto, capped at 18)")
  ap.add_argument("--out", default=".", help="output directory")
  ap.add_argument("--refresh", action="store_true", help="bypass google_refs cache")
  ap.add_argument("--db", default=db_path, help="terrain.db path")
  args = ap.parse_args(argv)

  os.makedirs(args.out, exist_ok=True)
  db = sqlite3.connect(args.db)
  init_google_refs(db)

  for tid in args.tile_ids:
    row = db.execute(
      "SELECT t.x_min, t.y_min, t.x_max, t.y_max, x.texture FROM tiles t "
      "LEFT JOIN textures x ON x.tile_id = t.tile_id WHERE t.tile_id = ?",
      (tid,),
    ).fetchone()
    if row is None:
      print(f"{tid}: not in tiles table, skipping")
      continue
    bbox, ours_blob = row[:4], row[4]

    goog, z = get_google_ref(db, tid, bbox, resolution=args.res,
                             zoom=args.zoom, refresh=args.refresh)
    if goog is None:
      print(f"{tid}: google fetch failed")
      continue
    goog_img = Image.open(io.BytesIO(goog)).convert("RGB")
    goog_img.save(f"{args.out}/{tid}_google.png")

    if ours_blob is None:
      print(f"{tid}: google z={z} saved (no local texture for side-by-side)")
      continue
    ours_img = (Image.open(io.BytesIO(ours_blob)).convert("RGB")
                .resize((args.res, args.res), Image.Resampling.LANCZOS))
    ours_img.save(f"{args.out}/{tid}_ours.png")

    gap = 8
    sbs = Image.new("RGB", (args.res * 2 + gap, args.res), (20, 20, 20))
    sbs.paste(ours_img, (0, 0))
    sbs.paste(goog_img, (args.res + gap, 0))
    sbs.save(f"{args.out}/{tid}_sbs.png")
    mpp = (bbox[2] - bbox[0]) / args.res
    print(f"{tid}: ours({mpp:.2f} m/px) vs google z={z} -> {args.out}/{tid}_sbs.png")


if __name__ == "__main__":
  _cli(sys.argv[1:])
