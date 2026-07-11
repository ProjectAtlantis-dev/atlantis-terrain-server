"""Fake fjord seamount removal (inverted bathymetry in ArcticDEM).

In clear fjord water the ArcticDEM stereo reconstruction sees the seabed and
builds it as above-water terrain along shorelines: a cliff at the seaward
data cutoff, a berm ridge, then a valley dropping back to near sea level
before the real shore rises. Rendered result: fake seamounts / walls in the
fjords.

Detection is a three-rule ensemble over a tile's heightmap + imagery:

1. NO-BEACH FLOOD FILL — grow from true sea (hm <= OCEAN_LEVEL_M) through
   pixels that are water-colored in the imagery. Real shorelines stop the
   fill with an abrupt color contrast (water -> beach/rock); fake terrain is
   water-colored above sea level and gets captured.
2. ELONGATED ISLAND SWEEP — berm crests can escape rule 1 (sun glint /
   brighter crest color). After the fill they remain as elongated strips
   (longer than wide) surrounded by captured water; sweep them up.
3. NO-NEW-CLIFF INVARIANT — flattening must never manufacture a step that
   the original DEM did not already have. Low captured samples may always
   be flattened, even at the foot of a real fjord wall: the wall's cliff
   pre-dates the flatten (steep shorelines ARE cliffs in Ameralik-type
   fjords). What is forbidden is dropping HIGH captured samples (more than
   CLIFF_TOL_M above sea level) that are really the flank of uncaptured
   high land — that means the fill climbed something real (e.g. a shadowed
   north wall, which is as dark as water) and flattening would carve it.
   Real flanks are told apart from fake berms by the profile rule: real
   terrain descends monotonically to the water, while a fake apron passes
   through a moat and RISES again into its seaward cutoff wall. The peel is
   therefore a downhill walk from protected land through the capture with a
   small noise budget; it restores a monotone real slope all the way to the
   shore but stops at a berm's moat, so the berm itself still flattens.

Tile seams are NOT neutral: fix_tile_in_db runs detection on a 3x3 mosaic
of PRISTINE neighbor data (bathy_originals) and crops the center verdict.
Both sides of a seam judge from the same evidence, so adjacent tiles cannot
settle in contradictory restore/flatten states (per-tile verdicts with edge
hints were bistable: one side restored 100 m rock, the other flattened the
same world positions — regression tiles 11-703-385, 11-703-393).

Every function is pure numpy on GRID_N² arrays; heightmap orientation is
row 0 = south (mesh convention). The imagery must be flipped to match before
calling (images are row 0 = north).
"""

import io
import zlib
from collections import deque

import numpy as np
from PIL import Image

from colored_log import get_logger

log_bathy = get_logger("terrain.bathy")

MIN_FIX_DEPTH = 11  # cells <= 20m; coarser depths can't resolve open water
                    # from mixed shoreline pixels — they are rebuilt from
                    # corrected children instead (propagate_to_ancestors)

BATHY_ALGO_VERSION = 7  # bump on any detection/flatten semantics change so
                        # already-fixed tiles get recomputed from their
                        # pristine DEM (bathy_originals table)

OCEAN_LEVEL_M = 0.5      # at/below = true sea (seed + flatten target band)
MAX_FAKE_ELEV_M = 150.0  # fake bathymetry never reconstructs higher than this
CLIFF_TOL_M = 8.0        # max boundary step the flatten is allowed to create
RISE_TOL_M = 3.0         # DEM noise allowance for the downhill peel walk —
                         # a genuine berm rises well above this past its moat
SHADOW_SIGMA_MAX = 1.5   # local imagery stddev at/below this = smooth deep
                         # shadow (peelable as real terrain). Fake-bathymetry
                         # water is TEXTURED — the visible bottom that fooled
                         # the DEM stereo matcher (sigma ~17); deep shadow is
                         # JPEG-crushed flat (~0.5); true open sea ~2.4
WATER_V_MAX = 110        # water pixels are dark ...
WATER_B_MINUS_R = 5      # ... and blue-dominant
ISLAND_MIN_PX = 6        # rule 2: ignore tiny specks
ISLAND_ELONGATION_MIN = 2.0  # rule 2: longer-than-wide ratio
HOLE_MAX_PX = 40         # capture-hole specks up to this size are absorbed
                         # without the elongation test (color-fill misses)

