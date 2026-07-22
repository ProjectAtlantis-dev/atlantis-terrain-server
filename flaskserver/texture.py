"""Satellite imagery textures for terrain tiles.

TEXTURE UPGRADE CHAIN — DO NOT FUCK WITH THE ORDER:

    ancestor_crop → dataforsyningen_metatile4h2

TEXTURE SOURCE STATES:
- ancestor_crop:            Cropped from parent at subdivision time. Fresh, untried.
                            Re-fetchable — tex-worker will attempt Dataforsyningen.
- ancestor_crop_ratelimit:  Dataforsyningen returned transient error (429/timeout).
                            Managed by background retry queue with exponential backoff.
- ancestor_crop_nodata:     Dataforsyningen confirmed no coverage. Terminal.
                            Only manual inspect auto-fix can reset it.
- ocean_nodata:             Dataforsyningen confirmed no coverage AND the tile's
                            heightmap is entirely at/below sea level. Flat
                            deep-ocean fill (OCEAN_RGB). Terminal.
- sentinel2_crop:           Legacy Sentinel-2 placeholder. Re-fetchable.
- dataforsyningen:          Legacy independently-fetched tile. Re-fetchable.
- dataforsyningen_metatile: Legacy aligned 2x2 metatile. Re-fetchable.
- dataforsyningen_metatile4: Legacy unharmonized 4x4 metatile. Re-fetchable.
- dataforsyningen_metatile4h: Legacy conservative harmonization. Re-fetchable.
- dataforsyningen_metatile4h2: Primary source (SPOT 6/7, 1.6m/0.2m via
                               EPSG:3184), fetched/reprojected as an aligned
                               4x4 group with edge-driven color harmonization.
- fractal_upscale:          Past WMS_CONTRACT_DEPTH only: the fetched metatile
                            carried no real detail beyond the level above
                            (provider blowup), so the tile was cooked from its
                            parent's final texture by terrain_upscale. Terminal
                            against lateral writes (same standing as
                            dataforsyningen_metatile4h2; the source value is
                            the provenance record) but DERIVED data: any real
                            (non-placeholder) write to the parent texture
                            drops the cooked children so the next demand
                            re-cooks against the new parent.
- write_texture() has an expected_upgrades whitelist. If you add a new source,
  update that whitelist or you'll get TEX CLOBBER warnings.

SEA / OCEAN TILES:
- Sea detection is per-PIXEL in the frontend (elevation ≤ 1m → blue vertex color,
  flattened to 0). This keeps ocean areas from rendering as white voids when
  no texture is available (e.g. east Greenland with no Dataforsyningen coverage).
- There is NO whole-tile "sea" skip. Every tile goes through the normal texture
  upgrade chain regardless of how much ocean it contains. When a texture arrives
  it is applied on top — the blue vertex colors only show through for untextured
  tiles or pixels not covered by the texture.
- Never early-return or skip texture application just because a tile is mostly
  ocean. The parent's texture (or ancestor crop) is always preferable to a blank
  blue square.
"""

import datetime
import io
import math
import os
import urllib.error
import urllib.request

import numpy as np
from PIL import Image, ImageFilter
from rasterio.crs import CRS
from rasterio.transform import from_bounds as transform_from_bounds
from rasterio.warp import Resampling as WarpResampling, reproject, transform_bounds

from colored_log import get_logger

log_tex = get_logger("terrain.tex")


# --- White-fill (provider no-data) detection ------------------------------
# Dataforsyningen's WMS answers no-coverage requests with a uniform white
# frame. This is the single detector for those — used at fetch time, by the
# tex-worker seeding guard, and by purge_white_textures.py. The std guard
# keeps real (textured) snow/ice imagery from matching.
WHITE_FILL_MIN_PCT = 98.0
WHITE_FILL_MAX_STD = 2.0


def is_white_fill(arr):
    """True if an RGB uint8 array is a near-uniform white no-data frame."""
    white_pct = float((arr.min(axis=2) >= 250).mean() * 100.0)
    return white_pct > WHITE_FILL_MIN_PCT and float(arr.std()) < WHITE_FILL_MAX_STD


def is_white_fill_jpeg(jpeg_bytes):
    """is_white_fill() for an encoded image. Undecodable input → False."""
    try:
        arr = np.array(Image.open(io.BytesIO(jpeg_bytes)).convert("RGB"))
    except Exception:
        return False
    return is_white_fill(arr)


