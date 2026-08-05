"""Error-based LOD query with on-demand COG fetching.

Traverses the quadtree, subdividing where geometric_error / distance > threshold.
When a tile is needed but not yet in the DB, fetches it from ArcticDEM COG on S3
and caches it. Parent tiles are always available (aggregated), so the first render
shows coarse terrain and detail fills in progressively.

On-demand flow:
    1. query_tiles_stereo() returns best-available tiles + missing tile IDs
    2. The Flask scheduler materializes missing tiles in background workers
    3. Next query picks up the newly cached tiles at higher detail

LOD edge stitching eliminates cross-depth seams at query time.
"""

import math
import os
import datetime
import time
import numpy as np

from colored_log import get_logger

log_trav = get_logger("terrain.trav")
log_d13 = get_logger("terrain.d13")

from database import (
    open_db, read_tile, read_tile_metadata, write_tile, TileClobberError,
    GRID_N, CONFIDENCE, _tile_id, _tile_bbox, compute_geometric_error,
)
from terrain_config import MAX_TILE_DEPTH, WMS_CONTRACT_DEPTH
from terrain_seams import SqliteSeamCache, repair_lod_seams as _stitch_lod_edges
from tile_address import parse_tile_id, require_tile_id


REAL_SOURCES = (
    'arcticdem', 'arcticdem_10m', 'copernicus', 'parent_resampled',
    'official_coastline', 'cooked_dem',
    'unmasked_arcticdem', 'unmasked_arcticdem_10m',
    'unmasked_copernicus', 'unmasked_parent_resampled',
    'clobbered_arcticdem_10m', 'clobbered_copernicus',
    'clobbered_parent_resampled', 'clobbered_official_coastline',
)

# Past-contract DEMs are cooked from the parent heightmap, never read from
# COG (ArcticDEM 10 m is exhausted at the depth-12 grid; deeper reads are
# interpolation mush). Only parents in states the pipeline never refetches
# may be cooked from — derived tiles therefore cannot go stale through the
# normal flow, and depths <= WMS_CONTRACT_DEPTH are untouched by all of it.
# cooked_dem itself is a valid parent: cooks recurse deterministically
# (d14 cooks from cooked d13, ...), rooted in a measured depth-12 surface.
COOKED_DEM_SOURCE = 'cooked_dem'
_COOKED_DEM_PARENT_SOURCES = {
    'arcticdem_10m', 'copernicus', 'official_coastline', COOKED_DEM_SOURCE,
}

# Sources that should be refetched at higher DEM resolution
_UPGRADEABLE_SOURCES = {
    'arcticdem',  # old 32m data
    'parent_resampled',
    'unmasked_arcticdem',
    'unmasked_arcticdem_10m',
    'unmasked_copernicus',
    'unmasked_parent_resampled',
    'clobbered_arcticdem_10m',
    'clobbered_copernicus',
    'clobbered_parent_resampled',
    'clobbered_official_coastline',
}

# Tiles we've already tried to fetch and found no COG data (ocean, etc).
# Seeded from DB on startup, updated as new tiles are discovered.
_no_data_cache = set()
# Shape the radial LOD ceiling as equal-width rings outside the full-detail
# center. The rim must never become coarser than depth 8.
LOD_COARSE_FLOOR_DEPTH = 8
LOD_FINE_PLATEAU_RATIO = 0.55
# A depth-12 tile is about 659 m wide. Keep the full-detail response band to
# roughly four and a half tile widths around the camera.
LOD_FINE_PLATEAU_MAX_M = 3000.0
# Keep the complete 12 -> 8 transition within a bounded distance so large
# coverage requests retain a cheap depth-8 rim instead of expanding every
# intermediate band without limit.
LOD_TRANSITION_MAX_M = 12000.0
# Depths past the WMS contract never widen the radial curve: the contract
# depth keeps the full plateau it always had, and each deeper level only
# claims an inner core of this many of its own tile widths (depth 13 disc
# ≈ 989 m, depth 14 ≈ 494 m, ... depth 16 ≈ 124 m). A core of R tile
# widths holds ~pi*R^2 tiles regardless of depth, so every past-contract
# level adds the same bounded render cost (~28 tiles at 3.0).
LOD_PAST_CONTRACT_CORE_TILE_WIDTHS = 3.0
# Camera height above ground caps the radial LOD ceiling: a depth stops being
# worth fetching once the camera is more than this many of its tile-widths up.
# At 2.0, depth 13 (~330 m tiles) drops out above ~659 m altitude, depth 12
# above ~1.3 km, and so on down to the depth-8 rim floor. Altitude is the
# The API supplies measured AGL from the rendered terrain raycast.
LOD_ALTITUDE_WIDTH_FACTOR = 2.0
# Fraction of a boundary the camera must clear before the LOD cap follows it.
# At depth 12 (boundary 1318 m AGL) this holds the cap anywhere in 989-1648 m,
# which covers ordinary fjord and ridge relief on a level cruise.
LOD_ALTITUDE_HYSTERESIS = 0.25

