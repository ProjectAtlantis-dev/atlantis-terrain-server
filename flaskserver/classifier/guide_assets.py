"""LAAS asset-guide extraction from Google reference tiles.

Workflow (see LAAS_ASSETS.md):
  1. Browse pipeline.html, find representative ground, note tile ids.
  2. venv/bin/python guide_assets.py <tile_id> [...] --zoom 17
  3. Open sample/laas_guide/index.html and eyeball the class overlays,
     detected bush instances, palettes and scatter stats.
  4. Numbers you approve graduate into vegetation.js / LAAS builder params
     via sample/laas_guide/manifest.json.

Per tile this emits: google.png, ours.png, classes.png (class tint overlay),
bushes.png (detected shrub outlines), guide.json (palettes + scatter stats).
The gallery index.html and aggregate manifest.json are regenerated over all
analyzed tiles on every run.

Google imagery is a measurement guide only — colors/densities feed procedural
builders; the pixels themselves never ship. sample/ is gitignored.
"""
import io
import json
import sqlite3
import sys
from pathlib import Path
from typing import cast

import numpy as np
from PIL import Image
from scipy import ndimage

from biomes import VEG_MIN_SOUTHNESS
from database import GRID_N, _decompress_float32
from google_ref import get_google_ref, init_google_refs
from training_data import _upsample_f32, terrain_channels

CLASS_NAMES = ["rock", "heath", "lush", "snow", "water"]
CLASS_TINTS = {  # gallery overlay colors (sRGB)
  "rock": (170, 170, 170),
  "heath": (230, 140, 40),
  "lush": (60, 220, 60),
  "snow": (255, 255, 255),
  "water": (40, 90, 255),
}


def classify(rgb, veg_dead_zone=0.02, lush_thresh=0.12, southness=None):
  """Per-pixel ground classes on GOOGLE imagery (no SPOT olive cast, so the
  excess-green dead zone is lower than vegetation.js's 0.06). Returns a
  class-index map (CLASS_NAMES order) plus the veg weight map.

  southness: optional float (H, W) DEM aspect channel, image-oriented. When
  given, ALL vegetation (heath and lush alike) is masked out against north
  slopes (VEG_MIN_SOUTHNESS, same rule as biomes.py) BEFORE any measurement:
  cast shadows all face north, and their green cast otherwise counts as lush
  blobs — inflating bush density and polluting palettes with shade tint."""
  a = rgb.astype(np.float32)
  r, g, b = a[..., 0], a[..., 1], a[..., 2]
  bright = a.mean(-1)
  sat = a.max(-1) - a.min(-1)
  eg = (2 * g - r - b) / 255

  snow = (bright > 190) & (sat < 30)
  # blue-dominant OR dark-and-desaturated-bluish (deep fjord water reads
  # near-black in Google; teal silt water has g≈b and needs the b>=g-4 arm)
  water = ((b > r + 12) & (b > g + 6)) | ((bright < 55) & (b >= g - 4) & (b > r))
  veg = np.clip((eg - veg_dead_zone) * 4.2, 0, 1)
  veg[snow | water] = 0
  lush = (eg > lush_thresh) & ~snow & ~water
  if southness is not None:
    south_ok = southness >= VEG_MIN_SOUTHNESS
    veg[~south_ok] = 0
    lush &= south_ok

  cls = np.zeros(rgb.shape[:2], dtype=np.uint8)          # rock
  cls[veg > 0.25] = 1                                    # heath
  cls[lush] = 2                                          # lush
  cls[snow] = 3
  cls[water] = 4
  return cls, veg


def kmeans_palette(pixels, k=4, iters=12):
  """Tiny k-means over Nx3 sRGB pixels -> list of {hex, srgb, linear, share}."""
  if len(pixels) < k:
    return []
  px = pixels.astype(np.float32)
  # init on brightness quantiles for stable, spread-out seeds
  order = np.argsort(px.sum(1))
  cent = px[order[np.linspace(0, len(px) - 1, k).astype(int)]].copy()
  for _ in range(iters):
    d = ((px[:, None, :] - cent[None]) ** 2).sum(-1)
    lab = d.argmin(1)
    for i in range(k):
      sel = px[lab == i]
      if len(sel):
        cent[i] = sel.mean(0)
  counts = np.bincount(lab, minlength=k).astype(float)
  out = []
  for i in np.argsort(-counts):
    c = cent[i]
    srgb = [round(float(v) / 255, 4) for v in c]
    out.append({
      "hex": "#%02x%02x%02x" % tuple(int(v) for v in c),
      "srgb": srgb,
      "linear": [round(v ** 2.2, 4) for v in srgb],   # for three.js Color
      "share": round(float(counts[i] / counts.sum()), 3),
    })
  return out