def is_no_coverage_fill_jpeg(jpeg_bytes):
    """True when a cropped child is provider white-fill or mostly warp void."""
    try:
        arr = np.array(Image.open(io.BytesIO(jpeg_bytes)).convert("RGB"))
    except Exception:
        return False
    return is_white_fill(arr) or float((arr.max(axis=2) == 0).mean() * 100.0) > 50.0


# Median SPOT 6/7 color over fully-ocean tiles in terrain.db (sampled 2026-07:
# (6,20,25)), nudged blue so deep water reads as water rather than black.
OCEAN_RGB = (6, 20, 30)


def ocean_texture_jpeg(resolution=256):
    """Flat deep-ocean texture for confirmed no-coverage all-water tiles."""
    img = Image.new("RGB", (resolution, resolution), OCEAN_RGB)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()

def repair_white_ocean(jpeg_bytes, heightmap, max_elev_m=0.5, min_frac=0.005):
    """Fill white WMS no-data pixels over ocean with OCEAN_RGB.

    Coastal Dataforsyningen frames come back with real land imagery and white
    fill over the sea — valid frames that pass the whole-image white check.
    Pixels that are BOTH near-white AND at/below sea level per the heightmap
    are provider fill, never imagery (snow/ice sits above sea level, which the
    elevation gate protects).

    heightmap is the tile's GRID_N² float32 array, row 0 = south (the mesh
    convention); images are row 0 = north, so it is flipped before use.

    Returns repaired JPEG bytes, or None if under min_frac needed fixing.
    """
    arr = np.array(Image.open(io.BytesIO(jpeg_bytes)).convert("RGB"))
    white = arr.min(axis=2) >= 250
    if not white.any():
        return None
    # Dilate to swallow the grey JPEG halo along the fill boundary.
    white_img = Image.fromarray(white.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(5))
    white = np.array(white_img) > 127
    hm = np.where(np.isnan(heightmap), 0.0, heightmap)
    ocean_img = Image.fromarray((np.flipud(hm) <= max_elev_m).astype(np.uint8) * 255)
    ocean = np.array(ocean_img.resize((arr.shape[1], arr.shape[0]), Image.Resampling.BILINEAR)) > 127
    mask = white & ocean
    if mask.mean() < min_frac:
        return None
    # Match the tile's own water tone when it has enough real ocean pixels;
    # fall back to the global constant for fully-white tiles.
    real_ocean = ocean & ~white
    if real_ocean.mean() > 0.05:
        fill = tuple(int(v) for v in np.median(arr[real_ocean], axis=0))
    else:
        fill = OCEAN_RGB
    arr[mask] = fill
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="JPEG", quality=85)
    return buf.getvalue()

def _env_bool(name, default=False):
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# ---------------------------------------------------------------------------
# Dataforsyningen Greenland orthophoto WMS (SPOT 6/7 1.6m + aerial 0.2m)
# ---------------------------------------------------------------------------

_DATAFORSYNINGEN_TOKEN = os.environ.get("DATAFORSYNINGEN_TOKEN")
if not _DATAFORSYNINGEN_TOKEN:
    raise RuntimeError("DATAFORSYNINGEN_TOKEN env var is required — see .env")
_DATAFORSYNINGEN_WMS = "https://api.dataforsyningen.dk/wms/gl_satellitfoto"
_DATAFORSYNINGEN_LAYERS = "ortofoto_0_2m_regional,ortofoto_1_6m_regional"


