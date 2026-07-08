"""Test-scale conditioned coloring + classification model over training_data.py pairs.

Learns google-reference color AND field class (rock/lichen/grass/snow/water,
pseudo-labeled by biomes.classify_field on the Google target — the depth-11
field stage of CLASSIFICATION.md; rock hard/loose refinement and bush
instances happen at finer depths, not here) from our coarse SPOT texture
plus DEM-derived conditioning (slope,
southness, sun, elev). Google is the authority on water/shorelines: pixels it
classifies as water are excluded from the RGB loss regardless of DEM
elevation, but they DO supervise the class head as `water` — otherwise the
head is untrained over water and hallucinates lichen/grass across the fjord.

The headline experiment is the ABLATION: train with and without the terrain
channels and compare held-out error — overall and split by aspect (north- vs
south-facing), since aspect is the hypothesis under test.

    venv/bin/python train_color.py --channels rgb               # baseline
    venv/bin/python train_color.py --channels rgb+terrain       # conditioned
    venv/bin/python train_color.py --channels rgb+terrain+gcls  # + google classes

gcls feeds the google-derived field class map (one-hot) as INPUT conditioning:
the coarse SPOT texture is blind to patch-scale vegetation (measured -0.07
sigma separation on 14-5511-3144 vs +1.63 sigma in google), so placement
signal must come from the google refs — the server can fetch/cache one for
any tile at inference (get_google_ref). Tiles without google coverage get
all-zero class channels, which the model sees as "no signal".

Validation: --val accepts tile ids or "auto" (default, every 10th tile).
Augmentation: horizontal flips only — vertical flips would silently negate
southness and invalidate the sun/shadow channel.

Writes checkpoints, metrics and val composites to sample/training/runs/<name>/.
"""
import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from biomes import FIELD_NAMES, TINTS, classify_field

SAMPLE_ROOT = Path(__file__).parent / "sample" / "training"
MIN_GROUND_Z = 0.6           # land mask, same convention as vegetation.js
TERRAIN_KEYS = ("slope", "southness", "sun", "elev")
N_CLASSES = len(FIELD_NAMES)
WATER_IDX = FIELD_NAMES.index("water")
# Snow labels are capture-date noise (Google shot snow where SPOT shows bare
# ground), so snow pixels train the RGB head but never the class head.
SNOW_IDX = FIELD_NAMES.index("snow")


def load_tiles(root):
  tiles = {}
  paths = sorted(root.glob("*/sample.npz"))
  for i, npz in enumerate(paths, 1):
    if i == 1 or i % 50 == 0 or i == len(paths):
      print(f"loading tiles {i}/{len(paths)} ({100 * i // len(paths)}%)", flush=True)
    try:
      z = np.load(npz)
      google_u8 = z["google"]
    except Exception as e:   # partial write from a concurrent export run
      print(f"skipping {npz.parent.name}: {e}")
      continue
    cls = classify_field(google_u8, southness=z["southness"], slope=z["slope"],
                         mpp=float(z["bbox"][2] - z["bbox"][0]) / google_u8.shape[1])
    terr = np.stack([
      np.clip(z["slope"], 0, 1.5) / 1.5,
      z["southness"],
      np.clip(z["sun"], 0, 2.0) / 2.0,
      z["elev"] / 800.0,
    ], axis=-1).astype(np.float32)
    tiles[npz.parent.name] = {
      "google": google_u8.astype(np.float32) / 255.0,
      "coarse": z["coarse"].astype(np.float32) / 255.0,
      "terr": terr,
      "cls": cls.astype(np.int64),
      # Google is the authority on water/shorelines: DEM water artifacts
      # (spiky fjord noise above sea level) must not train as land, so the
      # RGB mask requires BOTH dem-land and google-not-water.
      "mask": ((z["elev"] > MIN_GROUND_Z) & (cls != WATER_IDX)).astype(np.float32),
      # The CLASS head must consult google's water, not skip it: excluded
      # water pixels leave the head free to argmax lichen/grass over the
      # fjord at inference. Water labels are valid supervision (lakes over
      # dem-land included); dem-ocean pixels google calls land (shoreline
      # misalignment slivers) stay out.
      "cls_mask": ((cls == WATER_IDX) | (z["elev"] > MIN_GROUND_Z)).astype(np.float32),
      "southness": z["southness"],
    }
  return tiles


