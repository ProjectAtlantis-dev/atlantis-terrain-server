"""Classifier regression gallery — known-problem tiles, curated from pipeline.html.

Every classifier change must be eyeballed against these cases. The case list
lives in regression_cases.json (committed): tile id + one line describing
what is wrong there. Add cases with the "flag regression" button on
pipeline.html (POST /api/regression/cases), or by editing the JSON. Never
remove a case because it currently passes.

Each bake reruns classify_coarse with step tracing and writes a web gallery:
google ref, every traced step mask, DEM channels, final overlay. Served at
/api/regression/ (linked from pipeline.html and coverage.html).

CLI (from flaskserver/):
    venv/bin/python -m classifier.regression_cases            # bake all cases
    venv/bin/python -m classifier.regression_cases 12-1373-784 --res 1024

Writes sample/regression/<tid>/*.png + case.json, and
sample/regression/index.html.
"""
import argparse
import html
import io
import json
import os
import sqlite3
import sys
from pathlib import Path

import numpy as np
from PIL import Image

from classifier.biomes import COARSE_NAMES, TINTS, class_overlay, classify_coarse
from database import GRID_N, _decompress_float32
from google_ref import get_google_ref, init_google_refs
from classifier.training_data import _upsample_f32, render_channel, terrain_channels

CASES_PATH = Path(__file__).parent / "regression_cases.json"
OUT_ROOT = Path(__file__).parent.parent / "sample" / "regression"


def load_cases():
  """[{tile, note}, ...] in curation order."""
  if CASES_PATH.is_file():
    return json.loads(CASES_PATH.read_text())
  return []


def add_case(tid, note):
  """Add (or update the note of) a case. Returns the new case count."""
  cases = [c for c in load_cases() if c["tile"] != tid]
  cases.append({"tile": tid, "note": note})
  CASES_PATH.write_text(json.dumps(cases, indent=1) + "\n")
  return len(cases)


def run_case(db, tid, note, res=512):
  """Bake one case: step PNGs + overlay + case.json. Returns the case dict."""
  bbox = db.execute(
    "SELECT x_min, y_min, x_max, y_max FROM tiles WHERE tile_id = ?",
    (tid,)).fetchone()
  hm_blob = db.execute(
    "SELECT heightmap FROM tiles WHERE tile_id = ?", (tid,)).fetchone()
  if bbox is None or hm_blob is None or hm_blob[0] is None:
    print(f"{tid}: missing tile/heightmap, skipping", flush=True)
    return None
  jpeg, zoom = get_google_ref(db, tid, bbox, resolution=res)
  if jpeg is None:
    print(f"{tid}: google fetch failed, skipping", flush=True)
    return None
  rgb = np.array(Image.open(io.BytesIO(jpeg)).convert("RGB")
                 .resize((res, res), Image.Resampling.LANCZOS))
  hm = _decompress_float32(hm_blob[0], (GRID_N, GRID_N))
  tile_m = bbox[2] - bbox[0]
  chans = {k: _upsample_f32(v, res)[::-1].copy()
           for k, v in terrain_channels(hm, tile_m).items()}

  trace = {}
  cls = classify_coarse(rgb, slope=chans["slope"], elev=chans["elev"],
                        trace=trace)

  d = OUT_ROOT / tid
  d.mkdir(parents=True, exist_ok=True)
  Image.fromarray(rgb).save(d / "google.png")
  for chan in ("elev", "slope"):
    Image.fromarray(render_channel(chans, chan)).save(d / f"{chan}.png")
  step_names = []
  for name, mask in trace.items():
    if name == "90_classes":
      continue
    Image.fromarray((mask.astype(np.uint8)) * 255).save(d / f"{name}.png")
    step_names.append(name)
  Image.fromarray(class_overlay(rgb, cls, names=COARSE_NAMES)).save(
    d / "overlay.png")
  shares = {n: round(float((cls == i).mean()), 3)
            for i, n in enumerate(COARSE_NAMES)}
  case = {"tile": tid, "note": note, "steps": step_names, "shares": shares,
          "zoom": zoom}
  (d / "case.json").write_text(json.dumps(case, indent=1))
  print(f"{tid}: z={zoom} {tile_m / res:.2f} m/px  shares: {shares}", flush=True)
  return case