_tile_width_cache: dict[int, float] = {}


def _tile_width_m(depth):
    width = _tile_width_cache.get(depth)
    if width is None:
        bbox = _tile_bbox(depth, 0, 0)
        width = float(bbox[2] - bbox[0])
        _tile_width_cache[depth] = width
    return width


def _altitude_depth_cap(altitude, max_depth, previous_depth=None):
    """Deepest LOD worth fetching from a camera this high up.

    The bare rule is a step, which was harmless while the input was camera
    altitude — flat during level flight. The input is now height above
    terrain, so a camera holding altitude over undulating ground sweeps back
    and forth across a boundary every few seconds, and each crossing swaps the
    entire resident tile set (measured at +233/-227 tiles in consecutive
    responses).

    Given the cap the client is already on, require the altitude to clear the
    boundary by a margin before changing it. The deadband is wide enough that
    routine terrain relief cannot re-trigger a swap, while a real climb or
    descent still crosses it immediately.
    """
    depth = max_depth
    while (
        depth > LOD_COARSE_FLOOR_DEPTH
        and altitude > LOD_ALTITUDE_WIDTH_FACTOR * _tile_width_m(depth)
    ):
        depth -= 1
    if previous_depth is None:
        return depth

    previous = max(LOD_COARSE_FLOOR_DEPTH, min(int(max_depth), int(previous_depth)))
    if depth < previous:
        # Coarsening: the boundary being left is the one below the held depth.
        boundary = LOD_ALTITUDE_WIDTH_FACTOR * _tile_width_m(previous)
        if altitude <= boundary * (1.0 + LOD_ALTITUDE_HYSTERESIS):
            return previous
    elif depth > previous:
        # Refining: the boundary being crossed belongs to the depth regained.
        boundary = LOD_ALTITUDE_WIDTH_FACTOR * _tile_width_m(
            min(int(max_depth), previous + 1)
        )
        if altitude >= boundary * (1.0 - LOD_ALTITUDE_HYSTERESIS):
            return previous
    return depth