class UNet(nn.Module):
  """Tiny fully-conv UNet; heads: 3ch RGB (sigmoid) + N_CLASSES logits."""

  def __init__(self, in_ch, base=32):
    super().__init__()
    def block(ci, co):
      return nn.Sequential(
        nn.Conv2d(ci, co, 3, padding=1), nn.GroupNorm(8, co), nn.SiLU(),
        nn.Conv2d(co, co, 3, padding=1), nn.GroupNorm(8, co), nn.SiLU())
    self.e1 = block(in_ch, base)
    self.e2 = block(base, base * 2)
    self.e3 = block(base * 2, base * 4)
    self.d2 = block(base * 4 + base * 2, base * 2)
    self.d1 = block(base * 2 + base, base)
    self.out = nn.Conv2d(base, 3 + N_CLASSES, 1)

  def forward(self, x):
    s1 = self.e1(x)
    s2 = self.e2(F.max_pool2d(s1, 2))
    s3 = self.e3(F.max_pool2d(s2, 2))
    u2 = self.d2(torch.cat([F.interpolate(s3, scale_factor=2), s2], 1))
    u1 = self.d1(torch.cat([F.interpolate(u2, scale_factor=2), s1], 1))
    out = self.out(u1)
    return torch.sigmoid(out[:, :3]), out[:, 3:]


def make_inputs(tile, feats):
  use_terrain, use_gcls = feats
  chans = [tile["coarse"]]
  if use_terrain:
    chans.append(tile["terr"])
  if use_gcls:
    chans.append(np.eye(N_CLASSES, dtype=np.float32)[tile["cls"]])
  return np.concatenate(chans, axis=-1)


def sample_batch(rng, train_tiles, names, feats, batch, patch):
  xs, ys, cs, ms, cms = [], [], [], [], []
  while len(xs) < batch:
    t = train_tiles[names[rng.integers(len(names))]]
    r = rng.integers(0, t["google"].shape[0] - patch)
    c = rng.integers(0, t["google"].shape[1] - patch)
    m = t["mask"][r:r + patch, c:c + patch]
    cm = t["cls_mask"][r:r + patch, c:c + patch]
    # skip crops with nothing to supervise anywhere; pure-water crops still
    # train the class head (that's where the water label lives)
    if cm.mean() < 0.3:
      continue
    x = make_inputs(t, feats)[r:r + patch, c:c + patch]
    y = t["google"][r:r + patch, c:c + patch]
    k = t["cls"][r:r + patch, c:c + patch]
    if rng.random() < 0.5:  # horizontal flip is aspect-safe
      x, y, k, m, cm = x[:, ::-1], y[:, ::-1], k[:, ::-1], m[:, ::-1], cm[:, ::-1]
    xs.append(np.ascontiguousarray(x))
    ys.append(np.ascontiguousarray(y))
    cs.append(np.ascontiguousarray(k))
    ms.append(np.ascontiguousarray(m))
    cms.append(np.ascontiguousarray(cm))
  x = torch.from_numpy(np.stack(xs)).permute(0, 3, 1, 2)
  y = torch.from_numpy(np.stack(ys)).permute(0, 3, 1, 2)
  k = torch.from_numpy(np.stack(cs))
  m = torch.from_numpy(np.stack(ms)).unsqueeze(1)
  cm = torch.from_numpy(np.stack(cms))
  return x, y, k, m, cm