def write_gallery():
  """Rebuild index.html from the case list + whatever is baked on disk."""
  key = " ".join(
    f'<span style="background:rgb{TINTS[n]};padding:0 8px">&nbsp;</span> {n}'
    for n in COARSE_NAMES)
  rows = []
  for c in load_cases():
    tid = c["tile"]
    meta_p = OUT_ROOT / tid / "case.json"
    if not meta_p.is_file():
      rows.append(f'<tr><th>{tid}<br><small>{html.escape(c["note"])}</small>'
                  f'</th><td>not baked yet — run regression_cases.py</td></tr>')
      continue
    r = json.loads(meta_p.read_text())
    imgs = ["google.png", "overlay.png", "elev.png", "slope.png"] + [
      f"{s}.png" for s in r["steps"]]
    cells = "".join(
      f'<td><img src="{tid}/{f}" loading="lazy"><br>'
      f'<small>{f.removesuffix(".png")}</small></td>' for f in imgs)
    shares = "  ".join(f"{k} {v:.0%}" for k, v in r["shares"].items()
                       if v >= 0.005)
    rows.append(
      f'<tr><th>{tid}<br><small>{html.escape(c["note"])}</small>'
      f'<br><small style="color:#8fb0cc">{shares}</small>'
      f'<br><small><a href="http://localhost:5173/pipeline.html?tile={tid}">'
      f'pipeline</a></small></th>{cells}</tr>')
  body = (f"<table>{''.join(rows)}</table>" if rows else
          "<p>No cases yet. Flag a broken tile from pipeline.html "
          "(the &#9873; button) or edit regression_cases.json.</p>")
  OUT_ROOT.mkdir(parents=True, exist_ok=True)
  (OUT_ROOT / "index.html").write_text(
    "<!doctype html><meta charset=utf-8><title>classifier regression cases</title>"
    "<style>body{background:#111;color:#ddd;font-family:sans-serif}"
    "img{width:256px;image-rendering:auto}td,th{padding:4px;text-align:left;"
    "vertical-align:top}th{max-width:230px}</style>"
    "<h1>Classifier regression cases</h1>"
    f"<p>coarse buckets: {key}</p>"
    "<p>Rerun after every classifier change: "
    "<code>venv/bin/python -m classifier.regression_cases</code></p>"
    + body)
  print(f"gallery: {OUT_ROOT / 'index.html'}  ({len(rows)} cases)", flush=True)


def bake(db, tile_ids=None, res=512):
  """Bake the requested cases (default: all) and rebuild the gallery."""
  cases = load_cases()
  todo = [c for c in cases
          if (not tile_ids or c["tile"] in tile_ids)
          or not (OUT_ROOT / c["tile"] / "case.json").is_file()]
  for i, c in enumerate(todo, 1):
    print(f"[{i}/{len(todo)}] {c['tile']}", flush=True)
    run_case(db, c["tile"], c["note"], res)
  write_gallery()


def main(argv):
  db_path = os.environ.get("TERRAIN_DB_PATH", "").strip() or str(
    Path(__file__).parent.parent / "terrain.db")
  ap = argparse.ArgumentParser(description="Rebuild the classifier regression gallery.")
  ap.add_argument("tile_ids", nargs="*",
                  help="subset of case tiles to rebake (default: all)")
  ap.add_argument("--res", type=int, default=512)
  ap.add_argument("--db", default=db_path)
  args = ap.parse_args(argv)

  if not load_cases():
    print("no cases in regression_cases.json — flag broken tiles from "
          "pipeline.html first")
    write_gallery()
    return
  db = sqlite3.connect(args.db)
  init_google_refs(db)
  bake(db, args.tile_ids or None, res=args.res)


if __name__ == "__main__":
  main(sys.argv[1:])