def _lod_target_depth(distance, max_range, max_depth, altitude=0.0):
    """Return the radial LOD ceiling for a horizontal camera distance.

    Up to the smaller of the inner 55% of the requested range or 3 km is a
    full-detail plateau (roughly four and a half depth-12 tile widths).
    Equal-width radial bands then step through every intermediate depth toward
    the outer rim. The full transition is capped at 12 km so very large
    coverage ranges cannot overwhelm the tile budget. For requests capable of
    reaching it, the outer floor is always depth 8 (``8-*`` tiles), never
    depth 7 or 6.

    Altitude lowers the whole ceiling before the radial curve applies: a
    camera above LOD_ALTITUDE_WIDTH_FACTOR tile-widths of a depth never
    requests that depth anywhere, plateau included.

    Depths past WMS_CONTRACT_DEPTH never occupy the plateau: the contract
    depth keeps the exact curve it had before deeper levels existed, and
    each deeper level only claims an inner core of
    LOD_PAST_CONTRACT_CORE_TILE_WIDTHS of its own tile widths (capped at
    the plateau). The core therefore holds a constant tile count per level,
    keeping the expensive 4x-tile levels confined near the camera instead
    of quadrupling the whole plateau.
    """
    max_depth = max(0, int(max_depth))
    if altitude > 0.0:
        max_depth = min(
            max_depth,
            # Bare rule, no deadband. Hysteresis belongs to the transition
            # between what the client held and what it should hold next, and
            # _query_tiles_impl has already applied it against the client's
            # real previous depth to produce this ceiling. Re-applying it here
            # with previous_depth=max_depth compares the ceiling against
            # itself, so any coarsening lands inside the deadband and is
            # discarded — the altitude cap could never lower anything.
            _altitude_depth_cap(altitude, max_depth),
        )
    if max_range <= 0:
        return max_depth
    contract_ceiling = min(max_depth, WMS_CONTRACT_DEPTH)
    coarse_depth = min(contract_ceiling, LOD_COARSE_FLOOR_DEPTH)
    distance = max(0.0, distance)
    fine_plateau_end = min(
        max_range * LOD_FINE_PLATEAU_RATIO,
        LOD_FINE_PLATEAU_MAX_M,
    )

    if contract_ceiling == coarse_depth:
        depth = contract_ceiling
    elif distance <= fine_plateau_end:
        depth = contract_ceiling
    else:
        coarse_rim_start = min(max_range, fine_plateau_end + LOD_TRANSITION_MAX_M)
        if distance >= coarse_rim_start:
            depth = coarse_depth
        else:
            transition = (
                (distance - fine_plateau_end)
                / (coarse_rim_start - fine_plateau_end)
            )
            depth_falloff = contract_ceiling - coarse_depth
            continuous_depth = contract_ceiling - depth_falloff * transition
            # This is a ceiling, so never round a fractional transition depth
            # upward: doing so extends the full-detail band beyond
            # fine_plateau_end.
            depth = max(
                coarse_depth, min(contract_ceiling, math.floor(continuous_depth))
            )

    for deeper in range(WMS_CONTRACT_DEPTH + 1, max_depth + 1):
        core = min(
            fine_plateau_end,
            LOD_PAST_CONTRACT_CORE_TILE_WIDTHS * _tile_width_m(deeper),
        )
        if distance <= core:
            depth = deeper
    return depth


def _coarse_lod_neighbors(leaf_ids):
    """Return leaves bordering another leaf more than one level finer."""
    addresses = set()
    for tile_id in leaf_ids:
        address = parse_tile_id(tile_id)
        if address is not None:
            addresses.add(address)

    coarse = set()
    for fine_depth, fine_col, fine_row in addresses:
        if fine_depth < 2:
            continue
        limit = 1 << fine_depth
        for neighbor_col, neighbor_row in (
            (fine_col - 1, fine_row),
            (fine_col + 1, fine_row),
            (fine_col, fine_row - 1),
            (fine_col, fine_row + 1),
        ):
            if not (0 <= neighbor_col < limit and 0 <= neighbor_row < limit):
                continue
            for coarse_depth in range(fine_depth - 2, -1, -1):
                scale = 1 << (fine_depth - coarse_depth)
                candidate = (
                    coarse_depth,
                    neighbor_col // scale,
                    neighbor_row // scale,
                )
                if candidate in addresses:
                    coarse.add(candidate)
                    break
    return coarse


def load_no_data_cache(db):
    """Populate _no_data_cache from tiles marked 'no_data' in the DB."""
    rows = db.execute("SELECT tile_id FROM tiles WHERE source = 'no_data'").fetchall()
    _no_data_cache.update(r[0] for r in rows)
    return len(_no_data_cache)



def mark_no_data(db, tile_id):
    """Mark a tile as having no COG data — in memory AND in the DB."""
    db.execute("UPDATE tiles SET source = 'no_data' WHERE tile_id = ?", (tile_id,))
    db.commit()
    # Publish the in-memory terminal state only after durable persistence.
    _no_data_cache.add(tile_id)


def _cache_coastline(db, tile_id, bbox=None):
    """Cache the independent official mask; never modify the stored DEM."""
    from coastline import cache_official_water_mask

    return cache_official_water_mask(db, tile_id, bbox, GRID_N)


def _mark_official_ocean(db, tile_id):
    """Record an all-water classification without changing elevation data."""
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    db.execute(
        "UPDATE tiles SET source = 'official_coastline', updated_at = ? "
        "WHERE tile_id = ?",
        (now, tile_id),
    )
    from terrain_seams import invalidate_tile_seams

    invalidate_tile_seams(db, tile_id)
    db.commit()


def _distance_to_bbox(x, y, bbox):
    """Distance from point (x, y) to nearest edge of bbox. 0 if inside."""
    dx = max(bbox[0] - x, 0, x - bbox[2])
    dy = max(bbox[1] - y, 0, y - bbox[3])
    return math.sqrt(dx * dx + dy * dy)