_N4 = ((1, 0), (-1, 0), (0, 1), (0, -1))


def water_mask(px):
    """Boolean water-color mask for an (N, N, 3) uint8 image array."""
    r = px[..., 0].astype(np.int16)
    b = px[..., 2].astype(np.int16)
    v = px.max(axis=-1)
    return (b > r + WATER_B_MINUS_R) & (v < WATER_V_MAX)


def shadow_smooth_mask(gray, out_n):
    """Peelability mask: True where the imagery is smooth deep shadow.

    ``gray`` is the FULL-RESOLUTION decoded texture as float32 grayscale
    (native orientation is irrelevant — the caller flips). Local stddev over
    a 5x5 window, block-averaged down to (out_n, out_n). Fake-bathymetry
    water carries the bottom texture that produced the fake DEM in the first
    place (high sigma); real shadowed rock is JPEG-crushed nearly flat.
    Only smooth samples may be restored by the cliff peel — textured water
    must always flatten, however it leans against real terrain.
    """
    k = 5
    if min(gray.shape) < out_n:
        return np.ones((out_n, out_n), dtype=bool)  # tiny texture: no signal
    pad = k // 2
    gp = np.pad(gray.astype(np.float64), pad, mode='reflect')
    c1 = np.cumsum(np.cumsum(gp, 0), 1)
    c2 = np.cumsum(np.cumsum(gp * gp, 0), 1)
    c1 = np.pad(c1, ((1, 0), (1, 0)))
    c2 = np.pad(c2, ((1, 0), (1, 0)))

    def boxsum(c):
        return (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k])

    n = float(k * k)
    var = np.maximum(boxsum(c2) / n - (boxsum(c1) / n) ** 2, 0.0)
    sig = np.sqrt(var)
    hb = min(sig.shape) // out_n
    sig_g = (sig[:hb * out_n, :hb * out_n]
             .reshape(out_n, hb, out_n, hb).mean(axis=(1, 3)))
    return sig_g <= SHADOW_SIGMA_MAX


def _flood(seeds, grow):
    """BFS flood fill: expand seeds through grow. Returns newly captured mask."""
    n = seeds.shape[0]
    seen = seeds.copy()
    captured = np.zeros_like(seeds)
    q = deque(zip(*np.nonzero(seeds)))
    while q:
        r, c = q.popleft()
        for dr, dc in _N4:
            rr, cc = r + dr, c + dc
            if 0 <= rr < n and 0 <= cc < n and not seen[rr, cc] and grow[rr, cc]:
                seen[rr, cc] = True
                captured[rr, cc] = True
                q.append((rr, cc))
    return captured


def _elongated_islands(hm, ocean, captured):
    """Rule 2: berm crests that escaped the color fill.

    A fake crest is an elongated (longer-than-wide) low land strip whose
    water boundary is substantially CAPTURED fill — the fake valley behind
    it. A real skerry sits in true sea (ocean, not captured) and is left
    alone. Returns additional mask to capture.
    """
    n = hm.shape[0]
    land = ~(ocean | captured)
    seen = np.zeros_like(land)
    out = np.zeros_like(land)
    for r0 in range(n):
        for c0 in range(n):
            if not land[r0, c0] or seen[r0, c0]:
                continue
            # collect this 4-connected land component
            comp = []
            q = deque([(r0, c0)])
            seen[r0, c0] = True
            n_cap_adj = 0
            n_sea_adj = 0
            while q:
                r, c = q.popleft()
                comp.append((r, c))
                for dr, dc in _N4:
                    rr, cc = r + dr, c + dc
                    if not (0 <= rr < n and 0 <= cc < n):
                        continue  # tile edge is neutral — berms cross tiles
                    if land[rr, cc]:
                        if not seen[rr, cc]:
                            seen[rr, cc] = True
                            q.append((rr, cc))
                    elif captured[rr, cc]:
                        n_cap_adj += 1
                    else:
                        n_sea_adj += 1
            coords = np.array(comp)
            elevs = hm[coords[:, 0], coords[:, 1]]
            if elevs.max() >= MAX_FAKE_ELEV_M:
                continue
            # boundary must be mostly fake valley, not true sea
            if n_cap_adj < 2 * n_sea_adj or n_cap_adj == 0:
                continue
            if len(comp) <= HOLE_MAX_PX:
                # small hole in the capture — a color-fill miss, absorb as-is
                out[coords[:, 0], coords[:, 1]] = True
                continue
            if len(comp) < ISLAND_MIN_PX:
                continue
            # larger strips must look like a berm crest: longer than wide
            # (PCA of pixel coordinates)
            centered = coords - coords.mean(axis=0)
            cov = centered.T @ centered / len(comp)
            evals = np.linalg.eigvalsh(cov)
            minor, major = max(evals[0], 1e-3), evals[1]
            if np.sqrt(major / minor) >= ISLAND_ELONGATION_MIN:
                out[coords[:, 0], coords[:, 1]] = True
    return out


