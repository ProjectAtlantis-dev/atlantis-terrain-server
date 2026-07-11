"""Repair driver for the fake-fjord-seamount flattener (bathymetry.py).

Phases (scoped by --tiles / --bbox when given):

0. --refetch: re-ingest the pristine DEM for tiles the pre-versioning
   algorithm mutated destructively (confidence-7 samples but no row in
   bathy_originals — the old code overwrote the only copy of the terrain).
1. FIX: run fix_tile_in_db over every candidate (depth >= MIN_FIX_DEPTH,
   heightmap + real imagery). Repeats passes over the neighbors of changed
   tiles until cross-tile edge seeding converges (a fake apron can cover a
   tile edge-to-edge with no sea of its own — its neighbor's flattened
   water seeds it).
2. PROPAGATE: push corrected tiles up their ancestor chains
   (propagate_to_ancestors also heals stale confidence-7 parent samples
   left behind by earlier algorithm versions).

Usage:
    venv/bin/python fix_fjord_bathymetry.py [--refetch]
        [--tiles 11-703-385,12-1408-770] [--bbox lat0,lon0,lat1,lon1]
        [--db terrain.db]
"""

import argparse
import sqlite3
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np

from bathymetry import (
    BATHY_ALGO_VERSION,
    MIN_FIX_DEPTH,
    _ensure_originals_table,
    fix_tile_in_db,
    propagate_to_ancestors,
)
from database import CONFIDENCE, GRID_N, write_tile, _decompress_uint8

TEX_REAL_SOURCES = ("dataforsyningen", "dataforsyningen_enhanced", "upscaled")
MAX_PASSES = 8
MAX_REQUEUES = 3  # seam pairs can be bistable (two defensible states a few
                  # px apart flip forever under alternating recompute) —
                  # freeze a tile after this many forced revisits


def _bbox_clause(bbox_arg):
    """(sql_fragment, params) intersecting tiles with a lat/lon bbox."""
    if not bbox_arg:
        return "", ()
    from coords import to_stereo

    lat0, lon0, lat1, lon1 = (float(v) for v in bbox_arg.split(","))
    xs, ys = zip(*(to_stereo(la, lo)
                   for la in (lat0, lat1) for lo in (lon0, lon1)))
    return (" AND t.x_max >= ? AND t.x_min <= ? AND t.y_max >= ? AND t.y_min <= ?",
            (min(xs), max(xs), min(ys), max(ys)))


def _progress(i, total, t0, what):
    if i and (i % 25 == 0 or i == total):
        eta = (time.time() - t0) / i * (total - i)
        print(f"  {what}: {i / total * 100:5.1f}%  ({i}/{total})  eta {eta:4.0f}s",
              flush=True)