def fetch_dataforsyningen_texture(bbox, resolution=256, lossless=False):
    """Fetch Greenland orthophoto from Dataforsyningen WMS.

    The WMS only supports EPSG:3184, so we transform the bbox from 3413→3184,
    fetch the image, then reproject the result back to 3413.

    Returns (image_bytes, None) on success (JPEG normally, PNG when lossless),
            (None, 'transient') on rate limit / timeout / HTTP error,
            (None, 'no_coverage') when the tile has no imagery.
    """
    # Transform bbox from EPSG:3413 to EPSG:3184
    min_x, min_y, max_x, max_y = bbox
    src_crs = CRS.from_epsg(3413)
    wms_crs = CRS.from_epsg(3184)
    bbox_3184 = transform_bounds(src_crs, wms_crs, min_x, min_y, max_x, max_y, densify_pts=21)
    # Pad 5% to avoid edge clipping
    dx = (bbox_3184[2] - bbox_3184[0]) * 0.05
    dy = (bbox_3184[3] - bbox_3184[1]) * 0.05
    bbox_3184 = (bbox_3184[0] - dx, bbox_3184[1] - dy, bbox_3184[2] + dx, bbox_3184[3] + dy)

    fetch_res = resolution
    bbox_str = f"{bbox_3184[0]},{bbox_3184[1]},{bbox_3184[2]},{bbox_3184[3]}"
    url = (
        f"{_DATAFORSYNINGEN_WMS}?"
        f"token={_DATAFORSYNINGEN_TOKEN}"
        f"&SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap"
        f"&LAYERS={_DATAFORSYNINGEN_LAYERS}"
        f"&CRS=EPSG:3184"
        f"&BBOX={bbox_str}"
        f"&WIDTH={fetch_res}&HEIGHT={fetch_res}"
        f"&FORMAT=image/jpeg"
        f"&STYLES="
    )
    log_tex.info(f"[DFORSYNINGEN] fetching {fetch_res}x{fetch_res} bbox={bbox_str} (EPSG:3184)")
    data = _fetch_url(url, timeout=30)
    if data is None:
        log_tex.warning("[DFORSYNINGEN] fetch returned None (transient)")
        return None, 'transient'
    try:
        img = Image.open(io.BytesIO(data)).convert("RGB")
        src_arr = np.array(img)
    except Exception as e:
        snippet = data[:1000].decode("utf-8", errors="replace") if data else ""
        log_tex.warning(f"[DFORSYNINGEN] decode error: {e} | response: {snippet}")
        return None, 'no_coverage'

    # Reproject from EPSG:3184 to EPSG:3413
    src_h, src_w = src_arr.shape[:2]
    src_transform = transform_from_bounds(*bbox_3184, src_w, src_h)
    dst_crs = CRS.from_epsg(3413)
    dst_transform = transform_from_bounds(min_x, min_y, max_x, max_y, resolution, resolution)

    dst_arr = np.zeros((resolution, resolution, 3), dtype=np.uint8)
    for band in range(3):
        reproject(
            source=src_arr[:, :, band],
            destination=dst_arr[:, :, band],
            src_transform=src_transform,
            src_crs=wms_crs,
            dst_transform=dst_transform,
            dst_crs=dst_crs,
            resampling=WarpResampling.lanczos,
        )

    # Reject if mostly black/empty
    zero_pct = np.mean(dst_arr.max(axis=2) == 0) * 100
    # A metatile may legitimately contain one or more empty children.
    # Validate those children after splitting instead of rejecting useful
    # siblings along with them.
    zero_fill_limit = 50 if resolution <= 256 else 99
    if zero_pct > zero_fill_limit:
        log_tex.warning(f"[DFORSYNINGEN] rejecting {zero_pct:.0f}% zero-fill result (no coverage)")
        return None, 'no_coverage'
    # Reject nearly uniform white frames (provider no-data response at coarse scales).
    if is_white_fill(dst_arr):
        log_tex.warning(f"[DFORSYNINGEN] rejecting white-fill result std={dst_arr.std():.2f} (no coverage)")
        return None, 'no_coverage'
    # Metatiles stay lossless until their children are cropped so each final
    # tile is JPEG-encoded only once.
    img = Image.fromarray(dst_arr)
    buf = io.BytesIO()
    if lossless:
        img.save(buf, format="PNG")
    else:
        img.save(buf, format="JPEG", quality=85)
    log_tex.info(f"[DFORSYNINGEN] OK: {len(buf.getvalue())} bytes, {zero_pct:.0f}% zero")
    return buf.getvalue(), None


def split_texture_metatile(image_bytes, child_resolution=256, grid_size=2, quality=85):
    """Split a north-up square metatile into quadtree child JPEGs.

    Child row coordinates increase northward, while image rows increase
    southward. Keys are therefore ``(column_offset, row_offset)``. Keeping this
    operation downstream of the single metatile
    reprojection makes every sibling use the same source image and pixel grid.
    """
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    expected_size = child_resolution * grid_size
    if image.size != (expected_size, expected_size):
        raise ValueError(
            f"expected {expected_size}x{expected_size} metatile, got "
            f"{image.width}x{image.height}"
        )

    children = {}
    for column_bit in range(grid_size):
        for row_bit in range(grid_size):
            left = column_bit * child_resolution
            top = (grid_size - 1 - row_bit) * child_resolution
            child = image.crop(
                (left, top, left + child_resolution, top + child_resolution)
            )
            buf = io.BytesIO()
            child.save(buf, format="JPEG", quality=quality)
            children[(column_bit, row_bit)] = buf.getvalue()
    return children