def bbox_in_view_circle(qx, qy, bbox, max_range):
    """Return whether a tile intersects the heading-independent demand circle."""
    if max_range <= 0:
        return True
    return _distance_to_bbox(qx, qy, bbox) <= max_range


def _cook_cooked_dem_quad(db, tile_id, allow_overwrite=False):
    """Cook tile_id's parent quad of heightmaps with the procedural upscaler.

    One upscale_heightmap call per parent produces the 129x129 surface whose
    quadrants become all four 65x65 children — siblings share edge samples
    from the same array, parent border rows are preserved exactly, and this
    same surface is what the texture cook conditions on, so geometry and
    imagery agree. Past WMS_CONTRACT_DEPTH this surface increasingly drives
    content (rock vs vegetation), so it is the authoritative artifact.

    Returns False (leaving the tile in missing, retried on later demand)
    when the parent is not yet in a stable non-refetchable state.
    """
    from coastline import read_water_mask

    depth, col, row = require_tile_id(tile_id)
    if depth > MAX_TILE_DEPTH:
        log_d13.info(
            f"{tile_id}: DEM cook refused — depth {depth} beyond "
            f"MAX_TILE_DEPTH={MAX_TILE_DEPTH} (upscaling disabled)"
        )
        return False
    meta = read_tile_metadata(db, tile_id)
    if meta is not None and meta['source'] in REAL_SOURCES:
        return True

    parent_col, parent_row = col // 2, row // 2
    parent_id = _tile_id(depth - 1, parent_col, parent_row)
    parent = read_tile(db, parent_id)
    if (
        parent is None
        or parent['heightmap'] is None
        or parent['source'] not in _COOKED_DEM_PARENT_SOURCES
    ):
        log_d13.info(
            f"{tile_id}: DEM cook DEFERRED — parent {parent_id} not stable "
            f"({parent['source'] if parent else 'missing'})"
        )
        return False

    water_mask = read_water_mask(db, parent_id)
    if water_mask is not None and water_mask.shape != parent['heightmap'].shape:
        water_mask = None

    cook_started = time.perf_counter()
    # Continue the measured DEM with clean bilinear interpolation.
    from terrain_upscale import upscale_heightmap
    upscaled = upscale_heightmap(
        parent['heightmap'],
        list(parent['bbox']),
        factor=2,
        amplitude_m=0.0,
        water_mask=water_mask,
    )
    confidence = np.full(
        (GRID_N, GRID_N), np.uint8(CONFIDENCE[COOKED_DEM_SOURCE])
    )
    _ensure_children(db, depth - 1, parent_col, parent_row)
    base_col, base_row = parent_col * 2, parent_row * 2
    written, kept = [], []
    step = GRID_N - 1
    for col_bit in (0, 1):
        for row_bit in (0, 1):
            child_id = _tile_id(depth, base_col + col_bit, base_row + row_bit)
            child_meta = read_tile_metadata(db, child_id)
            if child_meta is not None and child_meta['source'] in REAL_SOURCES:
                kept.append(f"{child_id}({child_meta['source']})")
                continue
            # Heightmaps are south-first; child row bit increases northward.
            quadrant = upscaled[
                row_bit * step: row_bit * step + GRID_N,
                col_bit * step: col_bit * step + GRID_N,
            ].astype(np.float32).copy()
            try:
                write_tile(
                    db, child_id, quadrant, confidence, COOKED_DEM_SOURCE,
                    reconcile=False, allow_overwrite=allow_overwrite,
                )
                written.append(child_id)
            except TileClobberError:
                kept.append(f"{child_id}(clobber-guard)")
    cook_ms = (time.perf_counter() - cook_started) * 1000.0
    log_d13.info(
        f"{tile_id}: DEM COOKED quad from {parent_id} "
        f"({parent['source']}, water_mask={'yes' if water_mask is not None else 'no'}, "
        "relief=bilinear) — "
        f"wrote {len(written)} as {COOKED_DEM_SOURCE}"
        + (f", kept {', '.join(kept)}" if kept else "")
        + f" in {cook_ms:.0f}ms"
    )
    return bool(written) or bool(kept)


