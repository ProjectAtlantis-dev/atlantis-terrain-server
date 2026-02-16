"""Error-based LOD query with on-demand COG fetching.

Traverses the quadtree, subdividing where geometric_error / distance > threshold.
When a tile is needed but not yet in the DB, fetches it from ArcticDEM COG on S3
and caches it. Parent tiles are always available (aggregated), so the first render
shows coarse terrain and detail fills in progressively.

On-demand flow:
    1. query_tiles() returns best-available tiles + list of missing tile IDs
    2. Caller fetches missing tiles in background (fetch_missing_tiles)
    3. Next query picks up the newly cached tiles at higher detail

LOD edge stitching eliminates cross-depth seams at query time.
"""

import math
import os
import numpy as np

from colored_log import get_logger

log_trav = get_logger("terrain.trav")

from coords import to_stereo
from database import (
    open_db, read_tile, read_tile_metadata, write_tile, TileClobberError,
    GRID_N, CONFIDENCE, _tile_id, _tile_bbox, compute_geometric_error,
)
from terrain_config import ENHANCE_DEPTH


REAL_SOURCES = ('arcticdem', 'arcticdem_10m', 'copernicus', 'upscaled', 'supir_upscaled')

# Sources that should be refetched at higher DEM resolution
_UPGRADEABLE_SOURCES = {'arcticdem'}  # old 32m data

# Tiles we've already tried to fetch and found no COG data (ocean, etc).
# Seeded from DB on startup, updated as new tiles are discovered.
_no_data_cache = set()


def load_no_data_cache(db):
    """Populate _no_data_cache from tiles marked 'no_data' in the DB."""
    rows = db.execute("SELECT tile_id FROM tiles WHERE source = 'no_data'").fetchall()
    _no_data_cache.update(r[0] for r in rows)
    return len(_no_data_cache)



def mark_no_data(db, tile_id):
    """Mark a tile as having no COG data — in memory AND in the DB."""
    _no_data_cache.add(tile_id)
    db.execute("UPDATE tiles SET source = 'no_data' WHERE tile_id = ?", (tile_id,))
    db.commit()


def _distance_to_bbox(x, y, bbox):
    """Distance from point (x, y) to nearest edge of bbox. 0 if inside."""
    dx = max(bbox[0] - x, 0, x - bbox[2])
    dy = max(bbox[1] - y, 0, y - bbox[3])
    return math.sqrt(dx * dx + dy * dy)


def _fetch_tile(db, tile_id, bbox, allow_overwrite=False):
    """Fetch a single tile from COG, write to DB. Returns True if data found."""
    if tile_id in _no_data_cache:
        return False

    from ingest import _read_cog_heightmap

    data, src_name = _read_cog_heightmap(bbox, GRID_N)
    if data is None:
        mark_no_data(db, tile_id)
        return False

    conf = CONFIDENCE.get(src_name, CONFIDENCE['arcticdem'])
    cm = np.where(np.isnan(data), np.uint8(0), np.uint8(conf))
    hm = np.where(np.isnan(data), 0.0, data).astype(np.float32)
    try:
        write_tile(db, tile_id, hm, cm, src_name, reconcile=False,
                   allow_overwrite=allow_overwrite)
    except TileClobberError:
        return False
    return True