def harmonize_texture_metatile(
    image_bytes,
    child_resolution=256,
    grid_size=4,
    strip_width=1,
    feather_width=48,
    smooth_radius=12,
    max_shift=40.0,
):
    """Feather low-frequency provider-mosaic jumps across child boundaries.

    Dataforsyningen can contain acquisition boundaries even inside one WMS
    render. For each internal cut, estimate the slowly varying RGB difference
    between narrow strips on both sides and split the correction symmetrically
    across a feather. Fine texture is preserved and each side moves by at most
    half ``max_shift`` at the boundary.
    """
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    expected_size = child_resolution * grid_size
    if image.size != (expected_size, expected_size):
        raise ValueError(
            f"expected {expected_size}x{expected_size} metatile, got "
            f"{image.width}x{image.height}"
        )
    arr = np.asarray(image, dtype=np.float32).copy()

    def smooth(values):
        if smooth_radius <= 0:
            return values
        kernel_size = smooth_radius * 2 + 1
        kernel = np.ones(kernel_size, dtype=np.float32) / kernel_size
        padded = np.pad(values, ((smooth_radius, smooth_radius), (0, 0)), mode="reflect")
        return np.stack([
            np.convolve(padded[:, band], kernel, mode="valid")
            for band in range(3)
        ], axis=1)

    feather = min(feather_width, child_resolution // 2)
    weights = 0.5 * (
        1.0 + np.cos(np.pi * np.arange(feather, dtype=np.float32) / feather)
    )

    for cut in range(child_resolution, expected_size, child_resolution):
        left = arr[:, cut - strip_width:cut, :].mean(axis=1)
        right = arr[:, cut:cut + strip_width, :].mean(axis=1)
        delta = np.clip(smooth(right - left), -max_shift, max_shift)
        for offset, weight in enumerate(weights):
            arr[:, cut - 1 - offset, :] += delta * (0.5 * weight)
            arr[:, cut + offset, :] -= delta * (0.5 * weight)

    for cut in range(child_resolution, expected_size, child_resolution):
        south = arr[cut - strip_width:cut, :, :].mean(axis=0)
        north = arr[cut:cut + strip_width, :, :].mean(axis=0)
        delta = np.clip(smooth(north - south), -max_shift, max_shift)
        for offset, weight in enumerate(weights):
            arr[cut - 1 - offset, :, :] += delta * (0.5 * weight)
            arr[cut + offset, :, :] -= delta * (0.5 * weight)

    buf = io.BytesIO()
    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).save(buf, format="PNG")
    return buf.getvalue()


# Sentinel-2 Cloudless 2024 (EPSG:3857 / Web Mercator)
_S2_MATRIX_SET = "Goo" "gleMapsCompatible"
S2_URL = (
    "https://tiles.maps.eox.at/wmts/1.0.0/"
    "s2cloudless-2024_3857/default/"
    f"{_S2_MATRIX_SET}/"
    "{z}/{y}/{x}.jpg"
)
S2_HALF_EXTENT = 20037508.342789244  # Web Mercator half-extent


# ---------------------------------------------------------------------------
# SQLite texture storage
# ---------------------------------------------------------------------------

_TEXTURE_SCHEMA = """
CREATE TABLE IF NOT EXISTS textures (
    tile_id    TEXT PRIMARY KEY,
    source     TEXT NOT NULL,
    texture    BLOB NOT NULL,
    updated_at TEXT NOT NULL
);
"""

def init_textures(db):
    """Create texture tables if they don't exist."""
    existing = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    db.executescript(_TEXTURE_SCHEMA)
    db.commit()
    if "textures" not in existing:
        log_tex.info("Created table: textures")


# Workflow endpoints: sources the pipeline must never replace. Overwriting
# one is logged as an error by write_texture (see TEX CLOBBER-TERMINAL).
TERMINAL_SOURCES = {
    "dataforsyningen_metatile4h2",
    "fractal_upscale",
    "ancestor_crop_nodata",
    "ocean_nodata",
}

