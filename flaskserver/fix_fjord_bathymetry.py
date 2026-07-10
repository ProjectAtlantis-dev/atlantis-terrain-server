"""Remove fake fjord seamounts (inverted bathymetry) from cached heightmaps.

Two passes (see bathymetry.py for the detection rules):

1. DETECT+FLATTEN at fine depths (>= --min-depth, default 11, cells <= 20m):
   tiles with both a heightmap and real imagery run the three-rule capture
   and get flattened with shore blending. Repeats until cross-tile edge
   seeding converges (a fake apron can cover a tile edge-to-edge with no sea
   seed of its own — its neighbor's flattened water seeds it).
2. PROPAGATE UPWARD: parents (min-depth-1 .. 0) whose children were modified
   are rebuilt by exact 2x subsampling of their children's corrected
   heightmaps, so d7/d8 fjord views agree with the fine data.

Corrected samples get confidence 7 ('bathymetry') so edge reconciliation
never lets an uncorrected neighbor overwrite a flattened edge.

Usage:
    venv/bin/python fix_fjord_bathymetry.py [--dry-run] [--min-depth 11]
                                            [--db terrain.db]
"""

import argparse
import io
import sqlite3
import sys
import time
import zlib
from pathlib import Path

import numpy as np
from PIL import Image

from bathymetry import OCEAN_LEVEL_M, flatten_fake_bathymetry
from database import GRID_N, CONFIDENCE, write_tile

TEX_REAL_SOURCES = ("dataforsyningen", "dataforsyningen_enhanced", "upscaled")


def _decomp(blob, dtype):
    return np.frombuffer(zlib.decompress(blob), dtype=dtype).reshape(GRID_N, GRID_N).copy()


