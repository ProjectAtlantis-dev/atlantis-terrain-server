"""Class-conditioned terrain recoloring — inference for train_color checkpoints.

Runs a trained coloring model over a tile's own inputs (SPOT coarse texture +
DEM channels, plus the google-class conditioning when the checkpoint was
trained with gcls — get_google_ref fetches/caches the reference, same policy
as training: google guides, its pixels never ship) and writes the predicted
base color as PNG. This is the `colorized` stage candidate for the texture
chain: classification decides, base color applies it, instances come later.

Tiles larger than the training scale are processed as overlapping 512 px
patches at the training m/px and stitched (the UNet is fully conv but was
trained at one scale; running native-res keeps it honest).

CLI (from flaskserver/):
    venv/bin/python colorize.py 12-1384-783
    venv/bin/python colorize.py 12-1384-783 --run sample/training/runs/northmask_east
Writes sample/colorized/<tid>/: colorized.png, coarse.png, google.png,
classes.png and composite.png (coarse | colorized | classes | google).
"""
import argparse
import io
import json
import sqlite3
import sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image

from biomes import FIELD_NAMES, TINTS, classify_field
from database import GRID_N, _decompress_float32
from google_ref import get_google_ref, init_google_refs
from train_color import N_CLASSES, TERRAIN_KEYS, UNet
from training_data import _upsample_f32, terrain_channels

TRAIN_MPP = 0.322      # d14 training pairs: 164.8 m tile at 512 px
PATCH = 512
OVERLAP = 32


def load_model(run_dir, device):
  metrics = json.loads((run_dir / "metrics.json").read_text())
  channels = metrics["channels"]
  use_terrain = "terrain" in channels
  use_gcls = "gcls" in channels
  in_ch = 3 + (len(TERRAIN_KEYS) if use_terrain else 0) + (N_CLASSES if use_gcls else 0)
  model = UNet(in_ch).to(device)
  model.load_state_dict(torch.load(run_dir / "model.pt", map_location=device))
  model.eval()
  return model, use_terrain, use_gcls


@torch.no_grad()
def run_patched(model, x_full, device):
  """Overlap-blend 512px patches over an (H, W, C) input; returns rgb + cls."""
  h, w, _ = x_full.shape
  rgb = np.zeros((h, w, 3), np.float32)
  cls_logit = np.zeros((h, w, N_CLASSES), np.float32)
  weight = np.zeros((h, w, 1), np.float32)
  step = PATCH - 2 * OVERLAP
  ys = sorted({min(y, h - PATCH) for y in range(0, max(h - PATCH, 0) + 1, step)} | {max(0, h - PATCH)})
  xs = sorted({min(x, w - PATCH) for x in range(0, max(w - PATCH, 0) + 1, step)} | {max(0, w - PATCH)})
  # cosine feather so overlapping patches blend without seams
  win1 = 0.5 - 0.5 * np.cos(2 * np.pi * (np.arange(PATCH) + 0.5) / PATCH)
  win = (win1[:, None] * win1[None, :])[..., None].astype(np.float32) + 1e-3
  n_total = len(ys) * len(xs)
  done = 0
  for y0 in ys:
    for x0 in xs:
      x = torch.from_numpy(x_full[y0:y0 + PATCH, x0:x0 + PATCH]).permute(2, 0, 1)[None].to(device)
      pr, pl = model(x)
      rgb[y0:y0 + PATCH, x0:x0 + PATCH] += pr[0].permute(1, 2, 0).cpu().numpy() * win
      cls_logit[y0:y0 + PATCH, x0:x0 + PATCH] += pl[0].permute(1, 2, 0).cpu().numpy() * win
      weight[y0:y0 + PATCH, x0:x0 + PATCH] += win
      done += 1
      print(f"patch {done}/{n_total} ({100 * done // n_total}%)", flush=True)
  rgb /= weight
  cls_logit /= weight
  return rgb, cls_logit.argmax(-1)