def _descend_backside(hm, captured):
    """Extend capture down the seamount's back side.

    DEM contamination does not stop at the imagery color line: the fake
    surface can merge into land-colored terrain well above sea level. Per
    the profile rule, the fake body always descends to a valley before real
    terrain rises — so from every HIGH captured pixel (above CLIFF_TOL_M),
    keep capturing strictly non-rising neighbors. The capture then ends at
    the valley floor. If the boundary sits on real rising terrain instead,
    nothing descends and _erode_cliffs peels it afterwards. Descent is never
    seeded from low boundaries so real beaches aren't crept over, and the
    non-increase rule cannot ratchet uphill.
    """
    n = hm.shape[0]
    q = deque(
        (r, c) for r, c in zip(*np.nonzero(captured)) if hm[r, c] > CLIFF_TOL_M
    )
    while q:
        r, c = q.popleft()
        e = hm[r, c]
        for dr, dc in _N4:
            rr, cc = r + dr, c + dc
            if not (0 <= rr < n and 0 <= cc < n) or captured[rr, cc]:
                continue
            ee = hm[rr, cc]
            if OCEAN_LEVEL_M < ee <= e and ee < MAX_FAKE_ELEV_M:
                captured[rr, cc] = True
                q.append((rr, cc))
    return captured