def refetch_destroyed(db, where, params):
    """Phase 0: restore pristine DEM for legacy-fixed tiles without originals."""
    from ingest import _read_cog_heightmap

    _ensure_originals_table(db)
    rows = db.execute(
        f"SELECT t.tile_id, t.x_min, t.y_min, t.x_max, t.y_max, t.confidence_map"
        f" FROM tiles t WHERE t.depth >= ? AND t.heightmap IS NOT NULL"
        f" AND t.confidence_map IS NOT NULL"
        f" AND t.tile_id NOT IN (SELECT tile_id FROM bathy_originals)"
        f"{where} ORDER BY t.tile_id",
        (MIN_FIX_DEPTH, *params),
    ).fetchall()
    targets = [r for r in rows
               if (_decompress_uint8(r[5], (GRID_N, GRID_N))
                   >= CONFIDENCE['bathymetry']).any()]
    print(f"Phase 0: {len(targets)} legacy-fixed tiles need a DEM refetch", flush=True)
    t0 = time.time()
    refetched, failed = [], 0
    for i, (tid, x0, y0, x1, y1, _) in enumerate(targets, 1):
        try:
            data, src = _read_cog_heightmap((x0, y0, x1, y1))
        except Exception as exc:
            print(f"  {tid}: refetch FAILED: {type(exc).__name__}: {exc}", flush=True)
            data, src = None, None
        if data is None:
            failed += 1
        else:
            conf = CONFIDENCE.get(src, CONFIDENCE['arcticdem'])
            cm = np.where(np.isnan(data), np.uint8(0), np.uint8(conf))
            hm = np.where(np.isnan(data), 0.0, data).astype(np.float32)
            write_tile(db, tid, hm, cm, src, reconcile=False, allow_overwrite=True)
            refetched.append(tid)
        _progress(i, len(targets), t0, "refetch")
    print(f"Phase 0 done: {len(refetched)} restored, {failed} failed", flush=True)
    return refetched


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Repair fake fjord seamounts in cached heightmaps.")
    ap.add_argument("--refetch", action="store_true",
                    help="re-ingest pristine DEM for tiles the legacy fix destroyed")
    ap.add_argument("--tiles", help="comma-separated tile ids to limit the run to")
    ap.add_argument("--bbox", help="lat0,lon0,lat1,lon1 region filter")
    ap.add_argument("--db", default=str(Path(__file__).parent / "terrain.db"))
    args = ap.parse_args()

    db = sqlite3.connect(args.db)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=10000")

    where, params = _bbox_clause(args.bbox)
    if args.tiles:
        ids = [t.strip() for t in args.tiles.split(",") if t.strip()]
        where += f" AND t.tile_id IN ({','.join('?' for _ in ids)})"
        params = (*params, *ids)

    modified: set[str] = set()
    if args.refetch:
        modified.update(refetch_destroyed(db, where, params))

    placeholders = ",".join("?" for _ in TEX_REAL_SOURCES)
    candidates = {
        tid: None for (tid,) in db.execute(
            f"SELECT t.tile_id FROM tiles t"
            f" JOIN textures x ON x.tile_id = t.tile_id"
            f" WHERE t.depth >= ? AND t.heightmap IS NOT NULL"
            f" AND x.source IN ({placeholders}){where}"
            f" ORDER BY t.depth, t.col, t.row",
            (MIN_FIX_DEPTH, *TEX_REAL_SOURCES, *params),
        ).fetchall()
    }
    print(f"Phase 1: {len(candidates)} candidate tiles at depth >= {MIN_FIX_DEPTH} "
          f"with real imagery (algo v{BATHY_ALGO_VERSION})", flush=True)

    queue = list(candidates)
    requeues = Counter()
    t0 = time.time()
    for pass_no in range(1, MAX_PASSES + 1):
        changed = []
        for i, tid in enumerate(queue, 1):
            xrow = db.execute(
                "SELECT texture FROM textures WHERE tile_id = ?", (tid,)
            ).fetchone()
            if not xrow:
                continue
            try:
                if fix_tile_in_db(db, tid, xrow[0], force=(pass_no > 1)):
                    changed.append(tid)
            except Exception as exc:
                print(f"  {tid}: fix FAILED: {type(exc).__name__}: {exc}", flush=True)
            if pass_no == 1:
                _progress(i, len(queue), t0, "fix")
        modified.update(changed)
        # a changed tile's new edges may seed or protect its 4 neighbors
        nxt = set()
        frozen = 0
        for tid in changed:
            d, c, r = (int(p) for p in tid.split("-"))
            for dc, dr in ((0, 1), (0, -1), (1, 0), (-1, 0)):
                nid = f"{d}-{c + dc}-{r + dr}"
                if nid not in candidates or nid in nxt:
                    continue
                if requeues[nid] >= MAX_REQUEUES:
                    frozen += 1
                    continue
                requeues[nid] += 1
                nxt.add(nid)
        print(f"  pass {pass_no}: {len(changed)} tiles changed"
              + (f" ({frozen} requeues frozen)" if frozen else ""), flush=True)
        if not nxt:
            break
        queue = sorted(nxt)
    print(f"Phase 1 done: {len(modified)} tiles touched", flush=True)

    print(f"Phase 2: propagating {len(modified)} tiles to ancestors", flush=True)
    t0 = time.time()
    total = 0
    order = sorted(modified, key=lambda t: -int(t.split("-")[0]))
    for i, tid in enumerate(order, 1):
        total += propagate_to_ancestors(db, tid)
        _progress(i, len(order), t0, "propagate")
    print(f"Phase 2 done: {total} ancestor updates", flush=True)


if __name__ == "__main__":
    sys.exit(main())
