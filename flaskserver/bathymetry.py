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
3. NO-CLIFF INVARIANT — flattening must never create a cliff. A fake
   seamount's inland side always comes back down to near sea level before
   the real terrain rises, so any capture boundary against uncaptured land
   above CLIFF_TOL_M means the fill climbed something real (e.g. a shadowed
   north wall, which is as dark as water) — erode the capture back until the
   boundary is low.

Every function is pure numpy on GRID_N² arrays; heightmap orientation is
row 0 = south (mesh convention). The imagery must be flipped to match before
calling (images are row 0 = north).
"""

import io
from collections import deque

import numpy as np
from PIL import Image

from colored_log import get_logger

log_bathy = get_logger("terrain.bathy")

MIN_FIX_DEPTH = 11  # cells <= 20m; coarser depths can't resolve open water
                    # from mixed shoreline pixels — they are rebuilt from
                    # corrected children instead (propagate_to_ancestors)

OCEAN_LEVEL_M = 0.5      # at/below = true sea (seed + flatten target band)
MAX_FAKE_ELEV_M = 150.0  # fake bathymetry never reconstructs higher than this
CLIFF_TOL_M = 8.0        # max boundary step the flatten is allowed to create
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


BLEND_CELLS = 6  # shore ramp width, in heightmap cells


def _blend_flatten(hm, captured):
    """Rule 3, as an output constraint: flattening must never create cliffs.

    The fake body's valleys behind berms bottom out at 20-45m (still
    contaminated), so a hard set-to-0 would leave a step at any land
    boundary. Instead: interior of the capture goes to 0; within
    BLEND_CELLS of uncaptured LAND the original elevation ramps down —
    a synthetic beach. Boundaries against true sea don't ramp.
    """
    n = hm.shape[0]
    dist = np.full((n, n), np.inf)
    q = deque()
    land = (hm > OCEAN_LEVEL_M) & ~captured
    for r, c in zip(*np.nonzero(captured)):
        for dr, dc in _N4:
            rr, cc = r + dr, c + dc
            if 0 <= rr < n and 0 <= cc < n and land[rr, cc]:
                dist[r, c] = 1.0
                q.append((r, c))
                break
    while q:
        r, c = q.popleft()
        d = dist[r, c]
        for dr, dc in _N4:
            rr, cc = r + dr, c + dc
            if (0 <= rr < n and 0 <= cc < n and captured[rr, cc]
                    and dist[rr, cc] > d + 1):
                dist[rr, cc] = d + 1
                q.append((rr, cc))
    keep = np.clip(1.0 - (dist - 1.0) / BLEND_CELLS, 0.0, 1.0)
    keep[~captured] = 1.0
    return hm * keep


def flatten_fake_bathymetry(hm, px, extra_seeds=None):
    """Remove fake fjord seamounts from one tile.

    Args:
        hm:  (GRID_N, GRID_N) float32 heightmap, row 0 = south. NaN allowed.
        px:  (GRID_N, GRID_N, 3) uint8 imagery in the SAME orientation
             (flip the decoded JPEG with np.flipud first).
        extra_seeds: optional bool mask of additional sea seeds (e.g. edge
             pixels adjacent to a neighbor tile's flattened water).

    Returns (new_hm, captured_mask). captured_mask empty → no change.
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
    new = _blend_flatten(hmv, captured).astype(np.float32)
    return new, captured


# ---------------------------------------------------------------------------
# DB integration (used by the tex-worker and fix_fjord_bathymetry.py)
# ---------------------------------------------------------------------------

def fix_tile_in_db(db, tile_id, jpeg_bytes) -> bool:
    """Flatten one tile's fake bathymetry and store the corrected heightmap.

    Runs only at depth >= MIN_FIX_DEPTH. Skips tiles already corrected
    (any sample at confidence 'bathymetry'). Returns True if modified.
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
    hm = _decompress_float32(row[0], (GRID_N, GRID_N))
    cm = (_decompress_uint8(row[1], (GRID_N, GRID_N)) if row[1] is not None
          else np.zeros((GRID_N, GRID_N), dtype=np.uint8))
    if (cm >= CONFIDENCE['bathymetry']).any():
        return False
    px = np.flipud(np.array(
        Image.open(io.BytesIO(jpeg_bytes)).convert("RGB")
        .resize((GRID_N, GRID_N), Image.Resampling.BILINEAR)))
    # Cross-tile seeding: a fake apron can cover this tile edge-to-edge with
    # no sea of its own — its neighbors' at-sea-level edge samples seed it.
    d, c, r = (int(p) for p in tile_id.split("-"))
    seeds = np.zeros((GRID_N, GRID_N), dtype=bool)
    got_seed = False
    for dc, dr, ours, theirs in (
        (0, 1, GRID_N - 1, 0), (0, -1, 0, GRID_N - 1),   # N / S neighbors
        (1, 0, GRID_N - 1, 0), (-1, 0, 0, GRID_N - 1),   # E / W neighbors
    ):
        nrow = db.execute(
            "SELECT heightmap FROM tiles WHERE tile_id = ?",
            (f"{d}-{c + dc}-{r + dr}",),
        ).fetchone()
        if not nrow or nrow[0] is None:
            continue
        nhm = _decompress_float32(nrow[0], (GRID_N, GRID_N))
        edge = nhm[theirs, :] if dr else nhm[:, theirs]
        m = np.where(np.isnan(edge), 0.0, edge) <= OCEAN_LEVEL_M
        if m.any():
            if dr:
                seeds[ours, :] |= m
            else:
                seeds[:, ours] |= m
            got_seed = True
    new_hm, captured = flatten_fake_bathymetry(hm, px, extra_seeds=seeds if got_seed else None)
    if not captured.any():
        return False
    cm[captured] = CONFIDENCE['bathymetry']
    hm_out = np.where(np.isnan(new_hm), 0.0, new_hm).astype(np.float32)
    write_tile(db, tile_id, hm_out, cm, row[2], reconcile=True, allow_overwrite=True)
    log_bathy.info(f"[bathy] {tile_id}: flattened {captured.mean():.0%} fake bathymetry")
    return True


def propagate_to_ancestors(db, tile_id) -> int:
    """Push a corrected tile's flattened samples up its ancestor chain.

    Parent samples coincide with every 2nd child sample, so corrected
    (confidence >= 'bathymetry') samples subsample exactly into the parent
    quadrant. Untouched terrain is never resampled. Returns ancestors updated.
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
        if not mask.any():
            break
        sub = _decompress_float32(crow[0], (GRID_N, GRID_N))[0:GRID_N:2, 0:GRID_N:2]
        hm = _decompress_float32(prow[0], (GRID_N, GRID_N))
        cm = (_decompress_uint8(prow[1], (GRID_N, GRID_N)) if prow[1] is not None
              else np.zeros((GRID_N, GRID_N), dtype=np.uint8))
        r0, c0 = (r % 2) * half, (c % 2) * half
        region = hm[r0:r0 + half + 1, c0:c0 + half + 1]
        if np.array_equal(region[mask], sub[mask]):
            break  # already in sync — ancestors above are too
        region[mask] = sub[mask]
        cregion = cm[r0:r0 + half + 1, c0:c0 + half + 1]
        cregion[mask] = np.maximum(cregion[mask], csub_cm[mask])
        write_tile(db, pid, hm, cm, prow[2], reconcile=True, allow_overwrite=True)
        updated += 1
        d, c, r = pd, pc, pr
    if updated:
        log_bathy.info(f"[bathy] {tile_id}: propagated fix to {updated} ancestors")
    return updated