# Placeholder sources the pipeline may still replace (mirrored by the
# server's temporary set). A parent write in one of these states is not a
# real content change and must not invalidate cooked children.
TEMPORARY_SOURCES = {
    "sentinel2_crop",
    "ancestor_crop",
    "ancestor_crop_ratelimit",
    "dataforsyningen",
    "dataforsyningen_metatile",
    "dataforsyningen_metatile4",
    "dataforsyningen_metatile4h",
}


def drop_fractal_children(db, tile_id):
    """Delete the fractal_upscale subtree under tile_id; returns its ids.

    Cooked tiles are derived data: when the real parent texture changes,
    the derivation is stale. Cooks recurse (a depth-14 tile is cooked from
    a depth-13 cook), so the staleness cascades — every fractal descendant
    of a dropped fractal tile was derived, transitively, from the changed
    parent. Dropping the rows returns them to the missing state, so the
    next demand re-runs the full pipeline (fetch → inspect → cook) level
    by level against the new parent.
    """
    parts = tile_id.split("-")
    if len(parts) != 3:
        return []
    try:
        int(parts[0]), int(parts[1]), int(parts[2])
    except ValueError:
        return []

    stale = []
    frontier = [tile_id]
    while frontier:
        child_ids = []
        for parent in frontier:
            depth, column, row = (int(p) for p in parent.split("-"))
            child_ids.extend(
                f"{depth + 1}-{column * 2 + column_bit}-{row * 2 + row_bit}"
                for column_bit in (0, 1)
                for row_bit in (0, 1)
            )
        placeholders = ",".join("?" for _ in child_ids)
        frontier = [
            r[0] for r in db.execute(
                f"SELECT tile_id FROM textures WHERE tile_id IN ({placeholders}) "
                "AND source = 'fractal_upscale'",
                child_ids,
            ).fetchall()
        ]
        stale.extend(frontier)

    if stale:
        marks = ",".join("?" for _ in stale)
        db.execute(f"DELETE FROM textures WHERE tile_id IN ({marks})", stale)
        try:
            # Cook-derived class maps are stale with their textures.
            db.execute(
                f"DELETE FROM classifier_tiles WHERE tile_id IN ({marks}) "
                "AND source = 'fractal_cook_v1'",
                stale,
            )
        except Exception:
            pass  # classifier storage not initialized in this database
        db.commit()
    return stale