def _erode_cliffs(hm, captured, edges=None, peelable=None):
    """Reject capture that would manufacture a NEW cliff when flattened.

    Every surviving captured sample is written to ``OCEAN_LEVEL_M``. A LOW
    captured sample (within ``CLIFF_TOL_M`` of sea level) may always be
    flattened — even beside a real fjord wall, the resulting step already
    existed in the DEM. HIGH captured samples that are the downhill
    continuation of uncaptured high land are the real flank of that land
    (the fill climbed it through shadow): peel them, walking downhill from
    every protected land sample with a cumulative ``RISE_TOL_M`` noise
    budget. The walk restores a monotone real slope all the way to the
    shore, but cannot climb back over a fake berm's seaward rise — it stops
    at the moat, so aprons and berms standing in open water still flatten
    however high they are.

    ``peelable`` (optional bool mask, from ``shadow_smooth_mask``) filters
    the walk's result: only smooth deep shadow can be mistaken terrain, so
    a LARGE connected non-peelable (textured) region in the peel is
    bottom-visible water — cancel its peel so it flattens, which breaks the
    moat-less case of an apron leaning directly against a fjord wall.
    Small textured pockets (<= HOLE_MAX_PX) inside a restored shadow flank
    are absorbed into the restore — un-peeling them individually would
    punch sea-level craters into real rock.

    ``edges`` is an optional dict with keys 'N'/'S'/'E'/'W' mapping to the
    adjacent tiles' edge elevation rows (length N, NaN where unknown), so
    the invariant holds across tile seams. Missing edges are neutral.
    """
    nr, nc = hm.shape
    phm = np.full((nr + 2, nc + 2), np.nan, dtype=np.float32)
    phm[1:-1, 1:-1] = hm
    if edges:
        for key, sl in (('N', (slice(-1, None), slice(1, -1))),
                        ('S', (slice(0, 1), slice(1, -1))),
                        ('E', (slice(1, -1), slice(-1, None))),
                        ('W', (slice(1, -1), slice(0, 1)))):
            if edges.get(key) is not None:
                phm[sl] = np.asarray(edges[key], dtype=np.float32).reshape(phm[sl].shape)
    cap = np.zeros((nr + 2, nc + 2), dtype=bool)
    cap[1:-1, 1:-1] = captured
    max_land_elev = OCEAN_LEVEL_M + CLIFF_TOL_M
    ev = np.where(np.isnan(phm), -np.inf, phm)
    high = ev > max_land_elev
    # Downhill walk with a cumulative rise budget: `best` is the lowest
    # elevation seen along any walk reaching a sample (∞ = unreached). A walk
    # may wobble up by DEM noise (RISE_TOL_M above its running minimum) but
    # can never climb back over a berm — so it stops at the moat. Peeled =
    # every captured sample a walk reaches.
    best = np.where((~cap) & high, ev, np.inf)
    q = deque(zip(*np.nonzero((~cap) & high)))
    while q:
        r, c = q.popleft()
        b = best[r, c]
        for dr, dc in _N4:
            rr, cc = r + dr, c + dc
            if not (0 <= rr < nr + 2 and 0 <= cc < nc + 2):
                continue
            ee = ev[rr, cc]
            if (cap[rr, cc] and high[rr, cc]
                    and ee <= b + RISE_TOL_M and min(b, ee) < best[rr, cc]):
                best[rr, cc] = min(b, ee)
                q.append((rr, cc))
    peeled = cap & ~np.isinf(best)
    if peelable is not None and peeled.any():
        # Cancel the peel for large coherent textured regions (bottom-visible
        # water); absorb small textured pockets into the restored flank.
        pl = np.zeros((nr + 2, nc + 2), dtype=bool)
        pl[1:-1, 1:-1] = peelable
        tex = peeled & ~pl
        seen = np.zeros_like(tex)
        for r0, c0 in zip(*np.nonzero(tex)):
            if seen[r0, c0]:
                continue
            comp = [(r0, c0)]
            seen[r0, c0] = True
            qq = deque(comp)
            while qq:
                r, c = qq.popleft()
                for dr, dc in _N4:
                    rr, cc = r + dr, c + dc
                    if (0 <= rr < nr + 2 and 0 <= cc < nc + 2
                            and tex[rr, cc] and not seen[rr, cc]):
                        seen[rr, cc] = True
                        comp.append((rr, cc))
                        qq.append((rr, cc))
            if len(comp) > HOLE_MAX_PX:
                for r, c in comp:
                    peeled[r, c] = False
    return (cap & ~peeled)[1:-1, 1:-1]


def _flatten(hm, captured):
    """Flatten the safety-checked capture to sea level."""
    out = hm.copy()
    out[captured] = OCEAN_LEVEL_M
    return out


def _safe_propagation_mask(hm, candidates):
    """Validate sparse child samples before inserting them into a parent.

    Propagation changes scale: samples that formed a continuous safe shoreline
    in a child can become isolated sea-level points beside high parent terrain.
    Treat the proposed parent samples as a fresh capture and apply the same
    no-cliff invariant at the parent's resolution.
    """
    return _erode_cliffs(hm, candidates)


def flatten_fake_bathymetry(hm, px, extra_seeds=None, neighbor_edges=None,
                            peelable=None):
    """Remove fake fjord seamounts from one tile.

    Args:
        hm:  (GRID_N, GRID_N) float32 heightmap, row 0 = south. NaN allowed.
        px:  (GRID_N, GRID_N, 3) uint8 imagery in the SAME orientation
             (flip the decoded JPEG with np.flipud first).
        extra_seeds: optional bool mask of additional sea seeds (e.g. edge
             pixels adjacent to a neighbor tile's flattened water).
        neighbor_edges: optional 'N'/'S'/'E'/'W' dict of adjacent tiles' edge
             elevation rows for the no-new-cliff check at seams.
        peelable: optional bool mask (shadow_smooth_mask) restricting the
             cliff peel to smooth deep-shadow samples.

    Returns (new_hm, captured_mask). captured_mask empty → no change.
    Samples outside the capture keep their exact input values.
    """
    hmv = np.where(np.isnan(hm), 0.0, hm)
    ocean = hmv <= OCEAN_LEVEL_M
    seeds = ocean if extra_seeds is None else (ocean | extra_seeds)
    if not seeds.any():
        return hm, np.zeros_like(ocean)

    grow = water_mask(px) & (hmv < MAX_FAKE_ELEV_M)
    captured = _flood(seeds, grow)
    if not captured.any():
        return hm, captured
    captured |= _elongated_islands(hmv, ocean, captured)
    captured = _descend_backside(hmv, captured)
    captured |= _elongated_islands(hmv, ocean, captured)
    captured = _erode_cliffs(hmv, captured, edges=neighbor_edges,
                             peelable=peelable)
    if not captured.any():
        return hm, captured
    new = _flatten(hm, captured).astype(np.float32)
    return new, captured