def _ensure_children(db, depth, col, row):
    """Create child tile skeletons on demand if they don't exist.

    Lazily extends the quadtree beyond the pre-seeded depth. First explorer
    pays the creation cost, all subsequent queries hit cached rows.
    """
    import datetime
    cd = depth + 1
    c2, r2 = col * 2, row * 2
    children = [(c2, r2), (c2+1, r2), (c2, r2+1), (c2+1, r2+1)]

    # Old databases can contain a partial quad (for example one fetched child
    # beside a no-data child). Never infer all four rows from the first one.
    # The cooker always writes a complete sibling surface, so ensure every
    # child skeleton exists before entering its write loop.
    child_ids = [_tile_id(cd, cc, cr) for cc, cr in children]
    marks = ",".join("?" for _ in child_ids)
    existing_count = db.execute(
        f"SELECT COUNT(*) FROM tiles WHERE tile_id IN ({marks})",
        child_ids,
    ).fetchone()[0]
    if existing_count == len(child_ids):
        return

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    pid = _tile_id(depth, col, row)
    batch = []
    for cc, cr in children:
        tid = _tile_id(cd, cc, cr)
        bbox = _tile_bbox(cd, cc, cr)
        batch.append((tid, cd, cc, cr, bbox[0], bbox[1], bbox[2], bbox[3],
                       pid, 0.0, 'pending', now, None, None))

    db.executemany(
        "INSERT OR IGNORE INTO tiles "
        "(tile_id, depth, col, row, x_min, y_min, x_max, y_max, "
        "parent_id, geometric_error, source, updated_at, heightmap, confidence_map) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        batch
    )
    db.commit()