def write_texture(db, tile_id, jpeg_bytes, source):
    """Store a JPEG texture blob in the database."""
    existing = db.execute(
        "SELECT source, updated_at, length(texture) FROM textures WHERE tile_id = ?",
        (tile_id,)
    ).fetchone()
    if existing:
        ex_source, ex_updated, ex_size = existing
        expected_upgrades = {
            ("sentinel2_crop", "sentinel2"),
            ("sentinel2_crop", "dataforsyningen"),
            ("sentinel2_crop", "dataforsyningen_metatile"),
            ("ancestor_crop", "dataforsyningen"),
            ("ancestor_crop", "dataforsyningen_metatile"),
            ("ancestor_crop", "ancestor_crop_ratelimit"),
            ("ancestor_crop", "ancestor_crop_nodata"),
            ("ancestor_crop", "ocean_nodata"),
            ("ancestor_crop_ratelimit", "dataforsyningen"),
            ("ancestor_crop_ratelimit", "dataforsyningen_metatile"),
            ("ancestor_crop_ratelimit", "ancestor_crop_nodata"),
            ("ancestor_crop_ratelimit", "ocean_nodata"),
            ("ancestor_crop_nodata", "ancestor_crop"),
            ("ancestor_crop_nodata", "ocean_nodata"),
            ("ocean_nodata", "dataforsyningen"),
            ("ocean_nodata", "dataforsyningen_metatile"),
            ("sentinel2", "dataforsyningen"),
            ("sentinel2", "dataforsyningen_metatile"),
            ("dataforsyningen", "dataforsyningen_metatile"),
            ("sentinel2_crop", "dataforsyningen_metatile4"),
            ("ancestor_crop", "dataforsyningen_metatile4"),
            ("ancestor_crop_ratelimit", "dataforsyningen_metatile4"),
            ("ocean_nodata", "dataforsyningen_metatile4"),
            ("sentinel2", "dataforsyningen_metatile4"),
            ("dataforsyningen", "dataforsyningen_metatile4"),
            ("dataforsyningen_metatile", "dataforsyningen_metatile4"),
            ("sentinel2_crop", "dataforsyningen_metatile4h"),
            ("ancestor_crop", "dataforsyningen_metatile4h"),
            ("ancestor_crop_ratelimit", "dataforsyningen_metatile4h"),
            ("ocean_nodata", "dataforsyningen_metatile4h"),
            ("sentinel2", "dataforsyningen_metatile4h"),
            ("dataforsyningen", "dataforsyningen_metatile4h"),
            ("dataforsyningen_metatile", "dataforsyningen_metatile4h"),
            ("dataforsyningen_metatile4", "dataforsyningen_metatile4h"),
            ("sentinel2_crop", "dataforsyningen_metatile4h2"),
            ("ancestor_crop", "dataforsyningen_metatile4h2"),
            ("ancestor_crop_ratelimit", "dataforsyningen_metatile4h2"),
            ("ocean_nodata", "dataforsyningen_metatile4h2"),
            ("sentinel2", "dataforsyningen_metatile4h2"),
            ("dataforsyningen", "dataforsyningen_metatile4h2"),
            ("dataforsyningen_metatile", "dataforsyningen_metatile4h2"),
            ("dataforsyningen_metatile4", "dataforsyningen_metatile4h2"),
            ("dataforsyningen_metatile4h", "dataforsyningen_metatile4h2"),
            ("sentinel2_crop", "fractal_upscale"),
            ("ancestor_crop", "fractal_upscale"),
            ("ancestor_crop_ratelimit", "fractal_upscale"),
            ("sentinel2", "fractal_upscale"),
            ("dataforsyningen", "fractal_upscale"),
            ("dataforsyningen_metatile", "fractal_upscale"),
            ("dataforsyningen_metatile4", "fractal_upscale"),
            ("dataforsyningen_metatile4h", "fractal_upscale"),
        }
        msg = (
            f"{tile_id}: replacing {ex_source} "
            f"({ex_updated}, {ex_size}b) with {source} ({len(jpeg_bytes)}b)"
        )
        if ex_source != source and (ex_source, source) not in expected_upgrades:
            if ex_source in TERMINAL_SOURCES:
                # Terminal rows are workflow endpoints (finished provider
                # detail, fractal cooks, confirmed no-coverage). Nothing in
                # the normal pipeline replaces them — this is either a manual
                # reset or a bug losing finished work.
                log_tex.error(f"[TEX CLOBBER-TERMINAL] {msg}")
            else:
                log_tex.warning(f"[TEX CLOBBER] {msg}")
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    db.execute(
        "INSERT OR REPLACE INTO textures (tile_id, source, texture, updated_at) "
        "VALUES (?, ?, ?, ?)",
        (tile_id, source, jpeg_bytes, now)
    )
    db.commit()

    # Cooked descendants are derived from this tile's texture: any real
    # (non-placeholder) change to it makes the whole fractal subtree stale
    # (drop cascades — deep cooks recurse on cooked parents). Cook writes
    # themselves can't invalidate anything: a cook only runs after the
    # parent-change drop already cleared the subtree, so its children
    # don't exist yet.
    if source not in TEMPORARY_SOURCES and source != "fractal_upscale":
        stale = drop_fractal_children(db, tile_id)
        if stale:
            log_tex.info(
                f"[TEX] {tile_id}: parent changed to {source} — dropped stale "
                f"fractal children for re-cook: {', '.join(stale)}"
            )


def read_texture(db, tile_id):
    """Read a JPEG texture blob from the database. Returns bytes or None."""
    row = db.execute(
        "SELECT texture FROM textures WHERE tile_id = ?",
        (tile_id,)
    ).fetchone()
    return row[0] if row else None


def texture_ids_in(db, tile_ids):
    """Return set of tile_ids that have textures cached."""
    if not tile_ids:
        return set()
    placeholders = ",".join("?" for _ in tile_ids)
    rows = db.execute(
        f"SELECT tile_id FROM textures WHERE tile_id IN ({placeholders})",
        list(tile_ids)
    ).fetchall()
    return {r[0] for r in rows}


def texture_sources_in(db, tile_ids):
    """Return {tile_id: source} for the cached subset of tile_ids."""
    if not tile_ids:
        return {}
    placeholders = ",".join("?" for _ in tile_ids)
    rows = db.execute(
        f"SELECT tile_id, source FROM textures WHERE tile_id IN ({placeholders})",
        list(tile_ids)
    ).fetchall()
    return {r[0]: r[1] for r in rows}


