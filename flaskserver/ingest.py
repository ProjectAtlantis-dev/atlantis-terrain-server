"""Minimal COG heightmap fetcher for on-demand tile population.

Self-contained COG heightmap reader.
ArcticDEM v4.1 10m mosaic from S3, Copernicus 30m fallback.
"""
from __future__ import annotations

import math
import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_bounds as transform_from_bounds
from rasterio.warp import Resampling as WarpResampling, reproject
from rasterio.windows import from_bounds as window_from_bounds, Window

from colored_log import get_logger
from database import GRID_N

log_cog = get_logger("terrain.cog")

# ---------------------------------------------------------------------------
# ArcticDEM tile grid constants
# ---------------------------------------------------------------------------

_GRID_ORIGIN = -4_000_000  # EPSG:3413 meters
_TILE_SIZE = 100_000
NODATA = -9999.0

_URL_TEMPLATE = (
    "https://pgc-opendata-dems.s3.us-west-2.amazonaws.com/"
    "arcticdem/mosaics/v4.1/10m/{row}_{col}/{row}_{col}_10m_v4.1_dem.tif"
)


def _tile_id_for_point(x, y):
    col = math.floor((x - _GRID_ORIGIN) / _TILE_SIZE) + 1
    row = math.floor((y - _GRID_ORIGIN) / _TILE_SIZE) + 1
    return row, col


def _tiles_for_bbox(bbox):
    x_min, y_min, x_max, y_max = bbox
    r_min, c_min = _tile_id_for_point(x_min, y_min)
    r_max, c_max = _tile_id_for_point(x_max, y_max)
    return [(r, c) for r in range(r_min, r_max + 1)
                    for c in range(c_min, c_max + 1)]


def _tile_url(row, col):
    return _URL_TEMPLATE.format(row=row, col=col)


# ---------------------------------------------------------------------------
# Copernicus fallback URL
# ---------------------------------------------------------------------------

def _copernicus_url(bbox):
    from pyproj import Transformer
    t = Transformer.from_crs("EPSG:3413", "EPSG:4326", always_xy=True)
    cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
    lon, lat = t.transform(cx, cy)
    tile_lat = int(lat)
    tile_lon = abs(int(lon)) + (1 if lon < 0 and int(lon) != lon else 0)
    ns = 'N' if lat >= 0 else 'S'
    ew = 'W' if lon < 0 else 'E'
    name = f"Copernicus_DSM_COG_10_{ns}{abs(tile_lat):02d}_00_{ew}{tile_lon:03d}_00_DEM"
    return (f"https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/{name}/{name}.tif",
            lon, lat)


# ---------------------------------------------------------------------------
# Bilinear resampling in world coordinates (seam-free)
# ---------------------------------------------------------------------------

def _resample_native(data, win_transform, bbox, resolution):
    h, w = data.shape
    out_x = np.linspace(bbox[0], bbox[2], resolution)
    out_y = np.linspace(bbox[1], bbox[3], resolution)

    a, e, c, f = win_transform.a, win_transform.e, win_transform.c, win_transform.f
    src_cols = (out_x - c) / a
    src_rows = (out_y - f) / e

    c0 = np.clip(np.floor(src_cols).astype(int), 0, w - 2)
    c1 = c0 + 1
    cf = np.clip(src_cols - c0, 0, 1).astype(np.float32)
    r0 = np.clip(np.floor(src_rows).astype(int), 0, h - 2)
    r1 = r0 + 1
    rf = np.clip(src_rows - r0, 0, 1).astype(np.float32)

    v00 = data[np.ix_(r0, c0)]
    v01 = data[np.ix_(r0, c1)]
    v10 = data[np.ix_(r1, c0)]
    v11 = data[np.ix_(r1, c1)]

    result = (v00 * (1 - rf[:, None]) * (1 - cf[None, :]) +
              v01 * (1 - rf[:, None]) * cf[None, :] +
              v10 * rf[:, None] * (1 - cf[None, :]) +
              v11 * rf[:, None] * cf[None, :])

    nan_mask = np.isnan(v00) | np.isnan(v01) | np.isnan(v10) | np.isnan(v11)
    result[nan_mask] = np.nan
    oob_c = (src_cols < 0) | (src_cols > w - 1)
    oob_r = (src_rows < 0) | (src_rows > h - 1)
    if np.any(oob_c):
        result[:, oob_c] = np.nan
    if np.any(oob_r):
        result[oob_r, :] = np.nan

    return result.astype(np.float32)


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