def _traverse(db, depth, col, row, qx, qy, max_depth, error_threshold,
              results, missing, max_range=0.0, altitude=0.0):
    """Recursive quadtree traversal with error-based LOD.

    A tile subdivides if geometric_error / distance > threshold, depth < max_depth,
    and children exist in the DB (or could be fetched).

    Tiles with real data are added to results. Tiles that are empty but the LOD
    says should have data are added to missing for background fetching.

    max_range: radius of the heading-independent coverage circle (meters).
    """
    tid = _tile_id(depth, col, row)
    meta = read_tile_metadata(db, tid)
    _debug = tid in ('9-172-98', '10-344-196', '10-344-197', '10-345-196', '10-345-197')

    if meta is None:
        if _debug:
            log_trav.debug(f"{tid}: no metadata — skipping")
        return

    has_real_data = meta['source'] in REAL_SOURCES
    is_placeholder = meta['source'] in (
        'parent_resampled', 'unmasked_parent_resampled',
        'clobbered_parent_resampled',
    )

    # Unfetched tiles have geometric_error=0 from seeding — assume high
    # error so the traversal subdivides through them to find smaller tiles
    # that can actually be fetched from COG sources.
    geo_err = meta['geometric_error']
    if geo_err == 0.0 and not has_real_data and meta['source'] != 'no_data':
        tile_size = meta['bbox'][2] - meta['bbox'][0]
        geo_err = tile_size * 0.1  # assume 10% of tile size as error

    if _debug:
        log_trav.debug(f"{tid}: source={meta['source']} real={has_real_data} geo_err={geo_err:.1f} (orig={meta['geometric_error']:.1f})")

    # Coverage cutoff — terrain outside the local demand circle is not part of
    # this response. Boundary-intersecting tiles are retained by the circle
    # test itself, so the requested region still has coarse edge coverage.
    dist_to_tile = _distance_to_bbox(qx, qy, meta['bbox'])
    in_coverage = bbox_in_view_circle(qx, qy, meta['bbox'], max_range)
    if not in_coverage:
        if _debug:
            log_trav.debug(
                f"{tid}: outside view circle (distance={dist_to_tile:.0f}, "
                f"base_range={max_range:.0f}), real={has_real_data}"
            )
        return

    # Parent-resampled tiles are terminal — don't subdivide further.
    # They're interpolated placeholders; children would also lack COG data
    # and just create texture-less holes.
    if is_placeholder:
        results.append(tid)
        return

    # Check if we should subdivide
    should_subdivide = False
    if depth < max_depth:
        dist = max(math.sqrt(dist_to_tile**2 + altitude**2), 1.0)

        screen_error = geo_err / dist

        if _debug:
            log_trav.debug(f"{tid}: screen_error={screen_error:.6f} threshold={error_threshold:.6f} dist={dist:.0f}")

        if max_range > 0:
            # A coarse tile must subdivide whenever any part of its footprint
            # reaches a finer radial band. Center-distance classification lets
            # a 10 km-wide depth-8 tile remain terminal beside depth-12 tiles.
            lod_distance = dist_to_tile
            target_depth = _lod_target_depth(
                lod_distance, max_range, max_depth, altitude
            )
            wants_subdivision = depth < target_depth
        else:
            # Preserve error-based traversal for callers that explicitly ask
            # for unlimited coverage and therefore provide no radial curve.
            target_depth = max_depth
            wants_subdivision = screen_error > error_threshold

        if wants_subdivision:
            # Hard subdivision ceiling for the current terrain dataset.
            if depth >= MAX_TILE_DEPTH:
                if _debug:
                    log_trav.debug(f"{tid}: depth>={depth} — NOT subdividing (depth-{MAX_TILE_DEPTH} ceiling) real={has_real_data}")
                if has_real_data:
                    results.append(tid)
                elif tid not in _no_data_cache:
                    missing.append((tid, meta['bbox']))
                return

            child_id = _tile_id(depth + 1, col * 2, row * 2)
            child_meta = read_tile_metadata(db, child_id)

            if child_meta is not None:
                # Children exist (pre-seeded) — subdivide normally
                should_subdivide = True
                if _debug:
                    log_trav.debug(f"{tid}: will subdivide (children exist)")
            elif has_real_data:
                # Children don't exist but we have real data and want
                # higher res. Create skeletons, show this tile for now,
                # queue children for background COG fetch.
                if _debug:
                    log_trav.debug(f"{tid}: no children, creating skeletons")
                _ensure_children(db, depth, col, row)
                results.append(tid)
                c2, r2 = col * 2, row * 2
                for cc, cr in [(c2, r2), (c2+1, r2), (c2, r2+1), (c2+1, r2+1)]:
                    ct = _tile_id(depth+1, cc, cr)
                    cm = read_tile_metadata(db, ct)
                    if cm and ct not in _no_data_cache:
                        missing.append((ct, cm['bbox']))
                return
        elif _debug:
            reason = (
                f"radial LOD target depth {target_depth}"
                if max_range > 0
                else "screen error too low"
            )
            log_trav.debug(f"{tid}: {reason}, NOT subdividing")

    if should_subdivide:
        c2, r2 = col * 2, row * 2
        children = [(c2, r2), (c2+1, r2), (c2, r2+1), (c2+1, r2+1)]

        # If children lack data but parent has real terrain, show parent
        # as clean fallback (no overlap/seams). Queue unfetched children
        # for background COG fetch. Skip tiles known to have no COG data.
        pending = []
        children_with_real = 0
        for cc, cr in children:
            ct = _tile_id(depth+1, cc, cr)
            cm = read_tile_metadata(db, ct)
            if cm and cm['source'] in REAL_SOURCES:
                children_with_real += 1
            elif cm and ct not in _no_data_cache:
                pending.append((ct, cm['bbox']))
                if _debug:
                    log_trav.debug(f"{tid}: child {ct} not real (source={cm['source']}), pending")

        if children_with_real == 0 and has_real_data:
            # No children have real data — show parent as fallback
            if _debug:
                log_trav.debug(f"{tid}: no children with real data, showing parent fallback")
            results.append(tid)
            missing.extend(pending)
        elif pending and has_real_data:
            # Some children ready, some pending — show parent, queue pending
            if _debug:
                log_trav.debug(f"{tid}: showing parent fallback, {len(pending)} children pending")
            results.append(tid)
            missing.extend(pending)
        else:
            # All children ready or pre-seeded — subdivide normally
            if _debug:
                log_trav.debug(f"{tid}: all children ready, subdividing")
            for cc, cr in children:
                _traverse(
                    db, depth+1, cc, cr, qx, qy, max_depth,
                    error_threshold, results, missing, max_range, altitude,
                )
    else:
        if _debug:
            log_trav.debug(f"{tid}: leaf node, real={has_real_data}")
        if has_real_data:
            results.append(tid)
        elif tid not in _no_data_cache:
            missing.append((tid, meta['bbox']))