# ---------------------------------------------------------------------------
# DB integration (used by the tex-worker and fix_fjord_bathymetry.py)
# ---------------------------------------------------------------------------

def _ensure_originals_table(db):
    """Pristine pre-fix heightmaps, so the fix can always be recomputed."""
    db.execute(
        "CREATE TABLE IF NOT EXISTS bathy_originals ("
        " tile_id TEXT PRIMARY KEY,"
        " heightmap BLOB NOT NULL,"
        " confidence_map BLOB,"
        " source TEXT NOT NULL,"
        " algo_version INTEGER NOT NULL,"
        " updated_at TEXT NOT NULL)"
    )


def _context_mosaic(db, tile_id, center_jpeg):
    """3x3 tile mosaic of PRISTINE data around ``tile_id``.

    Adjacent tiles share their boundary sample row/col, so the mosaic is a
    (3*(GRID_N-1)+1)² lattice. Heightmaps come from bathy_originals where
    available (a neighbor's stored tile may already be a flatten DECISION —
    detection must run on data, not on other tiles' verdicts; per-tile
    verdicts at seams are bistable and disagree). Missing neighbors are NaN
    heightmap + black imagery: black is not water-colored, so the fill
    cannot grow there, and NaN land is neutral for the peel. Neighbor
    imagery uses real sources only — ancestor crops are blurred and read as
    smooth shadow. Returns (hm, px, peelable) mosaic arrays.
    """
    from database import GRID_N, _decompress_float32

    step = GRID_N - 1
    m = 3 * step + 1
    hm_m = np.full((m, m), np.nan, dtype=np.float32)
    px_m = np.zeros((m, m, 3), dtype=np.uint8)
    pl_m = np.ones((m, m), dtype=bool)
    d, c, r = (int(p) for p in tile_id.split("-"))
    for di in (-1, 0, 1):        # row offset (row 0 = south)
        for dj in (-1, 0, 1):    # col offset
            nid = f"{d}-{c + dj}-{r + di}"
            orow = db.execute(
                "SELECT heightmap FROM bathy_originals WHERE tile_id = ?",
                (nid,),
            ).fetchone()
            if orow is not None and orow[0] is not None:
                nhm = np.frombuffer(
                    zlib.decompress(orow[0]), dtype=np.float32
                ).reshape(GRID_N, GRID_N)
            else:
                trow = db.execute(
                    "SELECT heightmap FROM tiles WHERE tile_id = ?", (nid,),
                ).fetchone()
                if not trow or trow[0] is None:
                    continue
                nhm = _decompress_float32(trow[0], (GRID_N, GRID_N))
            r0, c0 = (di + 1) * step, (dj + 1) * step
            hm_m[r0:r0 + GRID_N, c0:c0 + GRID_N] = nhm
            if di == 0 and dj == 0:
                jpeg = center_jpeg
            else:
                x = db.execute(
                    "SELECT texture FROM textures WHERE tile_id = ?"
                    " AND source = 'dataforsyningen'", (nid,),
                ).fetchone()
                jpeg = x[0] if x else None
            if jpeg is not None:
                img = Image.open(io.BytesIO(jpeg)).convert("RGB")
                px_m[r0:r0 + GRID_N, c0:c0 + GRID_N] = np.flipud(np.array(
                    img.resize((GRID_N, GRID_N), Image.Resampling.BILINEAR)))
                gray = np.flipud(np.array(img.convert("L"), dtype=np.float32))
                pl_m[r0:r0 + GRID_N, c0:c0 + GRID_N] = shadow_smooth_mask(gray, GRID_N)
    return hm_m, px_m, pl_m