def bush_stats(cls, mpp, max_diam_m=8.0):
  """Detect individual shrub/bush instances as connected lush blobs and
  measure the numbers the scatter needs: density, size distribution,
  clumping (Clark-Evans R: <1 clumped, ~1 Poisson random)."""
  lush = cls == 2
  labels, n = cast(tuple[np.ndarray, int], ndimage.label(lush))
  if n == 0:
    return None, labels
  sizes = ndimage.sum_labels(lush, labels, np.arange(1, n + 1))
  max_px = (max_diam_m / mpp) ** 2
  keep = np.where((sizes >= 2) & (sizes <= max_px))[0] + 1
  if len(keep) == 0:
    return None, labels
  # zero out non-kept blobs in the label map (edge overlay uses it)
  keep_mask = np.isin(labels, keep)
  labels = labels * keep_mask

  centroids = np.array(ndimage.center_of_mass(lush, labels, keep))
  diam_m = 2 * np.sqrt(sizes[keep - 1] / np.pi) * mpp

  # nearest-neighbor distances (brute force; cap for pathological counts)
  pts = centroids[:5000] * mpp
  if len(pts) >= 2:
    d2 = ((pts[:, None, :] - pts[None]) ** 2).sum(-1)
    np.fill_diagonal(d2, np.inf)
    nn = np.sqrt(d2.min(1))
    area_m2 = cls.size * mpp * mpp
    dens = len(keep) / area_m2
    clark_evans = float(nn.mean() / (0.5 / np.sqrt(dens)))
    nn_mean = float(nn.mean())
  else:
    clark_evans, nn_mean = None, None

  area_m2 = cls.size * mpp * mpp
  # density normalized to lush ground area — what the scatter actually needs,
  # since its lushness gate already restricts where shrubs can land
  lush_m2 = max(1.0, float(lush.sum()) * mpp * mpp)
  return {
    "count": int(len(keep)),
    "density_per_100m2": round(len(keep) / area_m2 * 100, 2),
    "density_per_100m2_of_lush": round(len(keep) / lush_m2 * 100, 2),
    "diameter_m": {
      "mean": round(float(diam_m.mean()), 2),
      "p25": round(float(np.percentile(diam_m, 25)), 2),
      "p75": round(float(np.percentile(diam_m, 75)), 2),
      "max": round(float(diam_m.max()), 2),
    },
    "nn_dist_m_mean": round(nn_mean, 2) if nn_mean else None,
    "clark_evans_R": round(clark_evans, 2) if clark_evans else None,
  }, labels