@torch.no_grad()
def eval_tiles(model, tiles, names, feats, device):
  l1s, accs = [], []
  agg = {"south": [], "north": []}
  for n in names:
    t = tiles[n]
    x = torch.from_numpy(make_inputs(t, feats)).permute(2, 0, 1)[None].to(device)
    rgb, logits = model(x)
    pred = rgb[0].permute(1, 2, 0).cpu().numpy()
    pcls = logits[0].argmax(0).cpu().numpy()
    err = np.abs(pred - t["google"]).mean(axis=-1)
    m = t["mask"] > 0
    if not m.any():
      continue
    l1s.append(err[m].mean())
    # class accuracy over the class-head mask (includes google water)
    mc = (t["cls_mask"] > 0) & (t["cls"] != SNOW_IDX)
    if mc.any():
      accs.append((pcls[mc] == t["cls"][mc]).mean())
    for key, sel in (("south", m & (t["southness"] > 0.15)),
                     ("north", m & (t["southness"] < -0.15))):
      if sel.any():
        agg[key].append(err[sel].mean())
  return {
    "l1": float(np.mean(l1s)),
    "l1_south": float(np.mean(agg["south"])),
    "l1_north": float(np.mean(agg["north"])),
    "cls_acc": float(np.mean(accs)),
  }


@torch.no_grad()
def save_composite(model, tile, feats, device, path):
  from PIL import Image
  x = torch.from_numpy(make_inputs(tile, feats)).permute(2, 0, 1)[None].to(device)
  rgb, logits = model(x)
  pred = rgb[0].permute(1, 2, 0).cpu().numpy()
  pcls = logits[0].argmax(0).cpu().numpy()
  tint = np.zeros((*pcls.shape, 3), np.float32)
  for i, name in enumerate(FIELD_NAMES):
    tint[pcls == i] = np.array(TINTS[name]) / 255.0
  cls_img = pred * 0.45 + tint * 0.55
  res = tile["google"].shape[0]
  gap = 8
  sbs = Image.new("RGB", (res * 4 + gap * 3, res), (20, 20, 20))
  for i, img in enumerate([tile["coarse"], pred, cls_img, tile["google"]]):
    sbs.paste(Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)),
              (i * (res + gap), 0))
  sbs.save(path)