# A past-contract-depth metatile is a provider blowup when EITHER statistic
# falls below its floor. Floors are empirical (synthetic real imagery scores
# recon≈0.86 / spectral≈2.1; blowups ≤0.21 / ≤0.05, nearest-neighbour carve
# 0.0 / 0.53); tune from the pair logged on every past-contract fetch.
METATILE_RECON_MIN = 0.35
METATILE_SPECTRAL_MIN = 0.15


def metatile_upsample_scores(image_bytes):
    """(reconstruction, spectral) evidence of detail beyond half resolution.

    Reconstruction: rebuild the image from its own half-res reduction with
    several kernels and take the best fit, normalized by the image's overall
    high-frequency content. A carve/blowup is reconstructible (→ 0); genuine
    imagery is not. Catches nearest-neighbour quad duplication exactly.

    Spectral: power beyond radial frequency 0.30 cycles/px relative to the
    0.125–0.25 band. Any smooth upsampling kernel is a lowpass at 0.25, so
    blowups have near-empty outer bands regardless of kernel choice.

    Both are contrast-invariant, so faint-but-genuine tundra detail scores
    like high-contrast terrain.
    """
    with Image.open(io.BytesIO(image_bytes)) as image:
        gray = np.asarray(image.convert("L"), dtype=np.float32)
    height, width = gray.shape
    if min(height, width) < 8:
        return 1.0, 1.0
    full = Image.fromarray(gray, mode="F")

    best_residual = None
    for down_kernel in (Image.Resampling.LANCZOS, Image.Resampling.BOX):
        down = full.resize((width // 2, height // 2), down_kernel)
        for up_kernel in (
            Image.Resampling.LANCZOS,
            Image.Resampling.BICUBIC,
            Image.Resampling.BILINEAR,
            Image.Resampling.NEAREST,
        ):
            up = np.asarray(down.resize((width, height), up_kernel), dtype=np.float32)
            residual = float(np.sqrt(np.mean((gray - up) ** 2)))
            best_residual = (
                residual if best_residual is None else min(best_residual, residual)
            )
    quarter = full.resize((width // 4, height // 4), Image.Resampling.LANCZOS)
    smooth = np.asarray(
        quarter.resize((width, height), Image.Resampling.LANCZOS), dtype=np.float32
    )
    high_frequency_rms = float(np.sqrt(np.mean((gray - smooth) ** 2)))
    reconstruction = best_residual / (high_frequency_rms + 1e-6)

    spectrum = np.abs(np.fft.rfft2(gray - gray.mean())) ** 2
    frequency_y = np.fft.fftfreq(height)[:, None]
    frequency_x = np.fft.rfftfreq(width)[None, :]
    radial = np.sqrt(frequency_x * frequency_x + frequency_y * frequency_y)
    outer = spectrum[(radial > 0.30) & (radial <= 0.5)].sum()
    mid = spectrum[(radial > 0.125) & (radial <= 0.25)].sum()
    spectral = float(outer / (mid + 1e-9))
    return reconstruction, spectral


def metatile_is_upsampled(image_bytes):
    """Return (is_upsampled, reconstruction_score, spectral_score)."""
    reconstruction, spectral = metatile_upsample_scores(image_bytes)
    cheated = (
        reconstruction < METATILE_RECON_MIN or spectral < METATILE_SPECTRAL_MIN
    )
    return cheated, reconstruction, spectral


# ---------------------------------------------------------------------------
# HTTP helper
# ---------------------------------------------------------------------------

def _fetch_url(url, timeout=30, retries=3):
    """Fetch URL bytes, return None on error. Retries on 429/503 with backoff."""
    import time as _time
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "greenland-terrain/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < retries - 1:
                _time.sleep(2 ** attempt)
                continue
            host = url.split('/')[2] if '/' in url else url
            log_tex.warning(f"[FETCH] HTTP {e.code} from {host} (after {attempt + 1} tries)")
            return None
        except urllib.error.URLError as e:
            log_tex.warning(f"[FETCH] URL error for {url}: {e.reason}")
            return None
        except Exception as e:
            log_tex.warning(f"[FETCH] {type(e).__name__} for {url}: {e}")
            return None
    return None


# ---------------------------------------------------------------------------
# Sentinel-2 Cloudless (EOX): fetch, reproject, encode
# ---------------------------------------------------------------------------

def _bbox_to_3857(bbox):
    """Transform EPSG:3413 bbox to EPSG:3857 with edge densification."""
    b = transform_bounds(CRS.from_epsg(3413), CRS.from_epsg(3857), *bbox, densify_pts=21)
    dx = (b[2] - b[0]) * 0.05
    dy = (b[3] - b[1]) * 0.05
    return (b[0] - dx, b[1] - dy, b[2] + dx, b[3] + dy)


def _choose_s2_zoom(bbox, target_px=256):
    """Choose Sentinel-2 zoom level to roughly match output resolution."""
    tile_width = bbox[2] - bbox[0]
    target_mpp = tile_width / target_px
    full_extent = 2 * S2_HALF_EXTENT
    z = math.log2(full_extent / (target_mpp * 256))
    return max(1, min(14, round(z)))


def fetch_sentinel2_texture(bbox, resolution=256):
    """Fetch Sentinel-2 imagery for a tile bbox, reproject to EPSG:3413."""
    bbox_3857 = _bbox_to_3857(bbox)
    z = _choose_s2_zoom(bbox, resolution)

    full_extent = 2 * S2_HALF_EXTENT
    tile_span = full_extent / (1 << z)

    tx_min = max(0, int((bbox_3857[0] + S2_HALF_EXTENT) / tile_span))
    tx_max = min((1 << z) - 1, int((bbox_3857[2] + S2_HALF_EXTENT) / tile_span))
    ty_min = max(0, int((S2_HALF_EXTENT - bbox_3857[3]) / tile_span))
    ty_max = min((1 << z) - 1, int((S2_HALF_EXTENT - bbox_3857[1]) / tile_span))

    n_tx = tx_max - tx_min + 1
    n_ty = ty_max - ty_min + 1
    n_tiles = n_tx * n_ty
    if n_tiles > 64:
        log_tex.warning(f"[S2 FETCH] too many source tiles ({n_tiles}) for z={z}, skipping")
        return None

    src_tile_px = 256
    src_w = n_tx * src_tile_px
    src_h = n_ty * src_tile_px
    src_img = np.zeros((src_h, src_w, 3), dtype=np.uint8)

    fetched = 0
    failed = 0
    for ty_idx, ty in enumerate(range(ty_min, ty_max + 1)):
        for tx_idx, tx in enumerate(range(tx_min, tx_max + 1)):
            url = S2_URL.format(z=z, y=ty, x=tx)
            data = _fetch_url(url, timeout=15)
            if data is None:
                failed += 1
                continue
            try:
                img = Image.open(io.BytesIO(data)).convert("RGB")
                arr = np.array(img)
                y0 = ty_idx * src_tile_px
                x0 = tx_idx * src_tile_px
                h, w = arr.shape[:2]
                src_img[y0:y0 + h, x0:x0 + w] = arr
                fetched += 1
            except Exception as e:
                log_tex.warning(f"[S2 FETCH] decode error for z={z}/{ty}/{tx}: {e}")
                failed += 1

    if fetched == 0:
        log_tex.error(f"[S2 FETCH] TOTAL FAILURE: 0/{n_tiles} tiles fetched (z={z}), {failed} failed")
        return None
    if failed > 0:
        log_tex.warning(f"[S2 FETCH] partial: {fetched}/{n_tiles} ok, {failed} failed (z={z})")

    src_x_min = -S2_HALF_EXTENT + tx_min * tile_span
    src_y_max = S2_HALF_EXTENT - ty_min * tile_span
    src_x_max = src_x_min + n_tx * tile_span
    src_y_min = src_y_max - n_ty * tile_span

    src_transform = transform_from_bounds(src_x_min, src_y_min, src_x_max, src_y_max, src_w, src_h)
    src_crs = CRS.from_epsg(3857)

    dst_transform = transform_from_bounds(bbox[0], bbox[1], bbox[2], bbox[3], resolution, resolution)
    dst_crs = CRS.from_epsg(3413)

    dst_img = np.zeros((resolution, resolution, 3), dtype=np.uint8)
    for band in range(3):
        reproject(
            source=src_img[:, :, band],
            destination=dst_img[:, :, band],
            src_transform=src_transform,
            src_crs=src_crs,
            dst_transform=dst_transform,
            dst_crs=dst_crs,
            resampling=WarpResampling.bilinear,
        )

    zero_pct = np.mean(dst_img.max(axis=2) == 0) * 100
    if zero_pct > 50:
        log_tex.warning(f"[S2 FETCH] rejecting {zero_pct:.0f}% zero-fill result")
        return None

    img = Image.fromarray(dst_img)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()