def boulder_stats(goog, cls, mpp, min_diam_m=1.0, max_diam_m=5.0):
  """Detect individual boulders as compact dark blobs on rock ground (a
  boulder + its shadow reads darker than the surrounding rock face) and
  measure the numbers the rock scatter needs — same stats as bush_stats but
  normalized to rocky ground area."""
  rock = cls == 0
  lum = goog.astype(np.float32).mean(-1)
  # local background over ~6 m so hillside-scale shading doesn't count
  bg = ndimage.uniform_filter(lum, max(3, int(round(6.0 / mpp)) | 1))
  dark = rock & (lum < bg - 20)
  labels, n = cast(tuple[np.ndarray, int], ndimage.label(dark))
  if n == 0:
    return None, labels
  idx = np.arange(1, n + 1)
  sizes = ndimage.sum_labels(dark, labels, idx)
  area_win = (max(4.0, np.pi * (min_diam_m / 2) ** 2 / (mpp * mpp)),
              np.pi * (max_diam_m / 2) ** 2 / (mpp * mpp))
  # compactness gate: elongated cast shadows / cracks fill little of their
  # bounding box, boulders fill most of it
  objs = ndimage.find_objects(labels)
  fill = np.array([sizes[i - 1] / ((objs[i - 1][0].stop - objs[i - 1][0].start) *
                                   (objs[i - 1][1].stop - objs[i - 1][1].start))
                   for i in idx])
  keep = idx[(sizes >= area_win[0]) & (sizes <= area_win[1]) & (fill > 0.5)]
  if len(keep) == 0:
    return None, labels * 0
  labels = labels * np.isin(labels, keep)

  centroids = np.array(ndimage.center_of_mass(dark, labels, keep))
  diam_m = 2 * np.sqrt(sizes[keep - 1] / np.pi) * mpp
  rock_m2 = max(1.0, float(rock.sum()) * mpp * mpp)

  pts = centroids[:5000] * mpp
  if len(pts) >= 2:
    d2 = ((pts[:, None, :] - pts[None]) ** 2).sum(-1)
    np.fill_diagonal(d2, np.inf)
    nn = np.sqrt(d2.min(1))
    dens = len(keep) / rock_m2
    clark_evans = float(nn.mean() / (0.5 / np.sqrt(dens)))
    nn_mean = float(nn.mean())
  else:
    clark_evans, nn_mean = None, None

  return {
    "count": int(len(keep)),
    "density_per_100m2_of_rock": round(len(keep) / rock_m2 * 100, 2),
    "diameter_m": {
      "mean": round(float(diam_m.mean()), 2),
      "p25": round(float(np.percentile(diam_m, 25)), 2),
      "p75": round(float(np.percentile(diam_m, 75)), 2),
      "max": round(float(diam_m.max()), 2),
    },
    "nn_dist_m_mean": round(nn_mean, 2) if nn_mean else None,
    "clark_evans_R": round(clark_evans, 2) if clark_evans else None,
  }, labels


def scree_stats(goog, cls, mpp, min_patch_m2=30.0):
  """Scree/talus share of rock ground + patch geometry for the talus-field
  generator. Single-scale texture can NOT separate scree from Greenland
  bedrock (fractured bedrock is equally granular at 2 m) — talus is granular
  at fine scale but HOMOGENEOUS at coarse scale (smooth pale aprons/fans),
  while bedrock carries joint/face structure at 10-20 m. Both scales are
  measured at a fixed 0.5 m/px reference so thresholds hold across zooms."""
  rock = cls == 0
  if not rock.any():
    return None, np.zeros(cls.shape, bool)
  lum = goog.astype(np.float32).mean(-1)
  h, w = lum.shape
  sz = (max(8, int(w * mpp / 0.5)), max(8, int(h * mpp / 0.5)))
  lum05 = np.array(Image.fromarray(lum, mode="F").resize(sz, Image.Resampling.BILINEAR))
  fine_sm = ndimage.uniform_filter(lum05, 5)          # 2.5 m window
  tex_fine = np.sqrt(np.maximum(0.0, ndimage.uniform_filter(lum05 * lum05, 5) - fine_sm ** 2))
  cmean = ndimage.uniform_filter(fine_sm, 25)         # 12.5 m window
  tex_coarse = np.sqrt(np.maximum(0.0, ndimage.uniform_filter(fine_sm ** 2, 25) - cmean ** 2))
  scree05 = (tex_fine > 12) & (tex_coarse < 18) & (lum05 > 90)
  granular = rock & (np.array(Image.fromarray(scree05.astype(np.float32), mode="F")
                              .resize((w, h), Image.Resampling.BILINEAR)) > 0.5)

  labels, n = cast(tuple[np.ndarray, int], ndimage.label(granular))
  patches_m2 = []
  if n:
    sizes = ndimage.sum_labels(granular, labels, np.arange(1, n + 1)) * mpp * mpp
    patches_m2 = sizes[sizes >= min_patch_m2]
  rock_m2 = float(rock.sum()) * mpp * mpp
  return {
    "share_of_rock": round(float(granular.sum() / rock.sum()), 3),
    "patch_count": int(len(patches_m2)),
    "patch_m2": {
      "p50": round(float(np.percentile(patches_m2, 50)), 1),
      "p90": round(float(np.percentile(patches_m2, 90)), 1),
      "max": round(float(np.max(patches_m2)), 1),
    } if len(patches_m2) else None,
  }, granular


def _blob_edges(labels):
  return (labels > 0) & (
    (np.roll(labels, 1, 0) != labels) | (np.roll(labels, 1, 1) != labels) |
    (np.roll(labels, -1, 0) != labels) | (np.roll(labels, -1, 1) != labels))


