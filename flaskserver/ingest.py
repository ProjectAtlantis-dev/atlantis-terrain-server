"""Minimal COG heightmap fetcher for on-demand tile population.

Self-contained COG heightmap reader.
ArcticDEM v4.1 10m mosaic from S3, Copernicus 30m fallback.
"""
from __future__ import annotations

from contextlib import contextmanager
import datetime
import math
import os
import threading
import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_bounds as transform_from_bounds
from rasterio.warp import Resampling as WarpResampling, reproject
from rasterio.windows import from_bounds as window_from_bounds, Window

from pyproj import Transformer

from colored_log import get_logger
from database import GRID_N
from tile_address import require_tile_id

log_cog = get_logger("terrain.cog")

# GDAL can hold several descriptors per remote COG. Bound dataset lifetimes
# process-wide while still allowing both tile-level and multi-COG parallelism.
try:
    _REMOTE_COG_OPEN_LIMIT = max(1, int(os.environ.get("COG_OPEN_LIMIT", "12")))
except ValueError:
    _REMOTE_COG_OPEN_LIMIT = 12
_remote_cog_open_slots = threading.BoundedSemaphore(_REMOTE_COG_OPEN_LIMIT)


@contextmanager
def _open_remote_cog(url):
    with _remote_cog_open_slots:
        with rasterio.open(url) as source:
            yield source

# ---------------------------------------------------------------------------
# EGM2008 geoid correction for ArcticDEM (ellipsoidal → orthometric heights)
# ---------------------------------------------------------------------------
# ArcticDEM uses WGS84 ellipsoidal heights. Sea level != 0m — it varies by
# the local geoid undulation (e.g. ~28m near Nuuk, ~49m near Tasiilaq).
# We subtract the geoid height N so that sea level ≈ 0m.
# Requires the us_nga_egm08_25.tif grid (install via: projsync --file us_nga_egm08_25.tif)

_to_wgs84_3d = Transformer.from_crs(3413, 4979, always_xy=True)
_to_egm2008 = Transformer.from_crs(4979, 9518, always_xy=True)


def _geoid_undulation(bbox):
    """Return EGM2008 geoid undulation (meters) at the bbox center."""
    cx = (bbox[0] + bbox[2]) / 2
    cy = (bbox[1] + bbox[3]) / 2
    lon, lat, _ = _to_wgs84_3d.transform(cx, cy, 0)
    _, _, ortho_at_zero = _to_egm2008.transform(lon, lat, 0)
    return -ortho_at_zero

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

# ArcticDEM encodes some open-ocean coverage as a completely valid, nearly
# constant ellipsoidal-height sheet.  After the EGM2008 correction that sheet
# sits at zero, so nodata checks alone cannot distinguish it from terrain.
# Keep this deliberately tight: the rejection requires almost complete
# coverage, sub-metre relief, and every sample within one metre of sea level.
_ARCTIC_SEA_PLATE_VALID_FRACTION = 0.95
_ARCTIC_SEA_PLATE_MAX_ABS_M = 0.75
_ARCTIC_SEA_PLATE_MAX_RANGE_M = 1.0


def _is_arctic_sea_level_plate(data) -> bool:
    """Return whether corrected ArcticDEM data is its flat ocean artifact."""
    if data is None:
        return False
    values = np.asarray(data, dtype=np.float32)
    valid = np.isfinite(values)
    if float(np.mean(valid)) < _ARCTIC_SEA_PLATE_VALID_FRACTION:
        return False
    samples = values[valid]
    return bool(
        np.max(np.abs(samples)) <= _ARCTIC_SEA_PLATE_MAX_ABS_M
        and np.ptp(samples) <= _ARCTIC_SEA_PLATE_MAX_RANGE_M
    )