def fix_tile_in_db(db, tile_id, jpeg_bytes, force=False) -> bool:
    """Flatten one tile's fake bathymetry and store the corrected heightmap.

    Runs only at depth >= MIN_FIX_DEPTH. The pristine heightmap is stashed
    in bathy_originals on first touch and every run recomputes from it, so
    the fix is idempotent and algorithm upgrades (BATHY_ALGO_VERSION bumps)
    re-apply cleanly — including restoring terrain a previous version carved.
    Tiles already at the current version are skipped unless ``force``.
    Returns True if the stored tile changed.
    """
    from database import CONFIDENCE, GRID_N, write_tile, _decompress_float32, _decompress_uint8

    try:
        depth = int(tile_id.split("-")[0])
    except ValueError:
        return False
    if depth < MIN_FIX_DEPTH:
        return False
    row = db.execute(
        "SELECT heightmap, confidence_map, source FROM tiles WHERE tile_id = ?",
        (tile_id,),
    ).fetchone()
    if not row or row[0] is None:
        return False
    cur_hm = _decompress_float32(row[0], (GRID_N, GRID_N))
    cur_cm = (_decompress_uint8(row[1], (GRID_N, GRID_N)) if row[1] is not None
              else np.zeros((GRID_N, GRID_N), dtype=np.uint8))

    _ensure_originals_table(db)
    orow = db.execute(
        "SELECT heightmap, confidence_map, source, algo_version"
        " FROM bathy_originals WHERE tile_id = ?", (tile_id,),
    ).fetchone()
    if orow is not None:
        if orow[3] >= BATHY_ALGO_VERSION and not force:
            return False
        hm = _decompress_float32(orow[0], (GRID_N, GRID_N))
        cm = (_decompress_uint8(orow[1], (GRID_N, GRID_N)) if orow[1] is not None
              else np.zeros((GRID_N, GRID_N), dtype=np.uint8))
        source = orow[2]
    else:
        if (cur_cm >= CONFIDENCE['bathymetry']).any():
            # Mutated by the pre-versioning algorithm; the pristine DEM was
            # never kept, so recomputing from the stored (already flattened)
            # data would launder old damage. Needs a DEM refetch:
            # fix_fjord_bathymetry.py --refetch.
            log_bathy.warning(
                f"[bathy] {tile_id}: legacy fix without pristine original — "
                "skipping (repair with fix_fjord_bathymetry.py --refetch)")
            return False
        hm, cm, source = cur_hm, cur_cm, row[2]

    # Detect on the 3x3 pristine-context mosaic and crop the center verdict:
    # both sides of every seam then judge from the same evidence, so
    # adjacent tiles cannot settle in contradictory restore/flatten states.
    hm_m, px_m, pl_m = _context_mosaic(db, tile_id, jpeg_bytes)
    step = GRID_N - 1
    ctr = slice(step, step + GRID_N)
    hm_m[ctr, ctr] = hm  # center uses the same original we recompute from
    _, cap_m = flatten_fake_bathymetry(hm_m, px_m, peelable=pl_m)
    captured = cap_m[ctr, ctr]
    new_hm = np.where(captured, np.float32(OCEAN_LEVEL_M), hm)

    if orow is None:
        db.execute(
            "INSERT OR REPLACE INTO bathy_originals"
            " (tile_id, heightmap, confidence_map, source, algo_version, updated_at)"
            " VALUES (?, ?, ?, ?, ?, datetime('now'))",
            (tile_id, zlib.compress(hm.astype(np.float32).tobytes()),
             zlib.compress(cm.tobytes()), source, BATHY_ALGO_VERSION),
        )
    else:
        db.execute(
            "UPDATE bathy_originals SET algo_version = ?,"
            " updated_at = datetime('now') WHERE tile_id = ?",
            (BATHY_ALGO_VERSION, tile_id),
        )
    db.commit()

    cm_out = cm.copy()
    cm_out[captured] = CONFIDENCE['bathymetry']
    hm_out = np.where(np.isnan(new_hm), 0.0, new_hm).astype(np.float32)
    if np.array_equal(hm_out, cur_hm) and np.array_equal(cm_out, cur_cm):
        return False
    # Generic confidence-based reconciliation is not bathymetry-aware: it can
    # copy a sea-level confidence-7 edge sample into a neighbor beside high
    # terrain after the mask passed _erode_cliffs. Cross-tile bathymetry is
    # handled by explicit neighbor seeding; never mutate either tile here.
    write_tile(db, tile_id, hm_out, cm_out, source, reconcile=False, allow_overwrite=True)
    log_bathy.info(
        f"[bathy] {tile_id}: flattened {captured.mean():.0%} fake bathymetry"
        f" (v{BATHY_ALGO_VERSION})")
    return True