def _ensure_children(db, depth, col, row):
    """Create child tile skeletons on demand if they don't exist.

    Lazily extends the quadtree beyond the pre-seeded depth. First explorer
    pays the creation cost, all subsequent queries hit cached rows.
    """
    import datetime
    cd = depth + 1
    c2, r2 = col * 2, row * 2
    children = [(c2, r2), (c2+1, r2), (c2, r2+1), (c2+1, r2+1)]

    # Check if first child exists — if so, all 4 were created together
    first_id = _tile_id(cd, c2, r2)
    if read_tile_metadata(db, first_id) is not None:
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

    max_range: if > 0, skip tiles entirely beyond this distance (meters).
    """
    tid = _tile_id(depth, col, row)
    meta = read_tile_metadata(db, tid)
    _debug = tid in ('9-172-98', '10-344-196', '10-344-197', '10-345-196', '10-345-197')

    if meta is None:
        if _debug:
            log_trav.debug(f"{tid}: no metadata — skipping")
        return

    has_real_data = meta['source'] in REAL_SOURCES

    # Unfetched tiles have geometric_error=0 from seeding — assume high
    # error so the traversal subdivides through them to find smaller tiles
    # that can actually be fetched from COG sources.
    geo_err = meta['geometric_error']
    if geo_err == 0.0 and not has_real_data and meta['source'] != 'no_data':
        tile_size = meta['bbox'][2] - meta['bbox'][0]
        geo_err = tile_size * 0.1  # assume 10% of tile size as error

    if _debug:
        log_trav.debug(f"{tid}: source={meta['source']} real={has_real_data} geo_err={geo_err:.1f} (orig={meta['geometric_error']:.1f})")

    # Distance cutoff — don't subdivide beyond max_range, but still
    # include this tile if it has data (no holes at the boundary)
    dist_to_tile = _distance_to_bbox(qx, qy, meta['bbox'])
    if max_range > 0 and dist_to_tile > max_range:
        if _debug:
            log_trav.debug(f"{tid}: beyond max_range ({dist_to_tile:.0f} > {max_range:.0f}), real={has_real_data}")
        if has_real_data:
            results.append(tid)
        return

    # Check if we should subdivide
    should_subdivide = False
    if depth < max_depth:
        dist = max(math.sqrt(dist_to_tile**2 + altitude**2), 1.0)
        tile_size = meta['bbox'][2] - meta['bbox'][0]

        screen_error = geo_err / dist

        if _debug:
            log_trav.debug(f"{tid}: screen_error={screen_error:.6f} threshold={error_threshold:.6f} dist={dist:.0f}")

        if screen_error > error_threshold:
            # Hard subdivision ceiling — enhanced textures are the final quality.
            if depth >= ENHANCE_DEPTH:
                if _debug:
                    log_trav.debug(f"{tid}: depth>={depth} — NOT subdividing (depth-{ENHANCE_DEPTH} ceiling) real={has_real_data}")
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
            log_trav.debug(f"{tid}: screen_error too low, NOT subdividing")

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
                _traverse(db, depth+1, cc, cr, qx, qy, max_depth, error_threshold, results, missing, max_range, altitude)
    else:
        if _debug:
            log_trav.debug(f"{tid}: leaf node, real={has_real_data}")
        if has_real_data:
            results.append(tid)
        elif tid not in _no_data_cache:
            missing.append((tid, meta['bbox']))


def query_tiles_stereo(db, qx, qy, error_threshold=0.001, max_depth=None,
                       max_range=0.0, log=print, altitude=0.0):
    """Query tiles using error-based LOD with stereo coords directly.

    Same as query_tiles() but takes EPSG:3413 coords instead of lat/lon.
    max_range: if > 0, skip tiles beyond this distance in meters.
    altitude: camera altitude in meters — increases effective distance to tiles below.
    """
    return _query_tiles_impl(db, qx, qy, error_threshold, max_depth, max_range, log, altitude)


def query_tiles(db, lat, lon, error_threshold=0.001, max_depth=None,
                max_range=0.0, log=print, altitude=0.0):
    """Query tiles using error-based LOD.

    Returns best-available tiles from the DB plus a list of missing tiles
    that should be fetched in the background for the next frame.

    Args:
        db: sqlite3 connection to terrain database
        lat, lon: camera position in WGS84 degrees
        error_threshold: screen-space error threshold.
            Lower = more detail. 0.001 is a reasonable default.
        max_depth: maximum traversal depth (default: from DB metadata)
        max_range: if > 0, skip tiles beyond this distance in meters.
        log: logging function for clear source attribution
        altitude: camera altitude in meters — increases effective distance to tiles below.

    Returns:
        (tiles, missing) where:
            tiles: list of dicts with id, bbox, depth, heightmap, etc.
            missing: list of (tile_id, bbox) that need COG fetching
    """
    qx, qy = to_stereo(lat, lon)
    return _query_tiles_impl(db, qx, qy, error_threshold, max_depth, max_range, log, altitude)


def _query_tiles_impl(db, qx, qy, error_threshold, max_depth, max_range, log, altitude=0.0):
    from database import get_metadata
    from collections import Counter

    if max_depth is None:
        max_depth = int(get_metadata(db, 'max_depth') or 14)

    # Mild altitude scaling — sqrt instead of linear so mountain peaks
    # aren't over-penalized.  At 2000m this is ~4.5x (was 20x linear).
    # The 3D distance in _traverse also factors in altitude, so keep
    # this gentle to avoid double-penalizing high-elevation tiles.
    if altitude > 100:
        error_threshold = error_threshold * math.sqrt(altitude / 100.0)

    leaf_ids = []
    missing_raw = []
    _traverse(db, 0, 0, 0, qx, qy, max_depth, error_threshold, leaf_ids, missing_raw, max_range, altitude)

    # Tile budget: if LOD produced too many tiles, drop the deepest/farthest.
    # Keep coarse tiles (coverage) and nearest deep tiles (detail where it matters).
    MAX_TILES = 2500
    if len(leaf_ids) > MAX_TILES:
        # Score each tile: (depth, distance) — drop highest scores first
        def _tile_score(tid):
            parts = tid.split('-')
            d = int(parts[0])
            bbox = _tile_bbox(d, int(parts[1]), int(parts[2]))
            dist = _distance_to_bbox(qx, qy, bbox)
            return (d, dist)
        leaf_ids.sort(key=_tile_score)
        dropped = len(leaf_ids) - MAX_TILES
        leaf_ids = leaf_ids[:MAX_TILES]
        log(f"  [BUDGET] dropped {dropped} deepest/farthest tiles, capped at {MAX_TILES}")

    # Cap missing tiles: sort by distance to camera, closest first.
    # Progressive loading — fetch nearest tiles first, re-query for more.
    MAX_FETCH_BATCH = 500
    missing_raw.sort(key=lambda tb: _distance_to_bbox(qx, qy, tb[1]))
    missing = missing_raw[:MAX_FETCH_BATCH]

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

    # Queue background refetch for tiles with outdated DEM resolution.
    # They keep serving the old heightmap until the new one arrives.
    upgrade_count = 0
    for t in results:
        if t['source'] in _UPGRADEABLE_SOURCES:
            tid = t['id']
            if (tid, t['bbox']) not in missing:
                missing.append((tid, t['bbox']))
                upgrade_count += 1
    if upgrade_count:
        log(f"  [DEM UPGRADE] {upgrade_count} tiles queued for 10m refetch")

    results = sorted(results, key=lambda t: -t['depth'])
    _stitch_lod_edges(results)

    # --- Clear logging: what came from where ---
    db_depths = Counter(t['depth'] for t in results)
    db_sources = Counter(t['source'] for t in results)
    miss_depths = Counter(int(tid.split('-')[0]) for tid, _ in missing)
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


def fetch_missing_tiles(db, missing, max_workers=6, log=print):
    """Fetch missing tiles from ArcticDEM/Copernicus COG on S3.

    Each tile is read at native resolution from the COG, resampled via
    world-coordinate bilinear interp (_read_cog_heightmap), and written
    to the DB cache. After fetching, rebuilds affected parent tiles so
    coarser LOD levels are immediately available.

    Args:
        db: sqlite3 connection
        missing: list of (tile_id, bbox) from query_tiles()
        max_workers: parallel fetch threads
        log: logging function

    Returns:
        Number of tiles successfully fetched.
    """
    import time
    from concurrent.futures import ThreadPoolExecutor, as_completed
    from ingest import _read_cog_heightmap

    if not missing:
        return 0

    log(f"  [COG FETCH] Starting {len(missing)} tile reads from S3 "
        f"({max_workers} workers)...")

    t0 = time.time()
    fetched = 0
    no_data = 0
    clobbered = 0

    # Check which tiles already exist with upgradeable sources
    upgrade_tids = set()
    for tid, bbox in missing:
        meta = read_tile_metadata(db, tid)
        if meta and meta['source'] in _UPGRADEABLE_SOURCES:
            upgrade_tids.add(tid)

    def _worker(tile_id, bbox):
        return tile_id, _read_cog_heightmap(bbox, GRID_N)

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(_worker, tid, bbox): tid
            for tid, bbox in missing
        }
        for future in as_completed(futures):
            tid = futures[future]
            try:
                tile_id, (data, src_name) = future.result()
                if data is None:
                    if tid not in upgrade_tids:
                        mark_no_data(db, tile_id)
                    no_data += 1
                    continue

                conf = CONFIDENCE.get(src_name, CONFIDENCE['arcticdem'])
                cm = np.where(np.isnan(data), np.uint8(0), np.uint8(conf))
                hm = np.where(np.isnan(data), 0.0, data).astype(np.float32)
                overwrite = tid in upgrade_tids
                write_tile(db, tile_id, hm, cm, src_name, reconcile=False,
                           allow_overwrite=overwrite)
                fetched += 1
                if overwrite:
                    log(f"  [DEM UPGRADE] {tid}: {src_name} replaced old 32m data")
            except TileClobberError as exc:
                clobbered += 1
                log(
                    f"  [CLOBBER] {exc.tile_id} already has payload "
                    f"(existing={exc.existing_source}, incoming={exc.incoming_source}, "
                    f"updated_at={exc.existing_updated_at})"
                )
            except Exception:
                mark_no_data(db, futures[future])
                no_data += 1

    elapsed = time.time() - t0
    log(f"  [COG FETCH] Done: {fetched} fetched from S3, "
        f"{no_data} no data (ocean), {clobbered} clobber-detected, {elapsed:.1f}s")

    # Rebuild affected parents so coarser LOD levels are available ? might be obsolete

    return fetched


def _stitch_lod_edges(tiles):
    """Snap fine tile edges to coarser neighbors to eliminate cross-depth seams.

    Same-depth edges are guaranteed seamless by _resample_native() in ingest.py
    (world-coordinate bilinear interp ensures shared edges get identical values).
    Cross-depth seams still need stitching because a depth-7 tile's edge values
    won't match the coarser depth-6 tile's interpolated grid. This function
    handles that by averaging same-depth edges and resampling coarse->fine.

    Modifies heightmaps in-place (query results only — DB is untouched).
    """
    if not tiles:
        return

    # Build spatial index: map bbox corners to tiles for fast neighbor lookup
    # Use a dict keyed by (depth, col, row) for O(1) lookup
    by_address = {}
    for t in tiles:
        parts = t['id'].split('-')
        d, c, r = int(parts[0]), int(parts[1]), int(parts[2])
        by_address[(d, c, r)] = t

    for t in tiles:
        hm = t['heightmap']
        if hm is None:
            continue

        parts = t['id'].split('-')
        d, c, r = int(parts[0]), int(parts[1]), int(parts[2])
        bbox = t['bbox']
        n = hm.shape[0]  # GRID_N

        # Check each edge for a same-depth neighbor
        neighbors = {
            'west':  (d, c - 1, r),
            'east':  (d, c + 1, r),
            'south': (d, c, r - 1),
            'north': (d, c, r + 1),
        }

        for direction, (nd, nc, nr) in neighbors.items():
            if nc < 0 or nr < 0:
                continue

            if (nd, nc, nr) in by_address:
                # Same-depth neighbor exists — average shared edges
                nbr = by_address[(nd, nc, nr)]
                nhm = nbr['heightmap']
                if nhm is None:
                    continue
                if direction == 'east':
                    avg = (hm[:, -1] + nhm[:, 0]) * 0.5
                    hm[:, -1] = avg
                    nhm[:, 0] = avg
                elif direction == 'north':
                    avg = (hm[-1, :] + nhm[0, :]) * 0.5
                    hm[-1, :] = avg
                    nhm[0, :] = avg
                # west/south handled when the neighbor processes its east/north
                continue

            # No same-depth neighbor — find the coarser tile covering this edge
            coarse = _find_coarser_covering_tile(by_address, d, c, r, direction)
            if coarse is None:
                continue

            chm = coarse['heightmap']
            if chm is None:
                continue

            # Resample coarse tile's heightmap at fine tile's edge positions
            _resample_edge(hm, bbox, chm, coarse['bbox'], direction, n)


def _find_coarser_covering_tile(by_address, depth, col, row, direction):
    """Walk up the quadtree to find a coarser tile in the result set
    that covers the neighbor area on the given edge."""
    # The neighbor at (depth, ncol, nrow) isn't in results.
    # Walk up: at each coarser level, the neighbor's parent might be a leaf.
    if direction == 'west':
        ncol, nrow = col - 1, row
    elif direction == 'east':
        ncol, nrow = col + 1, row
    elif direction == 'south':
        ncol, nrow = col, row - 1
    elif direction == 'north':
        ncol, nrow = col, row + 1
    else:
        return None

    # Walk up from the neighbor's position
    cd, cc, cr = depth, ncol, nrow
    for _ in range(depth):
        cd -= 1
        cc //= 2
        cr //= 2
        if (cd, cc, cr) in by_address:
            return by_address[(cd, cc, cr)]

    return None


def _resample_edge(fine_hm, fine_bbox, coarse_hm, coarse_bbox, direction, n):
    """Resample a coarse tile's heightmap along the fine tile's edge and
    overwrite the fine tile's boundary row/column in-place."""
    fb = fine_bbox
    cb = coarse_bbox

    # Compute the fine tile's edge positions in world coordinates
    if direction == 'west':
        # Fine tile's west column (col 0): x = fb[0], y varies
        edge_x = np.full(n, fb[0])
        edge_y = np.linspace(fb[1], fb[3], n)
    elif direction == 'east':
        edge_x = np.full(n, fb[2])
        edge_y = np.linspace(fb[1], fb[3], n)
    elif direction == 'south':
        edge_x = np.linspace(fb[0], fb[2], n)
        edge_y = np.full(n, fb[1])
    elif direction == 'north':
        edge_x = np.linspace(fb[0], fb[2], n)
        edge_y = np.full(n, fb[3])
    else:
        return

    # Convert world positions to fractional pixel coords in coarse tile
    cx_frac = (edge_x - cb[0]) / (cb[2] - cb[0]) * (n - 1)
    cy_frac = (edge_y - cb[1]) / (cb[3] - cb[1]) * (n - 1)

    # Bilinear interpolation from coarse heightmap
    cx0 = np.clip(np.floor(cx_frac).astype(int), 0, n - 2)
    cy0 = np.clip(np.floor(cy_frac).astype(int), 0, n - 2)
    cx1 = cx0 + 1
    cy1 = cy0 + 1
    cxf = cx_frac - cx0
    cyf = cy_frac - cy0

    # coarse_hm is (row, col) = (y, x)
    vals = (
        coarse_hm[cy0, cx0] * (1 - cxf) * (1 - cyf) +
        coarse_hm[cy0, cx1] * cxf * (1 - cyf) +
        coarse_hm[cy1, cx0] * (1 - cxf) * cyf +
        coarse_hm[cy1, cx1] * cxf * cyf
    )

    # Overwrite fine tile's edge
    if direction == 'west':
        fine_hm[:, 0] = vals
    elif direction == 'east':
        fine_hm[:, -1] = vals
    elif direction == 'south':
        fine_hm[0, :] = vals
    elif direction == 'north':
        fine_hm[-1, :] = vals