def _read_cog_heightmap(
    bbox, resolution=GRID_N, arctic_workers=_ARCTIC_COG_WORKERS, audit=None
):
    """Read heightmap from ArcticDEM and Copernicus, compare, pick best.

    ArcticDEM COG tiles are fetched in parallel (up to _ARCTIC_COG_WORKERS).
    If the bbox spans too many COG tiles (coarse quadtree node), skip
    ArcticDEM entirely and go straight to Copernicus.

    Returns (float32 NxN, source_name), ``(None, 'official_ocean')`` for a
    terminal sea-level plate, or ``(None, None)`` when no provider resolved
    the tile.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    def _audit(stage, provider, outcome=None, detail=None):
        if audit is None:
            return
        event = {
            "stage": stage,
            "provider": provider,
            "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
        if outcome is not None:
            event["outcome"] = outcome
        if detail is not None:
            event["detail"] = detail
        try:
            audit(event)
        except Exception as exc:
            # Audit persistence must never turn a provider result into a false
            # terrain-fetch failure. The server logger still records the gap.
            log_cog.error(
                f"  COG audit callback FAILED: {type(exc).__name__}: {exc}"
            )

    log_cog.info(f"Fetching heightmap bbox=[{bbox[0]:.0f},{bbox[1]:.0f},{bbox[2]:.0f},{bbox[3]:.0f}] res={resolution}")

    # --- ArcticDEM (parallel) ---
    arctic = None
    tiles_needed = _tiles_for_bbox(bbox)

    if len(tiles_needed) > _MAX_ARCTIC_TILES:
        _audit(
            "cog_skipped", "arcticdem", "tile_cap",
            {"tiles_needed": len(tiles_needed), "cap": _MAX_ARCTIC_TILES},
        )
        log_cog.info(f"  ArcticDEM: {len(tiles_needed)} COG tiles needed — too many (cap={_MAX_ARCTIC_TILES}), skipping")
    else:
        worker_count = max(1, min(int(arctic_workers), len(tiles_needed)))
        log_cog.info(
            f"  ArcticDEM: {len(tiles_needed)} COG tile(s), "
            f"fetching with {worker_count} worker(s)"
        )

        def _fetch_one(row, col):
            """Fetch one ArcticDEM COG tile, resample to output grid."""
            url = _tile_url(row, col)
            log_cog.info(f"    ArcticDEM row={row} col={col} URL={url}")
            resource = {"row": row, "col": col, "url": url}
            _audit("cog_requested", "arcticdem", detail=resource)
            try:
                with _open_remote_cog(url) as src:
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
                    result = _resample_native(
                        data, src.window_transform(int_window), bbox, resolution
                    )
                _audit(
                    "cog_completed", "arcticdem", "success",
                    {**resource, "valid_pct": round(float(valid_pct), 3)},
                )
                return result
            except Exception as exc:
                _audit(
                    "cog_completed", "arcticdem", "error",
                    {**resource, "error": type(exc).__name__, "message": str(exc)},
                )
                raise

        def _merge_arctic(resampled):
            nonlocal arctic
            if arctic is None:
                arctic = resampled
            else:
                fill = np.isnan(arctic) & ~np.isnan(resampled)
                arctic[fill] = resampled[fill]

        if worker_count == 1:
            for row, col in tiles_needed:
                try:
                    _merge_arctic(_fetch_one(row, col))
                except Exception as exc:
                    log_cog.warning(f"    ArcticDEM FAILED row={row} col={col}: {type(exc).__name__}: {exc}")
        else:
            with ThreadPoolExecutor(max_workers=worker_count) as pool:
                futs = {pool.submit(_fetch_one, r, c): (r, c) for r, c in tiles_needed}
                for fut in as_completed(futs):
                    row, col = futs[fut]
                    try:
                        _merge_arctic(fut.result())
                    except Exception as exc:
                        log_cog.warning(f"    ArcticDEM FAILED row={row} col={col}: {type(exc).__name__}: {exc}")

    # --- EGM2008 geoid correction (ellipsoidal → orthometric) ---
    if arctic is not None and np.any(~np.isnan(arctic)):
        geoid_n = _geoid_undulation(bbox)
        arctic -= np.float32(geoid_n)
        log_cog.info(f"  ArcticDEM geoid correction: N={geoid_n:.2f}m subtracted")

    if _is_arctic_sea_level_plate(arctic):
        assert arctic is not None
        valid = arctic[np.isfinite(arctic)]
        detail = {
            "min_m": round(float(np.min(valid)), 3),
            "max_m": round(float(np.max(valid)), 3),
            "range_m": round(float(np.ptp(valid)), 3),
        }
        log_cog.info(
            "  ArcticDEM rejected: flat sea-level ocean artifact "
            f"(min={detail['min_m']:.3f}m max={detail['max_m']:.3f}m "
            f"range={detail['range_m']:.3f}m)"
        )
        _audit("cog_rejected", "arcticdem", "sea_level_plate", detail)
        log_cog.info(
            "  Skipping Copernicus: corrected ArcticDEM sea-level plate "
            "already proves open-ocean coverage"
        )
        # Preserve the terminal classification for the caller. Returning the
        # generic no-data pair made the COG worker install a parent-resampled
        # fallback, which remained upgradeable forever even though the
        # provider had already proved this tile was ocean.
        return None, 'official_ocean'

    arctic_ok = arctic is not None and np.any(~np.isnan(arctic))

    # --- Copernicus ---
    cop = None
    try:
        cop_url, cop_lon, cop_lat = _copernicus_url(bbox)
        log_cog.info(f"  Copernicus URL={cop_url} (center lon={cop_lon:.3f} lat={cop_lat:.3f})")
        cop_resource = {"url": cop_url, "retry": False}
        _audit("cog_requested", "copernicus", detail=cop_resource)
        dst_transform = transform_from_bounds(
            bbox[0], bbox[1], bbox[2], bbox[3], resolution, resolution,
        )
        cop_data = np.empty((resolution, resolution), dtype=np.float32)
        with _open_remote_cog(cop_url) as src:
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
        _audit(
            "cog_completed", "copernicus",
            "success" if cop is not None else "no_data", cop_resource,
        )
    except Exception as exc:
        _audit(
            "cog_completed", "copernicus", "error",
            {**locals().get("cop_resource", {}), "error": type(exc).__name__,
             "message": str(exc)},
        )
        log_cog.warning(f"  Copernicus FAILED: {type(exc).__name__}: {exc}")

    # --- Copernicus expanded bbox retry ---
    if cop is None:
        try:
            dx = (bbox[2] - bbox[0]) * 0.10
            dy = (bbox[3] - bbox[1]) * 0.10
            exp_bbox = (bbox[0] - dx, bbox[1] - dy, bbox[2] + dx, bbox[3] + dy)
            cop_url2, cop_lon2, cop_lat2 = _copernicus_url(exp_bbox)
            log_cog.info(f"  Copernicus retry (expanded bbox +10%): URL={cop_url2}")
            cop_retry_resource = {"url": cop_url2, "retry": True}
            _audit("cog_requested", "copernicus", detail=cop_retry_resource)
            dst_transform2 = transform_from_bounds(
                bbox[0], bbox[1], bbox[2], bbox[3], resolution, resolution,
            )
            cop_data2 = np.empty((resolution, resolution), dtype=np.float32)
            with _open_remote_cog(cop_url2) as src:
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
            _audit(
                "cog_completed", "copernicus",
                "success" if cop is not None else "no_data", cop_retry_resource,
            )
        except Exception as exc:
            _audit(
                "cog_completed", "copernicus", "error",
                {**locals().get("cop_retry_resource", {}),
                 "error": type(exc).__name__, "message": str(exc)},
            )
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

    selected = None
    selected_source = None

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
            selected, selected_source = arctic, 'arcticdem_10m'
        else:
            log_cog.info(f"  WINNER: Copernicus ({cop_valid} vs {arctic_valid} valid pixels)")
            selected, selected_source = cop, 'copernicus'

    elif arctic_ok:
        log_cog.info(f"  Using ArcticDEM (only source with data)")
        selected, selected_source = arctic, 'arcticdem_10m'

    elif cop_ok:
        log_cog.info(f"  Using Copernicus (only source with data)")
        selected, selected_source = cop, 'copernicus'

    if selected is not None:
        return selected, selected_source or 'official_coastline'

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

    depth, col, row = require_tile_id(tile_id)

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