def main():
  ap = argparse.ArgumentParser()
  ap.add_argument("--channels", choices=["rgb", "rgb+terrain", "rgb+terrain+gcls"],
                  default="rgb+terrain+gcls")
  ap.add_argument("--data", default=str(SAMPLE_ROOT),
                  help="training-pairs dir (default sample/training)")
  ap.add_argument("--name", default=None,
                  help="run dir name (default: channels tag)")
  ap.add_argument("--val", default="auto",
                  help='comma-separated tile ids, "auto" = every 10th tile, or '
                       '"east" = easternmost ~15%% of tiles (spatially held out)')
  ap.add_argument("--steps", type=int, default=4000)
  ap.add_argument("--batch", type=int, default=32)
  ap.add_argument("--patch", type=int, default=64)
  ap.add_argument("--lr", type=float, default=2e-3)
  ap.add_argument("--cls-weight", type=float, default=0.25)
  ap.add_argument("--seed", type=int, default=0)
  args = ap.parse_args()

  use_terrain = "terrain" in args.channels
  use_gcls = "gcls" in args.channels
  feats = (use_terrain, use_gcls)
  device = "mps" if torch.backends.mps.is_available() else "cpu"
  torch.manual_seed(args.seed)
  rng = np.random.default_rng(args.seed)

  data_root = Path(args.data)
  tiles = load_tiles(data_root)
  names = sorted(tiles)
  if args.val == "auto":
    val_names = names[::10]
  elif args.val == "east":
    # hold out a contiguous strip: adjacent tiles are correlated, so every-Nth
    # splits leak. tile ids are depth-col-row; col grows eastward.
    cols = sorted(int(n.split("-")[1]) for n in names)
    cut = cols[int(len(cols) * 0.85)]
    val_names = [n for n in names if int(n.split("-")[1]) >= cut]
  else:
    val_names = args.val.split(",")
    missing = [v for v in val_names if v not in tiles]
    if missing:
      raise SystemExit(f"val tiles not found: {missing}")
  train_names = [n for n in names if n not in set(val_names)]
  print(f"tiles: {len(train_names)} train / {len(val_names)} val  device: {device}", flush=True)

  # inverse-sqrt-frequency class weights from the train split (snow/water
  # never train the class head; plain inverse-freq over-boosts 1%-share grass)
  counts = np.zeros(N_CLASSES)
  for n in train_names:
    t = tiles[n]
    sel = (t["cls_mask"] > 0) & (t["cls"] != SNOW_IDX)
    counts += np.bincount(t["cls"][sel].ravel(), minlength=N_CLASSES)
  used = counts > 0
  w = np.zeros(N_CLASSES, dtype=np.float32)
  w[used] = (counts[used].sum() / counts[used]) ** 0.5
  w[used] /= w[used].mean()
  class_w = torch.tensor(w, device=device)
  print("class weights: " + "  ".join(
    f"{n}={v:.2f}" for n, v in zip(FIELD_NAMES, w)), flush=True)

  in_ch = 3 + (len(TERRAIN_KEYS) if use_terrain else 0) + (N_CLASSES if use_gcls else 0)
  model = UNet(in_ch).to(device)
  print(f"model: {sum(p.numel() for p in model.parameters())/1e6:.2f}M params, in_ch={in_ch}")
  opt = torch.optim.AdamW(model.parameters(), lr=args.lr)
  sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, args.steps)

  t0 = time.monotonic()
  for step in range(1, args.steps + 1):
    x, y, k, m, cm = sample_batch(rng, tiles, train_names, feats, args.batch, args.patch)
    x, y, k, m, cm = x.to(device), y.to(device), k.to(device), m.to(device), cm.to(device)
    rgb, logits = model(x)
    l1 = (torch.abs(rgb - y) * m).sum() / (m.sum() * 3 + 1e-6)
    cm = cm * (k != SNOW_IDX).float()
    ce = (F.cross_entropy(logits, k, weight=class_w, reduction="none") * cm).sum() / (cm.sum() + 1e-6)
    loss = l1 + args.cls_weight * ce
    opt.zero_grad()
    loss.backward()
    opt.step()
    sched.step()
    if step % 500 == 0 or step == 1:
      vm = eval_tiles(model, tiles, val_names, feats, device)
      elapsed = time.monotonic() - t0
      eta_min = elapsed / step * (args.steps - step) / 60
      print(f"step {step:5d}/{args.steps} ({100 * step // args.steps:3d}%, "
            f"eta {eta_min:.0f}m)  train L1 {l1.item():.4f} CE {ce.item():.4f}  "
            f"val L1 {vm['l1']:.4f} (S {vm['l1_south']:.4f} N {vm['l1_north']:.4f}) "
            f"cls acc {vm['cls_acc']:.3f}", flush=True)

  vm = eval_tiles(model, tiles, val_names, feats, device)
  run_dir = data_root / "runs" / (args.name or args.channels.replace("+", "_"))
  run_dir.mkdir(parents=True, exist_ok=True)
  torch.save(model.state_dict(), run_dir / "model.pt")
  (run_dir / "metrics.json").write_text(json.dumps(
    {"channels": args.channels, "data": str(data_root), "val_tiles": val_names,
     "steps": args.steps, **vm}, indent=1))
  for n in val_names[:6]:
    save_composite(model, tiles[n], feats, device,
                   run_dir / f"val_{n}_coarse_pred_cls_google.png")
  print(f"final: val L1 {vm['l1']:.4f}  south {vm['l1_south']:.4f}  "
        f"north {vm['l1_north']:.4f}  cls acc {vm['cls_acc']:.3f}")
  print(f"run dir: {run_dir}")


if __name__ == "__main__":
  main()