def analyze_tile(db, tid, out_root, zoom=None, res=640, refresh=False):
  row = db.execute(
    "SELECT t.x_min, t.y_min, t.x_max, t.y_max, x.texture, t.heightmap "
    "FROM tiles t LEFT JOIN textures x ON x.tile_id = t.tile_id "
    "WHERE t.tile_id = ?",
    (tid,),
  ).fetchone()
  if row is None:
    print(f"{tid}: not in tiles table, skipping")
    return None
  bbox, ours_blob, hm_blob = row[:4], row[4], row[5]
  mpp = (bbox[2] - bbox[0]) / res

  # DEM aspect for the north-slope vegetation mask (see classify); DB
  # heightmaps are row 0 = south, flip to image orientation like
  # training_data.export_tile does
  southness = None
  if hm_blob is not None:
    hm = _decompress_float32(hm_blob, (GRID_N, GRID_N))
    southness = _upsample_f32(
      terrain_channels(hm, bbox[2] - bbox[0])["southness"], res)[::-1]
  else:
    print(f"{tid}: no heightmap — aspect mask OFF, north-shadow green will "
          f"count as vegetation")

  jpeg, z = get_google_ref(db, tid, bbox, resolution=res, zoom=zoom, refresh=refresh)
  if jpeg is None:
    print(f"{tid}: google fetch failed")
    return None
  goog = np.array(Image.open(io.BytesIO(jpeg)).convert("RGB"))

  cls, veg = classify(goog, southness=southness)
  shares = {name: round(float((cls == i).mean()), 4) for i, name in enumerate(CLASS_NAMES)}

  palettes = {}
  for i, name in enumerate(CLASS_NAMES):
    sel = goog[cls == i]
    if len(sel) > 200:  # too few pixels -> palette is noise
      step = max(1, len(sel) // 20000)
      palettes[name] = kmeans_palette(sel[::step])

  bushes, labels = bush_stats(cls, mpp)
  boulders, blabels = boulder_stats(goog, cls, mpp)
  scree, granular = scree_stats(goog, cls, mpp)

  d = out_root / tid
  d.mkdir(parents=True, exist_ok=True)
  Image.fromarray(goog).save(d / "google.png")
  if ours_blob is not None:
    (Image.open(io.BytesIO(ours_blob)).convert("RGB")
     .resize((res, res), Image.Resampling.LANCZOS).save(d / "ours.png"))

  # class overlay: dimmed google + class tints
  tint = np.zeros_like(goog)
  for i, name in enumerate(CLASS_NAMES):
    tint[cls == i] = CLASS_TINTS[name]
  Image.fromarray((goog * 0.45 + tint * 0.55).astype(np.uint8)).save(d / "classes.png")

  # bush overlay: red edges around detected instances
  bush_img = goog.copy()
  bush_img[_blob_edges(labels)] = (255, 40, 40)
  Image.fromarray(bush_img).save(d / "bushes.png")

  # rock overlay: scree fields tinted sand, boulder instances edged red
  rock_img = goog.astype(np.float32)
  rock_img[granular] = rock_img[granular] * 0.55 + np.array((205, 170, 110)) * 0.45
  rock_img = rock_img.astype(np.uint8)
  rock_img[_blob_edges(blabels)] = (255, 40, 40)
  Image.fromarray(rock_img).save(d / "rocks.png")

  guide = {
    "tile": tid,
    "google_zoom": z,
    "m_per_px": round(mpp, 3),
    "class_shares": shares,
    "palettes": palettes,
    "bushes": bushes,
    "boulders": boulders,
    "scree": scree,
  }
  (d / "guide.json").write_text(json.dumps(guide, indent=1))
  b, bo, sc = bushes or {}, boulders or {}, scree or {}
  print(f"{tid}: z={z} {mpp:.2f} m/px  shares={ {k: v for k, v in shares.items() if v > 0.01} }  "
        f"bushes={b.get('count', 0)} (density {b.get('density_per_100m2', 0)}/100m2, "
        f"R={b.get('clark_evans_R')})  boulders={bo.get('count', 0)} "
        f"({bo.get('density_per_100m2_of_rock', 0)}/100m2 rock, R={bo.get('clark_evans_R')})  "
        f"scree share={sc.get('share_of_rock')}")
  return guide


def write_gallery(out_root):
  """Regenerate index.html + manifest.json over every analyzed tile dir."""
  guides = []
  for gj in sorted(out_root.glob("*/guide.json")):
    guides.append(json.loads(gj.read_text()))

  # aggregate manifest: class-share-weighted palette pool + pooled bush stats
  manifest = {"tiles": [g["tile"] for g in guides], "classes": {}}
  for name in CLASS_NAMES:
    pool = []
    for g in guides:
      for sw in g["palettes"].get(name, []):
        pool.append({**sw, "weight": round(sw["share"] * g["class_shares"][name], 4),
                     "tile": g["tile"]})
    pool.sort(key=lambda s: -s["weight"])
    manifest["classes"][name] = {"palette": pool[:8]}
  bs = [g["bushes"] for g in guides if g.get("bushes")]
  if bs:
    manifest["bushes"] = {
      "density_per_100m2_mean": round(float(np.mean([b["density_per_100m2"] for b in bs])), 2),
      "density_per_100m2_of_lush_mean": round(float(np.mean(
        [b["density_per_100m2_of_lush"] for b in bs if b.get("density_per_100m2_of_lush")])), 2),
      "diameter_m_mean": round(float(np.mean([b["diameter_m"]["mean"] for b in bs])), 2),
      "diameter_m_p25_mean": round(float(np.mean([b["diameter_m"]["p25"] for b in bs])), 2),
      "diameter_m_p75_mean": round(float(np.mean([b["diameter_m"]["p75"] for b in bs])), 2),
      "clark_evans_R_mean": round(float(np.mean(
        [b["clark_evans_R"] for b in bs if b["clark_evans_R"]])), 2),
    }
  bos = [g["boulders"] for g in guides if g.get("boulders")]
  if bos:
    manifest["boulders"] = {
      "density_per_100m2_of_rock_mean": round(float(np.mean(
        [b["density_per_100m2_of_rock"] for b in bos])), 2),
      "diameter_m_mean": round(float(np.mean([b["diameter_m"]["mean"] for b in bos])), 2),
      "diameter_m_p25_mean": round(float(np.mean([b["diameter_m"]["p25"] for b in bos])), 2),
      "diameter_m_p75_mean": round(float(np.mean([b["diameter_m"]["p75"] for b in bos])), 2),
      "clark_evans_R_mean": round(float(np.mean(
        [b["clark_evans_R"] for b in bos if b["clark_evans_R"]])), 2),
    }
  scs = [g["scree"] for g in guides if g.get("scree")]
  if scs:
    manifest["scree"] = {
      "share_of_rock_mean": round(float(np.mean([s["share_of_rock"] for s in scs])), 3),
      "patch_m2_p50_mean": round(float(np.mean(
        [s["patch_m2"]["p50"] for s in scs if s.get("patch_m2")])), 1) if any(
        s.get("patch_m2") for s in scs) else None,
    }
  (out_root / "manifest.json").write_text(json.dumps(manifest, indent=1))

  # publish for the frontend: vegetation.js fetches /laas_guide.json at init
  # (derived numbers only — no Google imagery — so this one IS committable)
  public_dir = Path(__file__).parent.parent / "webserver" / "public"
  if public_dir.is_dir():
    (public_dir / "laas_guide.json").write_text(json.dumps(manifest, indent=1))
    print(f"published: {public_dir / 'laas_guide.json'}")

  rows = []
  for g in guides:
    tid = g["tile"]
    sw_html = ""
    for name in CLASS_NAMES:
      pal = g["palettes"].get(name)
      if not pal:
        continue
      chips = "".join(
        f'<span class="chip" style="background:{s["hex"]}" title="{s["hex"]} share {s["share"]}"></span>'
        for s in pal)
      sw_html += f'<div class="pal"><span class="pname">{name} {g["class_shares"][name]*100:.0f}%</span>{chips}</div>'
    b = g.get("bushes")
    bush_txt = (f'{b["count"]} bushes &middot; {b["density_per_100m2"]}/100m&sup2; &middot; '
                f'&oslash; {b["diameter_m"]["mean"]}m (p25 {b["diameter_m"]["p25"]} / p75 {b["diameter_m"]["p75"]}) &middot; '
                f'NN {b["nn_dist_m_mean"]}m &middot; R={b["clark_evans_R"]}') if b else "no bush instances"
    bo, sc = g.get("boulders"), g.get("scree")
    rock_txt = ((f'{bo["count"]} boulders &middot; {bo["density_per_100m2_of_rock"]}/100m&sup2; rock &middot; '
                 f'&oslash; {bo["diameter_m"]["mean"]}m (p25 {bo["diameter_m"]["p25"]} / p75 {bo["diameter_m"]["p75"]}) &middot; '
                 f'R={bo["clark_evans_R"]}') if bo else "no boulder instances") + (
                f' &nbsp;|&nbsp; scree {sc["share_of_rock"]*100:.0f}% of rock'
                + (f', patch p50 {sc["patch_m2"]["p50"]}m&sup2;' if sc.get("patch_m2") else "")
                if sc else "")
    imgs = "".join(
      f'<a href="{tid}/{n}.png" target="_blank"><figure><img src="{tid}/{n}.png" loading="lazy"><figcaption>{n}</figcaption></figure></a>'
      for n in ("ours", "google", "classes", "bushes", "rocks") if (out_root / tid / f"{n}.png").exists())
    rows.append(f"""
  <section>
    <h2>{tid} <small>z{g["google_zoom"]} &middot; {g["m_per_px"]} m/px &middot;
      <a href="http://localhost:5173/pipeline.html?tile={tid}">open in compare</a></small></h2>
    <div class="imgs">{imgs}</div>
    <div class="meta">{sw_html}<div class="bush">{bush_txt}</div><div class="rock">{rock_txt}</div></div>
  </section>""")

  html = f"""<!DOCTYPE html><html><head><meta charset="utf-8"><title>LAAS asset guide</title>
<style>
  body {{ margin:0; padding:16px; background:#0a1018; color:#dbe5f1;
         font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }}
  h1 {{ color:#5af; font-size:16px; }} h2 {{ font-size:14px; margin:0 0 6px; }}
  h2 small {{ color:#6889a8; font-weight:normal; }} a {{ color:#5af; }}
  section {{ margin-bottom:28px; border-bottom:1px solid #1e2d3a; padding-bottom:16px; }}
  .imgs {{ display:flex; gap:8px; flex-wrap:wrap; }}
  figure {{ margin:0; }} figcaption {{ text-align:center; color:#6889a8; }}
  .imgs img {{ width:300px; height:300px; object-fit:cover; border:1px solid #1e2d3a; display:block; }}
  .pal {{ display:flex; align-items:center; gap:3px; margin-top:6px; }}
  .pname {{ width:110px; color:#6889a8; }}
  .chip {{ width:34px; height:18px; border:1px solid #000; display:inline-block; }}
  .bush {{ margin-top:8px; color:#9ec27f; }}
  .rock {{ margin-top:4px; color:#c2a97f; }}
</style></head><body>
<h1>LAAS asset guide — Google-referenced palettes &amp; scatter stats</h1>
<p>columns: our texture / google reference / class overlay
(grey=rock, orange=heath, green=lush, white=snow, blue=water) / detected bush
instances / rock detail (scree tinted sand, boulders edged red).
Aggregate numbers in <a href="manifest.json">manifest.json</a>.</p>
{"".join(rows)}
</body></html>"""
  (out_root / "index.html").write_text(html)
  print(f"gallery: {out_root / 'index.html'}  manifest: {out_root / 'manifest.json'}")


def main(argv):
  import argparse
  import os
  db_path = os.environ.get("TERRAIN_DB_PATH", "").strip() or str(Path(__file__).parent / "terrain.db")
  ap = argparse.ArgumentParser(description="Extract LAAS asset-guide palettes and "
                                           "scatter stats from Google reference tiles.")
  ap.add_argument("tile_ids", nargs="*", help="tiles to (re)analyze; omit to just rebuild the gallery")
  ap.add_argument("--zoom", type=int, default=None, help="force Google zoom (e.g. 17)")
  ap.add_argument("--res", type=int, default=640, help="analysis resolution px (default 640)")
  ap.add_argument("--out", default=str(Path(__file__).parent.parent / "sample" / "laas_guide"))
  ap.add_argument("--refresh", action="store_true", help="re-fetch Google imagery")
  ap.add_argument("--db", default=db_path)
  args = ap.parse_args(argv)

  out_root = Path(args.out)
  out_root.mkdir(parents=True, exist_ok=True)
  db = sqlite3.connect(args.db)
  init_google_refs(db)
  for tid in args.tile_ids:
    analyze_tile(db, tid, out_root, zoom=args.zoom, res=args.res, refresh=args.refresh)
  write_gallery(out_root)


if __name__ == "__main__":
  main(sys.argv[1:])