def propagate_to_ancestors(db, tile_id) -> int:
    """Push a corrected tile's flattened samples up its ancestor chain.

    Parent samples coincide with every 2nd child sample, so corrected
    (confidence >= 'bathymetry') samples subsample exactly into the parent
    quadrant. Untouched terrain is never resampled. Parent samples that
    claim a bathymetry correction the child no longer has (an earlier
    algorithm version flattened them, this one restored the terrain) are
    healed back from the child's values. Returns ancestors updated.
    """
    from database import CONFIDENCE, GRID_N, write_tile, _decompress_float32, _decompress_uint8

    try:
        d, c, r = (int(p) for p in tile_id.split("-"))
    except ValueError:
        return 0
    half = GRID_N // 2
    updated = 0
    while d > 0:
        child_id = f"{d}-{c}-{r}"
        pd, pc, pr = d - 1, c // 2, r // 2
        pid = f"{pd}-{pc}-{pr}"
        crow = db.execute(
            "SELECT heightmap, confidence_map FROM tiles WHERE tile_id = ?",
            (child_id,),
        ).fetchone()
        prow = db.execute(
            "SELECT heightmap, confidence_map, source FROM tiles WHERE tile_id = ?",
            (pid,),
        ).fetchone()
        if (not crow or crow[0] is None or crow[1] is None
                or not prow or prow[0] is None):
            break
        csub_cm = _decompress_uint8(crow[1], (GRID_N, GRID_N))[0:GRID_N:2, 0:GRID_N:2]
        mask = csub_cm >= CONFIDENCE['bathymetry']
        sub = _decompress_float32(crow[0], (GRID_N, GRID_N))[0:GRID_N:2, 0:GRID_N:2]
        hm = _decompress_float32(prow[0], (GRID_N, GRID_N))
        cm = (_decompress_uint8(prow[1], (GRID_N, GRID_N)) if prow[1] is not None
              else np.zeros((GRID_N, GRID_N), dtype=np.uint8))
        r0, c0 = (r % 2) * half, (c % 2) * half
        region = hm[r0:r0 + half + 1, c0:c0 + half + 1]
        cregion = cm[r0:r0 + half + 1, c0:c0 + half + 1]
        stale = (cregion >= CONFIDENCE['bathymetry']) & ~mask
        if not mask.any() and not stale.any():
            break
        if np.array_equal(region[mask], sub[mask]) and not stale.any():
            break  # already in sync — ancestors above are too

        changed = False
        if stale.any():
            region[stale] = sub[stale]
            cregion[stale] = csub_cm[stale]
            changed = True
        rejected = 0
        if mask.any():
            # A safe continuous child shoreline can subsample to isolated
            # points at parent resolution. Validate the proposed parent mask
            # against the parent terrain before copying sea-level samples.
            candidates = np.zeros((GRID_N, GRID_N), dtype=bool)
            candidate_region = candidates[r0:r0 + half + 1, c0:c0 + half + 1]
            candidate_region[mask] = True
            safe = _safe_propagation_mask(hm, candidates)
            safe_region = safe[r0:r0 + half + 1, c0:c0 + half + 1]
            accepted = mask & safe_region
            rejected = int(mask.sum() - accepted.sum())
            if accepted.any() and not np.array_equal(region[accepted], sub[accepted]):
                region[accepted] = sub[accepted]
                cregion[accepted] = np.maximum(cregion[accepted], csub_cm[accepted])
                changed = True
        if not changed:
            log_bathy.info(
                f"[bathy] {tile_id}: stopped at {pid}; rejected all "
                f"{int(mask.sum())} propagated samples by cliff guard"
            )
            break
        write_tile(db, pid, hm, cm, prow[2], reconcile=False, allow_overwrite=True)
        if rejected:
            log_bathy.info(
                f"[bathy] {tile_id}: {pid} rejected {rejected}/"
                f"{int(mask.sum())} propagated samples by cliff guard"
            )
        updated += 1
        d, c, r = pd, pc, pr
    if updated:
        log_bathy.info(f"[bathy] {tile_id}: propagated fix to {updated} ancestors")
    return updated