_MAX_ARCTIC_TILES = 16       # Don't attempt more than this many ArcticDEM COGs per request
_ARCTIC_COG_WORKERS = 6      # Parallel HTTP readers for ArcticDEM


def _read_cog_heightmap(bbox, resolution=GRID_N):
    """Read heightmap from ArcticDEM and Copernicus, compare, pick best.

    ArcticDEM COG tiles are fetched in parallel (up to _ARCTIC_COG_WORKERS).
    If the bbox spans too many COG tiles (coarse quadtree node), skip
    ArcticDEM entirely and go straight to Copernicus.

    Returns (float32 NxN, source_name) or (None, None).
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    log_cog.info(f"Fetching heightmap bbox=[{bbox[0]:.0f},{bbox[1]:.0f},{bbox[2]:.0f},{bbox[3]:.0f}] res={resolution}")

    # --- ArcticDEM (parallel) ---
    arctic = None
    tiles_needed = _tiles_for_bbox(bbox)

    if len(tiles_needed) > _MAX_ARCTIC_TILES:
        log_cog.info(f"  ArcticDEM: {len(tiles_needed)} COG tiles needed — too many (cap={_MAX_ARCTIC_TILES}), skipping")
    else:
        log_cog.info(f"  ArcticDEM: {len(tiles_needed)} COG tile(s), fetching with {_ARCTIC_COG_WORKERS} workers")

        def _fetch_one(row, col):
            """Fetch one ArcticDEM COG tile, resample to output grid."""
            url = _tile_url(row, col)
            log_cog.info(f"    ArcticDEM row={row} col={col} URL={url}")
            with rasterio.open(url) as src:
                window = window_from_bounds(*bbox, src.transform)  # type: ignore[call-arg]
                win_c0 = int(np.floor(window.col_off)) - 1
                win_r0 = int(np.floor(window.row_off)) - 1
                win_c1 = int(np.ceil(window.col_off + window.width)) + 1
                win_r1 = int(np.ceil(window.row_off + window.height)) + 1
                int_window = Window(win_c0, win_r0, win_c1 - win_c0, win_r1 - win_r0)  # type: ignore[call-arg]

                data = src.read(1, window=int_window, boundless=True).astype(np.float32)
                data[data <= NODATA] = np.nan
                valid_pct = np.mean(~np.isnan(data)) * 100
                log_cog.info(f"    ArcticDEM row={row} col={col} OK: shape={data.shape} valid={valid_pct:.1f}%")

                return _resample_native(data, src.window_transform(int_window), bbox, resolution)

        with ThreadPoolExecutor(max_workers=_ARCTIC_COG_WORKERS) as pool:
            futs = {pool.submit(_fetch_one, r, c): (r, c) for r, c in tiles_needed}
            for fut in as_completed(futs):
                row, col = futs[fut]
                try:
                    resampled = fut.result()
                    if arctic is None:
                        arctic = resampled
                    else:
                        fill = np.isnan(arctic) & ~np.isnan(resampled)
                        arctic[fill] = resampled[fill]
                except Exception as exc:
                    log_cog.warning(f"    ArcticDEM FAILED row={row} col={col}: {type(exc).__name__}: {exc}")

    arctic_ok = arctic is not None and np.any(~np.isnan(arctic))

    # --- Copernicus ---
    cop = None
    try:
        cop_url, cop_lon, cop_lat = _copernicus_url(bbox)
        log_cog.info(f"  Copernicus URL={cop_url} (center lon={cop_lon:.3f} lat={cop_lat:.3f})")
        dst_transform = transform_from_bounds(*bbox, resolution, resolution)  # type: ignore[call-arg]
        cop_data = np.empty((resolution, resolution), dtype=np.float32)
        with rasterio.open(cop_url) as src:
            reproject(
                source=rasterio.band(src, 1),  # type: ignore[call-arg]
                destination=cop_data,
                dst_transform=dst_transform,
                dst_crs=CRS.from_epsg(3413),
                resampling=WarpResampling.bilinear,
            )
        cop_data = np.flipud(cop_data)
        if np.any(~np.isnan(cop_data)) and np.any(cop_data != 0):
            cop = cop_data
    except Exception as exc:
        log_cog.warning(f"  Copernicus FAILED: {type(exc).__name__}: {exc}")

    # --- Copernicus expanded bbox retry ---
    if cop is None:
        try:
            dx = (bbox[2] - bbox[0]) * 0.10
            dy = (bbox[3] - bbox[1]) * 0.10
            exp_bbox = (bbox[0] - dx, bbox[1] - dy, bbox[2] + dx, bbox[3] + dy)
            cop_url2, cop_lon2, cop_lat2 = _copernicus_url(exp_bbox)
            log_cog.info(f"  Copernicus retry (expanded bbox +10%): URL={cop_url2}")
            dst_transform2 = transform_from_bounds(*bbox, resolution, resolution)
            cop_data2 = np.empty((resolution, resolution), dtype=np.float32)
            with rasterio.open(cop_url2) as src:
                reproject(
                    source=rasterio.band(src, 1),
                    destination=cop_data2,
                    dst_transform=dst_transform2,
                    dst_crs=CRS.from_epsg(3413),
                    resampling=WarpResampling.bilinear,
                )
            cop_data2 = np.flipud(cop_data2)
            if np.any(~np.isnan(cop_data2)) and np.any(cop_data2 != 0):
                cop = cop_data2
                log_cog.info(f"  Copernicus expanded bbox: got data!")
            else:
                log_cog.info(f"  Copernicus expanded bbox: still no valid data")
        except Exception as exc:
            log_cog.warning(f"  Copernicus expanded FAILED: {type(exc).__name__}: {exc}")

    cop_ok = cop is not None

    # --- Compare and log ---
    def _stats(arr, name):
        valid = ~np.isnan(arr)
        valid_pct = np.mean(valid) * 100
        if not np.any(valid):
            return f"{name}: 0% valid"
        vdata = arr[valid]
        elev_range = float(np.max(vdata) - np.min(vdata))
        std = float(np.std(vdata))
        return (f"{name}: valid={valid_pct:.1f}% min={np.min(vdata):.1f}m "
                f"max={np.max(vdata):.1f}m range={elev_range:.1f}m std={std:.1f}m")

    if arctic_ok:
        log_cog.info(f"  {_stats(arctic, 'ArcticDEM')}")
    else:
        log_cog.info(f"  ArcticDEM: no valid data")

    if cop_ok:
        log_cog.info(f"  {_stats(cop, 'Copernicus')}")
    else:
        log_cog.info(f"  Copernicus: no valid data")

    if arctic_ok and cop_ok:
        assert arctic is not None and cop is not None
        # Compare: difference between the two
        both_valid = ~np.isnan(arctic) & ~np.isnan(cop)
        if np.any(both_valid):
            diff = arctic[both_valid] - cop[both_valid]
            log_cog.info(f"  COMPARISON (ArcticDEM - Copernicus): "
                         f"mean_diff={np.mean(diff):.2f}m std_diff={np.std(diff):.2f}m "
                         f"max_abs_diff={np.max(np.abs(diff)):.2f}m "
                         f"overlap={np.sum(both_valid)}/{arctic.size} pixels")

        # Pick the one with more valid pixels, prefer ArcticDEM on tie
        arctic_valid = np.sum(~np.isnan(arctic))
        cop_valid = np.sum(~np.isnan(cop))
        if arctic_valid >= cop_valid:
            log_cog.info(f"  WINNER: ArcticDEM ({arctic_valid} vs {cop_valid} valid pixels)")
            return arctic, 'arcticdem_10m'
        else:
            log_cog.info(f"  WINNER: Copernicus ({cop_valid} vs {arctic_valid} valid pixels)")
            return cop, 'copernicus'

    if arctic_ok:
        log_cog.info(f"  Using ArcticDEM (only source with data)")
        return arctic, 'arcticdem_10m'

    if cop_ok:
        log_cog.info(f"  Using Copernicus (only source with data)")
        return cop, 'copernicus'

    log_cog.info(f"  No data from any source for bbox=[{bbox[0]:.0f},{bbox[1]:.0f},{bbox[2]:.0f},{bbox[3]:.0f}]")
    return None, None


# ---------------------------------------------------------------------------
# Parent-tile resampling fallback
# ---------------------------------------------------------------------------

def _resample_from_parent(db, tile_id, bbox, resolution=GRID_N):
    """Resample a parent tile's heightmap into this child's quadrant.

    Parses tile_id to find the parent, reads the parent heightmap from DB,
    extracts the relevant quadrant (~33x33 sub-grid), and bilinear-interpolates
    it up to the full resolution (65x65).

    Returns (float32 array, 'parent_resampled') or (None, None) if parent
    has no data.
    """
    from database import _decompress_float32, _decompress_uint8

    parts = tile_id.split('-')
    depth, col, row = int(parts[0]), int(parts[1]), int(parts[2])

    if depth == 0:
        log_cog.info(f"  Parent resample: depth=0, no parent")
        return None, None

    parent_depth = depth - 1
    parent_col = col // 2
    parent_row = row // 2
    parent_id = f"{parent_depth}-{parent_col}-{parent_row}"

    # Read parent heightmap + confidence map from DB
    parent_row_db = db.execute(
        "SELECT heightmap, source, confidence_map FROM tiles WHERE tile_id = ?",
        (parent_id,)
    ).fetchone()

    if parent_row_db is None or parent_row_db[0] is None:
        log_cog.info(f"  Parent resample: parent {parent_id} has no heightmap")
        return None, None

    parent_source = parent_row_db[1]
    if parent_source in ('empty', 'pending', 'no_data'):
        log_cog.info(f"  Parent resample: parent {parent_id} source={parent_source}, skipping")
        return None, None

    parent_hm = _decompress_float32(parent_row_db[0], (resolution, resolution))
    parent_cm = _decompress_uint8(parent_row_db[2], (resolution, resolution)) if parent_row_db[2] else None

    # Determine which quadrant this child occupies
    # col%2: 0=left half, 1=right half
    # row%2: 0=bottom half, 1=top half
    qx = col % 2  # 0=left, 1=right
    qy = row % 2  # 0=bottom, 1=top

    # The parent grid is resolution x resolution (65x65).
    # Each child covers half the parent, so we extract from the midpoint.
    mid = resolution // 2  # 32

    if qx == 0:
        c_start, c_end = 0, mid + 1  # columns 0..32 (33 values)
    else:
        c_start, c_end = mid, resolution  # columns 32..64 (33 values)

    if qy == 0:
        r_start, r_end = 0, mid + 1  # rows 0..32
    else:
        r_start, r_end = mid, resolution  # rows 32..64

    sub_grid = parent_hm[r_start:r_end, c_start:c_end]

    # Check confidence map — if the quadrant has no confident pixels,
    # it's genuinely empty (not just sea level at 0m)
    if parent_cm is not None:
        sub_cm = parent_cm[r_start:r_end, c_start:c_end]
        if np.all(sub_cm == 0):
            log_cog.info(f"  Parent resample: parent {parent_id} quadrant ({qx},{qy}) has no confident pixels")
            return None, None

    # Bilinear interpolate sub-grid up to full resolution
    sh, sw = sub_grid.shape
    row_idx = np.linspace(0, sh - 1, resolution)
    col_idx = np.linspace(0, sw - 1, resolution)

    r0 = np.floor(row_idx).astype(int)
    c0 = np.floor(col_idx).astype(int)
    r1 = np.minimum(r0 + 1, sh - 1)
    c1 = np.minimum(c0 + 1, sw - 1)
    rf = (row_idx - r0).astype(np.float32)
    cf = (col_idx - c0).astype(np.float32)

    result = (
        sub_grid[np.ix_(r0, c0)] * (1 - rf[:, None]) * (1 - cf[None, :]) +
        sub_grid[np.ix_(r0, c1)] * (1 - rf[:, None]) * cf[None, :] +
        sub_grid[np.ix_(r1, c0)] * rf[:, None] * (1 - cf[None, :]) +
        sub_grid[np.ix_(r1, c1)] * rf[:, None] * cf[None, :]
    ).astype(np.float32)

    log_cog.info(f"  Parent resample: {parent_id} quadrant ({qx},{qy}) → {tile_id} "
                 f"sub={sub_grid.shape} → {result.shape}")

    return result, 'parent_resampled'
