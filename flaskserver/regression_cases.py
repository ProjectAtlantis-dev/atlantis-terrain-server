#!/usr/bin/env python3
"""User-flagged classifier regression cases.

The case list is ``regression_cases.json`` (committed) and is curated by
the USER — from the 3D client's right-click tile menu in gridlines mode
(⚑ flag regression → POST /api/regression/cases, which bakes the case
immediately) or by editing the JSON. Do not seed cases programmatically.

Baking runs the full verification pipeline (classifier_verify.verify_tile:
ladder debug steps, Google reference, Asiaq overlay, metrics) into
``sample/regression/<tile>/`` and rebuilds the gallery page served at
``/api/regression/``. Rerun after every classifier change:

    venv/bin/python regression_cases.py
"""
from __future__ import annotations

import datetime
import json
import os
import sqlite3
import sys

CASES_PATH = os.path.join(os.path.dirname(__file__), "regression_cases.json")
OUT_DIR = os.path.join(os.path.dirname(__file__), "sample", "regression")
DB_PATH = os.path.join(os.path.dirname(__file__), "terrain.db")


def load_cases():
    if not os.path.exists(CASES_PATH):
        return []
    with open(CASES_PATH) as handle:
        return json.load(handle)


def save_cases(cases):
    with open(CASES_PATH, "w") as handle:
        json.dump(cases, handle, indent=2)
        handle.write("\n")


def add_case(tile_id, note=""):
    """Add or update a flagged case. Returns the full case list."""
    cases = load_cases()
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    for case in cases:
        if case["tile"] == tile_id:
            if note:
                case["note"] = note
            case["flagged_at"] = now
            break
    else:
        cases.append({"tile": tile_id, "note": note, "flagged_at": now})
    save_cases(cases)
    return cases


def bake_case(db, case):
    """Bake one case's panels + metrics. Returns metrics or None."""
    from classifier_verify import verify_tile

    return verify_tile(db, case["tile"], OUT_DIR)


def build_gallery(baked):
    """baked: list of (case, metrics-or-None)."""
    from classifier_verify import _PANELS, _metric_line

    rows = []
    for case, metrics in baked:
        tile = case["tile"]
        if metrics is None:
            body = "<td><i>not bakeable (no real texture/heightmap)</i></td>"
            line = ""
        else:
            body = "".join(
                f'<td><img src="{tile}/{fname}" loading="lazy">'
                f"<div>{label}</div></td>"
                for fname, label in _PANELS
                if os.path.exists(os.path.join(OUT_DIR, tile, fname))
            )
            line = _metric_line(metrics)
        note = case.get("note") or ""
        rows.append(
            f"<tr><th><a href='/training.html?tile={tile}'>{tile}</a>"
            f"<div class=n>⚑ {note}</div><div class=m>{line}</div></th>"
            f"{body}</tr>"
        )
    html = (
        "<!doctype html><meta charset=utf-8>"
        "<title>classifier regression cases</title>"
        "<style>body{background:#111;color:#ddd;font-family:sans-serif}"
        "img{width:220px;display:block}"
        "td,th{padding:4px;text-align:left;vertical-align:top}"
        "th{max-width:240px;font-weight:normal}th a{color:#5af}"
        ".n{color:#f7b955;font-size:12px}.m{color:#8fb0cc;font-size:12px}"
        "td div{color:#6889a8;font-size:11px;text-align:center}</style>"
        "<h1>Classifier regression cases</h1>"
        "<p>Flagged by the user from the 3D client (gridlines mode → "
        "right-click → ⚑) or training.html. Rerun after every classifier "
        "change: <code>venv/bin/python regression_cases.py</code></p>"
        + (
            f"<table>{''.join(rows)}</table>" if rows
            else "<p>No cases yet. Flag a broken tile from the 3D client "
                 "(gridlines mode, right-click) or edit "
                 "regression_cases.json.</p>"
        )
    )
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "index.html"), "w") as handle:
        handle.write(html)


def _metrics_from_disk(tile_id):
    path = os.path.join(OUT_DIR, tile_id, "metrics.json")
    if not os.path.exists(path):
        return None
    with open(path) as handle:
        return json.load(handle)


def bake_and_rebuild(db, tile_id=None):
    """Bake one case (or all when tile_id is None), rebuild the gallery.

    The gallery always lists every case, using metrics already on disk for
    cases not rebaked this call — so flagging one tile from the client
    stays fast no matter how long the case list grows.
    """
    cases = load_cases()
    to_bake = cases if tile_id is None else [
        case for case in cases if case["tile"] == tile_id
    ]
    for case in to_bake:
        bake_case(db, case)
    baked = [(case, _metrics_from_disk(case["tile"])) for case in cases]
    build_gallery(baked)
    return baked


def rebake_all(db):
    return bake_and_rebuild(db)


def main():
    db = sqlite3.connect(DB_PATH)
    baked = rebake_all(db)
    ok = sum(1 for _, metrics in baked if metrics is not None)
    print(
        f"baked {ok}/{len(baked)} cases → {os.path.join(OUT_DIR, 'index.html')}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