def _edge_seeds(tile_edges, depth, col, row):
    """Bool seed mask from neighbors' flattened/sea edge pixels."""
    seeds = np.zeros((GRID_N, GRID_N), dtype=bool)
    got = False
    for (dc, dr, ours, theirs) in (
        (0, 1, GRID_N - 1, 0),   # north neighbor's south edge -> our north edge
        (0, -1, 0, GRID_N - 1),  # south
        (1, 0, GRID_N - 1, 0),   # east (columns)
        (-1, 0, 0, GRID_N - 1),  # west
    ):
        nbr = tile_edges.get((depth, col + dc, row + dr))
        if nbr is None:
            continue
        if dr:  # horizontal edge (a row of our grid)
            edge = nbr['S'] if dr == 1 else nbr['N']
            m = edge <= OCEAN_LEVEL_M
            if m.any():
                seeds[ours, :] |= m
                got = True
        else:
            edge = nbr['W'] if dc == 1 else nbr['E']
            m = edge <= OCEAN_LEVEL_M
            if m.any():
                seeds[:, ours] |= m
                got = True
    return seeds if got else None


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Flatten fake fjord seamounts in cached heightmaps."
    )
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--min-depth", type=int, default=11)
    ap.add_argument("--db", default=str(Path(__file__).parent / "terrain.db"))
    args = ap.parse_args()

    db = sqlite3.connect(args.db)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=10000")

    placeholders = ",".join("?" for _ in TEX_REAL_SOURCES)
    work = db.execute(
        f"SELECT t.tile_id, t.depth, t.col, t.row FROM tiles t "
        f"JOIN textures x ON x.tile_id = t.tile_id "
        f"WHERE t.depth >= ? AND t.heightmap IS NOT NULL "
        f"AND x.source IN ({placeholders}) ORDER BY t.depth, t.col, t.row",
        (args.min_depth, *TEX_REAL_SOURCES),
    ).fetchall()
    print(f"Pass 1: {len(work)} tiles at depth >= {args.min_depth} with real imagery")

    modified: set[str] = set()
    # cache of processed tiles' edge elevations for cross-tile seeding
    tile_edges: dict[tuple, dict] = {}
    t0 = time.time()
    pass_no = 0
    pending = work
    while pending:
        pass_no += 1
        next_pending = []
        for i, (tid, depth, col, row) in enumerate(pending):
            if pass_no == 1 and i and i % 2000 == 0:
                eta = (time.time() - t0) / i * (len(pending) - i)
                print(f"  {i / len(pending) * 100:5.1f}%  ({i}/{len(pending)})  eta {eta:4.0f}s", flush=True)
            trow = db.execute(
                "SELECT heightmap, confidence_map, source FROM tiles WHERE tile_id = ?",
                (tid,),
            ).fetchone()
            xrow = db.execute(
                "SELECT texture FROM textures WHERE tile_id = ?", (tid,)
            ).fetchone()
            if not trow or trow[0] is None or not xrow:
                continue
            hm = _decomp(trow[0], np.float32)
            px = np.flipud(np.array(
                Image.open(io.BytesIO(xrow[0])).convert("RGB")
                .resize((GRID_N, GRID_N), Image.Resampling.BILINEAR)))
            seeds = _edge_seeds(tile_edges, depth, col, row)
            new_hm, captured = flatten_fake_bathymetry(hm, px, extra_seeds=seeds)

            key = (depth, col, row)
            hm_out = np.where(np.isnan(new_hm), 0.0, new_hm)
            edges = {'N': hm_out[GRID_N - 1, :], 'S': hm_out[0, :],
                     'E': hm_out[:, GRID_N - 1], 'W': hm_out[:, 0]}
            newly_flat_edges = key not in tile_edges and captured.any()
            prev = tile_edges.get(key)
            edges_changed = prev is not None and any(
                not np.array_equal(prev[k], edges[k]) for k in 'NSEW')
            tile_edges[key] = edges

            if not captured.any():
                continue
            if tid not in modified:
                modified.add(tid)
            if not args.dry_run:
                cm = (_decomp(trow[1], np.uint8) if trow[1] is not None
                      else np.zeros((GRID_N, GRID_N), dtype=np.uint8))
                cm[captured] = CONFIDENCE['bathymetry']
                write_tile(db, tid, hm_out.astype(np.float32), cm,
                           trow[2], reconcile=True, allow_overwrite=True)
            # newly flattened edges may seed the 4 neighbors — requeue them
            if newly_flat_edges or edges_changed:
                for dc, dr in ((0, 1), (0, -1), (1, 0), (-1, 0)):
                    nid = f"{depth}-{col + dc}-{row + dr}"
                    next_pending.append((nid, depth, col + dc, row + dr))
        pending = [(tid, d, c, r) for tid, d, c, r in next_pending]
        if pass_no >= 6:
            break
        if pending:
            print(f"  pass {pass_no + 1}: re-checking {len(pending)} edge-seeded neighbors")

    print(f"Pass 1 done: {len(modified)} tiles flattened ({pass_no} passes)")

    # ---- Pass 2: rebuild ancestors from corrected children -----------------
    dirty = {tuple(map(int, t.split("-"))) for t in modified}
    rebuilt = 0
    for depth in range(args.min_depth - 1, -1, -1):
        parents = {(d - 1, c // 2, r // 2) for d, c, r in dirty if d - 1 == depth}
        dirty = set()
        for (pd, pc, pr) in sorted(parents):
            pid = f"{pd}-{pc}-{pr}"
            prow = db.execute(
                "SELECT heightmap, confidence_map, source FROM tiles WHERE tile_id = ?",
                (pid,),
            ).fetchone()
            if not prow or prow[0] is None:
                continue
            hm = _decomp(prow[0], np.float32)
            cm = (_decomp(prow[1], np.uint8) if prow[1] is not None
                  else np.zeros((GRID_N, GRID_N), dtype=np.uint8))
            changed = False
            half = GRID_N // 2  # 32
            for qc in range(2):
                for qr in range(2):
                    cid = f"{pd + 1}-{pc * 2 + qc}-{pr * 2 + qr}"
                    crow = db.execute(
                        "SELECT heightmap, confidence_map FROM tiles WHERE tile_id = ?",
                        (cid,),
                    ).fetchone()
                    if not crow or crow[0] is None:
                        continue
                    if crow[1] is None:
                        continue
                    # only corrected samples (confidence 7) propagate upward —
                    # never resample untouched terrain into the parent
                    csub_cm = _decomp(crow[1], np.uint8)[0:GRID_N:2, 0:GRID_N:2]
                    mask = csub_cm >= CONFIDENCE['bathymetry']
                    if not mask.any():
                        continue
                    chm = _decomp(crow[0], np.float32)
                    # parent samples coincide with every 2nd child sample
                    sub = chm[0:GRID_N:2, 0:GRID_N:2]  # (33, 33)
                    r0, c0 = qr * half, qc * half
                    region = hm[r0:r0 + half + 1, c0:c0 + half + 1]
                    if not np.array_equal(region[mask], sub[mask]):
                        region[mask] = sub[mask]
                        cregion = cm[r0:r0 + half + 1, c0:c0 + half + 1]
                        cregion[mask] = np.maximum(cregion[mask], csub_cm[mask])
                        changed = True
            if changed:
                rebuilt += 1
                dirty.add((pd, pc, pr))
                if not args.dry_run:
                    write_tile(db, pid, hm, cm, prow[2],
                               reconcile=True, allow_overwrite=True)
    print(f"Pass 2 done: {rebuilt} ancestor tiles rebuilt")

    if args.dry_run:
        print("--dry-run: nothing written.")
    else:
        print("Restart the Flask server and hard-reload the browser.")


if __name__ == "__main__":
    sys.exit(main())