def _balance_lod_leaves(
    db, leaf_ids, missing, qx, qy, max_depth, error_threshold,
    max_range, altitude,
):
    """Enforce a 2:1 quadtree transition between adjacent returned leaves.

    Radial thresholds are symmetric, but the camera is not generally aligned
    to the quadtree grid. Refining only the coarse side of any depth gap keeps
    the inexpensive depth-8 rim while guaranteeing the visible sequence never
    jumps directly from depth 8 to 10 (or across a larger gap).
    """
    leaves = set(leaf_ids)
    refined = 0

    for _ in range(max_depth + 1):
        coarse_neighbors = _coarse_lod_neighbors(leaves)
        if not coarse_neighbors:
            break

        changed = False
        for depth, col, row in sorted(coarse_neighbors):
            tile_id = _tile_id(depth, col, row)
            if tile_id not in leaves or depth >= max_depth:
                continue

            c2, r2 = col * 2, row * 2
            children = [(c2, r2), (c2 + 1, r2), (c2, r2 + 1), (c2 + 1, r2 + 1)]
            first_child_id = _tile_id(depth + 1, c2, r2)
            if read_tile_metadata(db, first_child_id) is None:
                _ensure_children(db, depth, col, row)

            child_rows = []
            ready = True
            for child_col, child_row in children:
                child_id = _tile_id(depth + 1, child_col, child_row)
                child_bbox = _tile_bbox(depth + 1, child_col, child_row)
                if not bbox_in_view_circle(qx, qy, child_bbox, max_range):
                    continue
                child_meta = read_tile_metadata(db, child_id)
                if child_meta is None:
                    ready = False
                    continue
                child_rows.append((child_id, child_col, child_row, child_meta))
                if (
                    child_meta['source'] not in REAL_SOURCES
                    and child_id not in _no_data_cache
                ):
                    missing.append((child_id, child_meta['bbox']))
                    ready = False

            if not ready:
                continue

            replacements = []
            replacement_missing = []
            for child_id, child_col, child_row, child_meta in child_rows:
                if child_meta['source'] not in REAL_SOURCES:
                    continue
                _traverse(
                    db, depth + 1, child_col, child_row, qx, qy, max_depth,
                    error_threshold, replacements, replacement_missing,
                    max_range, altitude,
                )

            leaves.remove(tile_id)
            leaves.update(replacements)
            missing.extend(replacement_missing)
            refined += 1
            changed = True

        if not changed:
            break

    leaf_ids[:] = list(leaves)
    return refined


def query_tiles_stereo(db, qx, qy, error_threshold=0.001, max_depth=None,
                       max_range=0.0, log=print, altitude=0.0,
                       previous_depth=None):
    """Query tiles using error-based LOD with stereo coords directly.

    ``max_range`` is a circular coverage radius in meters.
    altitude: camera height above ground in meters — increases effective
        distance to tiles below.
    """
    return _query_tiles_impl(
        db, qx, qy, error_threshold, max_depth, max_range, log, altitude,
        previous_depth,
    )