def colorize_tile(db, tid, run_dir, out_root, device):
  row = db.execute(
    "SELECT t.x_min, t.y_min, t.x_max, t.y_max, t.heightmap, x.texture "
    "FROM tiles t LEFT JOIN textures x ON x.tile_id = t.tile_id "
    "WHERE t.tile_id = ?", (tid,)).fetchone()
  if row is None or row[4] is None or row[5] is None:
    print(f"{tid}: missing tile/heightmap/texture, skipping")
    return
  bbox, hm_blob, tex_blob = row[:4], row[4], row[5]
  tile_m = bbox[2] - bbox[0]
  # run at the training scale, rounded to a multiple of 4 for the UNet pools
  res = max(64, int(round(tile_m / TRAIN_MPP / 4)) * 4)
  print(f"{tid}: {tile_m:.0f} m tile -> {res} px ({tile_m / res:.3f} m/px)", flush=True)

  model, use_terrain, use_gcls = load_model(run_dir, device)

  coarse = np.array(Image.open(io.BytesIO(tex_blob)).convert("RGB")
                    .resize((res, res), Image.Resampling.LANCZOS), np.float32) / 255.0
  hm = _decompress_float32(hm_blob, (GRID_N, GRID_N))
  chans = {k: _upsample_f32(v, res)[::-1].copy()
           for k, v in terrain_channels(hm, tile_m).items()}

  parts = [coarse]
  if use_terrain:
    parts.append(np.stack([
      np.clip(chans["slope"], 0, 1.5) / 1.5,
      chans["southness"],
      np.clip(chans["sun"], 0, 2.0) / 2.0,
      chans["elev"] / 800.0,
    ], axis=-1).astype(np.float32))
  google = None
  if use_gcls:
    # the google stitcher caps source-tile count, so big tiles fetch the ref
    # at a coarser working res; the class map upsamples to res (nearest —
    # class indices must not blend)
    gres = min(res, 1024)
    jpeg, z = get_google_ref(db, tid, bbox, resolution=gres)
    if jpeg is None:
      print(f"{tid}: google fetch failed and checkpoint needs gcls, skipping")
      return
    google = np.array(Image.open(io.BytesIO(jpeg)).convert("RGB")
                      .resize((gres, gres), Image.Resampling.LANCZOS))
    gchans = {k: _upsample_f32(v, gres)[::-1].copy()
              for k, v in terrain_channels(hm, tile_m).items()}
    gcls = classify_field(google, southness=gchans["southness"], slope=gchans["slope"],
                          mpp=tile_m / gres, elev=gchans["elev"])
    if gres != res:
      gcls = np.array(Image.fromarray(gcls.astype(np.uint8))
                      .resize((res, res), Image.Resampling.NEAREST))
      google = np.array(Image.fromarray(google).resize((res, res), Image.Resampling.LANCZOS))
    parts.append(np.eye(N_CLASSES, dtype=np.float32)[gcls])
  x_full = np.concatenate(parts, axis=-1)

  rgb, pcls = run_patched(model, x_full, device)

  d = out_root / tid
  d.mkdir(parents=True, exist_ok=True)
  tint = np.zeros((*pcls.shape, 3), np.float32)
  for i, name in enumerate(FIELD_NAMES):
    tint[pcls == i] = np.array(TINTS[name]) / 255.0
  imgs = {"coarse": coarse, "colorized": rgb, "classes": rgb * 0.45 + tint * 0.55}
  if google is not None:
    imgs["google"] = google.astype(np.float32) / 255.0
  for name, img in imgs.items():
    Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).save(d / f"{name}.png")
  gap = 8
  cols = list(imgs.values())
  sbs = Image.new("RGB", (res * len(cols) + gap * (len(cols) - 1), res), (20, 20, 20))
  for i, img in enumerate(cols):
    sbs.paste(Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)),
              (i * (res + gap), 0))
  sbs.save(d / "composite.png")
  shares = {n: round(float((pcls == i).mean()), 3) for i, n in enumerate(FIELD_NAMES)}
  print(f"{tid}: done -> {d}/composite.png  pred class shares: "
        f"{ {k: v for k, v in shares.items() if v > 0.005} }", flush=True)


def main(argv):
  import os
  db_path = os.environ.get("TERRAIN_DB_PATH", "").strip() or str(Path(__file__).parent / "terrain.db")
  ap = argparse.ArgumentParser(description="Recolor tiles with a trained coloring model.")
  ap.add_argument("tile_ids", nargs="+")
  ap.add_argument("--run", default=str(Path(__file__).parent / "sample" / "training"
                                       / "runs" / "northmask_east"))
  ap.add_argument("--out", default=str(Path(__file__).parent / "sample" / "colorized"))
  ap.add_argument("--db", default=db_path)
  args = ap.parse_args(argv)

  device = "mps" if torch.backends.mps.is_available() else "cpu"
  db = sqlite3.connect(args.db)
  init_google_refs(db)
  out_root = Path(args.out)
  out_root.mkdir(parents=True, exist_ok=True)
  for tid in args.tile_ids:
    colorize_tile(db, tid, Path(args.run), out_root, device)


if __name__ == "__main__":
  main(sys.argv[1:])