def _query_tiles_impl(db, qx, qy, error_threshold, max_depth, max_range, log,
                      altitude=0.0, previous_depth=None):
    from database import get_metadata
    from collections import Counter

    if max_depth is None:
        max_depth = int(get_metadata(db, 'max_depth') or 14)

    # Decide the altitude ceiling once, with hysteresis against the cap the
    # client already holds. Everything downstream treats max_depth as the
    # settled ceiling, so the radial curve cannot re-derive a different one
    # mid-response and reintroduce the flip-flop.
    if altitude > 0.0:
        max_depth = min(
            max_depth, _altitude_depth_cap(altitude, max_depth, previous_depth)
        )

    # Mild altitude scaling — sqrt instead of linear so mountain peaks
    # aren't over-penalized.  At 2000m this is ~4.5x (was 20x linear).
    # The 3D distance in _traverse also factors in altitude, so keep
    # this gentle to avoid double-penalizing high-elevation tiles.
    if altitude > 100:
        error_threshold = error_threshold * math.sqrt(altitude / 100.0)

    leaf_ids = []
    missing_raw = []
    _traverse(
        db, 0, 0, 0, qx, qy, max_depth, error_threshold,
        leaf_ids, missing_raw, max_range, altitude,
    )

    balanced = _balance_lod_leaves(
        db, leaf_ids, missing_raw, qx, qy, max_depth, error_threshold,
        max_range, altitude,
    )
    if balanced:
        log(f"  [LOD BALANCE] refined {balanced} coarse neighbor tiles")

    # Tile budget: if LOD produced too many tiles, drop the deepest/farthest.
    # Keep coarse tiles (coverage) and nearest deep tiles (detail where it matters).
    MAX_TILES = 2500
    if len(leaf_ids) > MAX_TILES:
        # Score each tile: (depth, distance) — drop highest scores first
        def _tile_score(tid):
            d, col, row = require_tile_id(tid)
            bbox = _tile_bbox(d, col, row)
            dist = _distance_to_bbox(qx, qy, bbox)
            return (d, dist)
        leaf_ids.sort(key=_tile_score)
        dropped = len(leaf_ids) - MAX_TILES
        leaf_ids = leaf_ids[:MAX_TILES]
        log(f"  [BUDGET] dropped {dropped} deepest/farthest tiles, capped at {MAX_TILES}")

    # Read full tile data for leaves
    results = []
    for tid in leaf_ids:
        tile = read_tile(db, tid)
        if tile is None:
            continue

        bbox = tile['bbox']
        cx = (bbox[0] + bbox[2]) / 2
        cy = (bbox[1] + bbox[3]) / 2
        size = bbox[2] - bbox[0]

        results.append({
            'id': tile['tile_id'],
            'bbox': list(bbox),
            'depth': tile['depth'],
            'center': [cx, cy],
            'size': size,
            'resolution': GRID_N,
            'heightmap': tile['heightmap'],
            'source': tile['source'],
            'geometric_error': tile['geometric_error'],
        })

    # Treat raw restoration and ordinary misses as one priority queue.  The
    # previous implementation appended upgrades after capping ordinary misses,
    # so thousands of stale rows bypassed the cap and nearby visible tiles sat
    # behind coarse restoration work.
    upgrade_candidates = []
    for t in results:
        if t['source'] in _UPGRADEABLE_SOURCES:
            upgrade_candidates.append((t['id'], t['bbox']))

    candidates_by_id = {
        tid: (tid, bbox) for tid, bbox in (*missing_raw, *upgrade_candidates)
    }
    missing_candidates = list(candidates_by_id.values())
    missing_candidates.sort(
        key=lambda tb: _distance_to_bbox(qx, qy, tb[1])
    )
    # Small batches on purpose: the background fetcher holds its lock for a
    # whole batch, then the next request reprioritizes from the live camera.
    MAX_FETCH_BATCH = 100
    missing = missing_candidates[:MAX_FETCH_BATCH]
    if upgrade_candidates:
        upgrade_ids = {candidate[0] for candidate in upgrade_candidates}
        selected_upgrades = sum(
            tid in upgrade_ids for tid, _ in missing
        )
        log(
            f"  [DEM RESTORE] {selected_upgrades}/{len(upgrade_candidates)} "
            "visible stale tiles selected in this batch"
        )

    results = sorted(results, key=lambda t: -t['depth'])
    seam_cache = SqliteSeamCache(db)
    seam_repairs = _stitch_lod_edges(results, cache=seam_cache)
    if seam_repairs["cache_writes"]:
        db.commit()
    if seam_repairs["same_depth"] or seam_repairs["cross_lod"]:
        log(
            "[SEAM CACHE] "
            f"same={seam_repairs['same_depth']} cross={seam_repairs['cross_lod']} "
            f"hits={seam_repairs['cache_hits']} misses={seam_repairs['cache_misses']} "
            f"writes={seam_repairs['cache_writes']}"
        )

    # --- Clear logging: what came from where ---
    db_depths = Counter(t['depth'] for t in results)
    db_sources = Counter(t['source'] for t in results)
    miss_depths = Counter(require_tile_id(tid)[0] for tid, _ in missing)
    skip_count = len(_no_data_cache)

    log(f"  [DB HIT] {len(results)} tiles from database: "
        f"depths {dict(sorted(db_depths.items()))}, "
        f"sources {dict(db_sources)}")
    if missing:
        total_missing = len(missing_raw)
        log(f"  [DB MISS] {total_missing} tiles need data, "
            f"fetching closest {len(missing)}: "
            f"depths {dict(sorted(miss_depths.items()))}")
    if skip_count:
        log(f"  [NO DATA] {skip_count} tiles known to have no COG data (ocean/cached skip)")

    return results, missing
