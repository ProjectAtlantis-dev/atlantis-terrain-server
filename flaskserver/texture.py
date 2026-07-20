"""Satellite imagery textures for terrain tiles.

TEXTURE UPGRADE CHAIN — DO NOT FUCK WITH THE ORDER:

    ancestor_crop → dataforsyningen → dataforsyningen_enhanced → upscaled

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
- dataforsyningen:          Primary source (SPOT 6/7, 1.6m/0.2m via EPSG:3184).
- dataforsyningen_enhanced: SUPIR upscale of dataforsyningen via ComfyUI.
- upscaled:                 Final upscaled output.

- The enhance path (SUPIR via ComfyUI) ONLY processes dataforsyningen tiles.
  It never fetches from the internet. Never enhance sentinel2.
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
import json
import math
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque

import numpy as np
from PIL import Image, ImageFilter
from rasterio.crs import CRS
from rasterio.transform import from_bounds as transform_from_bounds
from rasterio.warp import Resampling as WarpResampling, reproject, transform_bounds

from colored_log import get_logger
from seam_queue import init_seam_jobs
from terrain_config import ENHANCE_DEPTH

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

# SUPIR/ComfyUI endpoint. Deliberately NOT hardcoded: set COMFY_URL in
# flaskserver/.env (gitignored, sourced by runFlaskServer). Unset = texture
# enhancement disabled — fetch_enhanced_texture returns the no-enhancement
# path instead of dialing a stale address. (A previously hardcoded tailscale
# IP went stale when the GPU box re-enrolled, silently breaking enhancement.)
COMFY_URL = os.environ.get("COMFY_URL", "").rstrip("/")
_UPSCALER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "upscaler")

def _env_bool(name, default=False):
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# SAM-only water mask backend (no heuristic fallback).
# Fixed to SAM2 for the water-mask service.
_SAM_MODEL_ID = "facebook/sam2-hiera-small"
_SAM_POINTS_PER_BATCH = int(os.environ.get("WATER_MASK_SAM_POINTS_PER_BATCH", "64"))
_SAM_SEED_PRECISION_MIN = float(os.environ.get("WATER_MASK_SAM_SEED_PRECISION_MIN", "0.30"))
_SAM_EDGE_BOTTOM_MIN = float(os.environ.get("WATER_MASK_SAM_EDGE_BOTTOM_MIN", "0.08"))
_sam_pipeline = None
_sam_init_lock = threading.Lock()
_sam_infer_lock = threading.Lock()
_sam_supports_points_per_batch = None


def water_mask_model_id():
    return _SAM_MODEL_ID


# ---------------------------------------------------------------------------
# Dataforsyningen Greenland orthophoto WMS (SPOT 6/7 1.6m + aerial 0.2m)
# ---------------------------------------------------------------------------

_DATAFORSYNINGEN_TOKEN = os.environ.get("DATAFORSYNINGEN_TOKEN")
if not _DATAFORSYNINGEN_TOKEN:
    raise RuntimeError("DATAFORSYNINGEN_TOKEN env var is required — see .env")
_DATAFORSYNINGEN_WMS = "https://api.dataforsyningen.dk/wms/gl_satellitfoto"
_DATAFORSYNINGEN_LAYERS = "ortofoto_0_2m_regional,ortofoto_1_6m_regional"


def fetch_dataforsyningen_texture(bbox, resolution=256):
    """Fetch Greenland orthophoto from Dataforsyningen WMS.

    The WMS only supports EPSG:3184, so we transform the bbox from 3413→3184,
    fetch the image, then reproject the result back to 3413.

    Returns (jpeg_bytes, None) on success,
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
    if zero_pct > 50:
        log_tex.warning(f"[DFORSYNINGEN] rejecting {zero_pct:.0f}% zero-fill result (no coverage)")
        return None, 'no_coverage'
    # Reject nearly uniform white frames (provider no-data response at coarse scales).
    if is_white_fill(dst_arr):
        log_tex.warning(f"[DFORSYNINGEN] rejecting white-fill result std={dst_arr.std():.2f} (no coverage)")
        return None, 'no_coverage'
    # Re-encode as JPEG
    img = Image.fromarray(dst_arr)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    log_tex.info(f"[DFORSYNINGEN] OK: {len(buf.getvalue())} bytes, {zero_pct:.0f}% zero")
    return buf.getvalue(), None


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

_WATER_MASK_SCHEMA = """
CREATE TABLE IF NOT EXISTS water_masks (
    tile_id    TEXT PRIMARY KEY,
    source     TEXT NOT NULL,
    mask_png   BLOB NOT NULL,
    coverage   REAL NOT NULL,
    updated_at TEXT NOT NULL
);
"""

def init_textures(db):
    """Create texture + water mask tables if they don't exist."""
    existing = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    db.executescript(_TEXTURE_SCHEMA + _WATER_MASK_SCHEMA)
    init_seam_jobs(db)
    db.commit()
    if "textures" not in existing:
        log_tex.info("Created table: textures")
    if "water_masks" not in existing:
        log_tex.info("Created table: water_masks")


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
            ("ancestor_crop", "dataforsyningen"),
            ("ancestor_crop", "ancestor_crop_ratelimit"),
            ("ancestor_crop", "ancestor_crop_nodata"),
            ("ancestor_crop", "ocean_nodata"),
            ("ancestor_crop_ratelimit", "dataforsyningen"),
            ("ancestor_crop_ratelimit", "ancestor_crop_nodata"),
            ("ancestor_crop_ratelimit", "ocean_nodata"),
            ("ancestor_crop_nodata", "ancestor_crop"),
            ("ancestor_crop_nodata", "ocean_nodata"),
            ("ocean_nodata", "dataforsyningen"),
            ("sentinel2", "dataforsyningen"),
            ("dataforsyningen", "dataforsyningen_enhanced"),
            ("dataforsyningen_enhanced", "upscaled"),
            ("sentinel2_enhanced", "upscaled"),
        }
        msg = (
            f"{tile_id}: replacing {ex_source} "
            f"({ex_updated}, {ex_size}b) with {source} ({len(jpeg_bytes)}b)"
        )
        if ex_source != source and (ex_source, source) not in expected_upgrades:
            log_tex.warning(f"[TEX CLOBBER] {msg}")
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    db.execute(
        "INSERT OR REPLACE INTO textures (tile_id, source, texture, updated_at) "
        "VALUES (?, ?, ?, ?)",
        (tile_id, source, jpeg_bytes, now)
    )
    db.commit()


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


def write_water_mask(db, tile_id, mask_png, source, coverage):
    """Store water mask PNG (L8) for a tile."""
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    db.execute(
        "INSERT OR REPLACE INTO water_masks (tile_id, source, mask_png, coverage, updated_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (tile_id, source, mask_png, float(coverage), now)
    )
    db.commit()


def read_water_mask(db, tile_id):
    """Read cached water mask tuple: (png_bytes, source, coverage) or None."""
    row = db.execute(
        "SELECT mask_png, source, coverage FROM water_masks WHERE tile_id = ?",
        (tile_id,)
    ).fetchone()
    return (row[0], row[1], float(row[2])) if row else None


def water_mask_ids_in(db, tile_ids):
    """Return set of tile_ids that have cached water masks."""
    if not tile_ids:
        return set()
    placeholders = ",".join("?" for _ in tile_ids)
    rows = db.execute(
        f"SELECT tile_id FROM water_masks WHERE tile_id IN ({placeholders})",
        list(tile_ids)
    ).fetchall()
    return {r[0] for r in rows}


def _resample_heightmap(heightmap, resolution):
    """Upsample terrain heightmap to texture resolution."""
    hm_img = Image.fromarray(heightmap.astype(np.float32), mode="F")
    hm_up = hm_img.resize((resolution, resolution), Image.Resampling.BILINEAR)
    return np.array(hm_up, dtype=np.float32)


def _box3_sum(values):
    """3x3 neighborhood sum with edge clamping."""
    h, w = values.shape
    padded = np.pad(values, ((1, 1), (1, 1)), mode="edge")
    out = np.zeros((h, w), dtype=np.float32)
    for dy in range(3):
        for dx in range(3):
            out += padded[dy:dy + h, dx:dx + w]
    return out


def _flood_connected(seed, passable):
    """4-neighbor flood fill from seed within passable mask."""
    h, w = passable.shape
    out = np.zeros((h, w), dtype=bool)
    q = deque()

    ys, xs = np.nonzero(seed & passable)
    for y, x in zip(ys.tolist(), xs.tolist()):
        out[y, x] = True
        q.append((y, x))

    while q:
        y, x = q.popleft()
        if y > 0 and passable[y - 1, x] and not out[y - 1, x]:
            out[y - 1, x] = True
            q.append((y - 1, x))
        if y + 1 < h and passable[y + 1, x] and not out[y + 1, x]:
            out[y + 1, x] = True
            q.append((y + 1, x))
        if x > 0 and passable[y, x - 1] and not out[y, x - 1]:
            out[y, x - 1] = True
            q.append((y, x - 1))
        if x + 1 < w and passable[y, x + 1] and not out[y, x + 1]:
            out[y, x + 1] = True
            q.append((y, x + 1))
    return out


def _get_sam_pipeline():
    global _sam_pipeline
    if _sam_pipeline is not None:
        return _sam_pipeline
    with _sam_init_lock:
        if _sam_pipeline is None:
            from transformers import pipeline as hf_pipeline

            log_tex.info(f"[WATER MASK][SAM2] loading model={_SAM_MODEL_ID}")
            base_kwargs = {
                "task": "mask-generation",
                "model": _SAM_MODEL_ID,
                "device": "cpu",
            }
            try:
                _sam_pipeline = hf_pipeline(use_fast=True, **base_kwargs)
            except Exception as exc:
                msg = str(exc).lower()
                if "use_fast" not in msg and "fast image processor" not in msg:
                    raise
                log_tex.warning(
                    f"[WATER MASK][SAM2] model={_SAM_MODEL_ID} does not support use_fast; "
                    "retrying without use_fast"
                )
                _sam_pipeline = hf_pipeline(**base_kwargs)
    return _sam_pipeline


def _run_sam_mask_generation(pipe, tex):
    global _sam_supports_points_per_batch
    if _sam_supports_points_per_batch is not False:
        try:
            out = pipe(tex, points_per_batch=_SAM_POINTS_PER_BATCH)
            _sam_supports_points_per_batch = True
            return out
        except Exception as exc:
            msg = str(exc).lower()
            if "points_per_batch" not in msg and "unexpected keyword" not in msg:
                raise
            _sam_supports_points_per_batch = False
            log_tex.warning(
                "[WATER MASK][SAM2] points_per_batch unsupported by current pipeline; "
                "retrying without it"
            )
    return pipe(tex)


def _sam_mask_to_bool(mask):
    arr = mask.detach().cpu().numpy() if hasattr(mask, "detach") else np.asarray(mask)
    if arr.ndim == 3:
        arr = arr[:, :, 0]
    if arr.dtype == np.bool_:
        return arr
    if arr.dtype.kind in {"f", "c"}:
        return arr > 0.5
    return arr > 0


def _water_seed_from_rgb(rgb_u8):
    rgb = rgb_u8.astype(np.float32) / 255.0
    r = rgb[:, :, 0]
    g = rgb[:, :, 1]
    b = rgb[:, :, 2]
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    sat = (mx - mn) / np.maximum(mx, 1e-6)
    blue_dom = b - np.maximum(r, g)
    blue_cyan = b - 0.5 * r - 0.35 * g
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    return (np.maximum(blue_dom, blue_cyan) > 0.03) & (sat > 0.03) & (lum < 0.72)


def _score_sam_masks(masks, sam_scores, seed, rgb_u8):
    rgb = rgb_u8.astype(np.float32) / 255.0
    blue_strength = np.maximum(
        rgb[:, :, 2] - np.maximum(rgb[:, :, 0], rgb[:, :, 1]),
        rgb[:, :, 2] - 0.5 * rgb[:, :, 0] - 0.35 * rgb[:, :, 1],
    )
    seed_total = int(seed.sum())
    rows = []
    for i, m in enumerate(masks):
        area = int(m.sum())
        if area <= 0:
            continue
        overlap = int((m & seed).sum())
        precision = overlap / area
        edge_bottom = float(m[-1, :].mean())
        blue_mean = float(blue_strength[m].mean())
        sam = float(sam_scores[i]) if i < len(sam_scores) else 0.0
        score = 2.2 * precision + 1.0 * edge_bottom + 0.8 * blue_mean + 0.05 * sam
        rows.append(
            {
                "mask_index": i,
                "area_px": area,
                "seed_precision": precision,
                "seed_recall": overlap / max(seed_total, 1),
                "edge_bottom": edge_bottom,
                "blue_mean": blue_mean,
                "sam_score": sam,
                "water_score": score,
            }
        )
    rows.sort(key=lambda r: r["water_score"], reverse=True)
    return rows


def build_water_mask(texture_jpeg, heightmap, bbox, resolution=256):
    """Build an L8 water mask using SAM (no heuristic fallback)."""
    _ = heightmap, bbox  # kept for call signature compatibility
    tex = Image.open(io.BytesIO(texture_jpeg)).convert("RGB")
    if tex.size != (resolution, resolution):
        tex = tex.resize((resolution, resolution), Image.Resampling.BILINEAR)
    rgb_u8 = np.asarray(tex, dtype=np.uint8)

    seed = _water_seed_from_rgb(rgb_u8)
    pipe = _get_sam_pipeline()
    with _sam_infer_lock:
        out = _run_sam_mask_generation(pipe, tex)

    if isinstance(out, list):
        if not out:
            raise RuntimeError("SAM returned empty output list")
        out = out[0]
    if not isinstance(out, dict):
        raise RuntimeError(f"SAM returned unsupported output type: {type(out).__name__}")

    raw_masks = out.get("masks")
    if raw_masks is None:
        raise RuntimeError("SAM output missing 'masks'")
    masks = [_sam_mask_to_bool(m) for m in raw_masks]
    if not masks:
        raise RuntimeError("SAM returned no masks")

    scores_tensor = out.get("scores", [])
    sam_scores = (
        scores_tensor.detach().cpu().numpy()
        if hasattr(scores_tensor, "detach")
        else np.asarray(scores_tensor)
    )
    ranked = _score_sam_masks(masks, sam_scores, seed, rgb_u8)

    selected_ids = [
        int(r["mask_index"])
        for r in ranked
        if r["seed_precision"] >= _SAM_SEED_PRECISION_MIN
        and r["edge_bottom"] >= _SAM_EDGE_BOTTOM_MIN
    ]
    water = np.zeros((resolution, resolution), dtype=bool)
    for idx in selected_ids:
        water |= masks[idx]

    mask_u8 = (water.astype(np.uint8) * 255).astype(np.uint8)
    coverage = float(np.mean(water))
    buf = io.BytesIO()
    Image.fromarray(mask_u8, mode="L").save(buf, format="PNG", optimize=True)
    return buf.getvalue(), coverage


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


# ---------------------------------------------------------------------------
# ComfyUI SUPIR upscaler integration
# ---------------------------------------------------------------------------

# Widget names per node type (order matches widgets_values in the workflow)
_WIDGET_MAP = {
    "LoadImage": ["image", "upload"],
    "ImageScale": ["upscale_method", "width", "height", "crop"],
    "SUPIR_model_loader": ["supir_model", "sdxl_model", "fp8_unet", "diffusion_dtype"],
    "SUPIR_encode": ["use_tiled_vae", "encoder_tile_size", "encoder_dtype"],
    "SUPIR_conditioner": ["positive_prompt", "negative_prompt"],
    "SUPIR_sample": ["seed", "steps", "cfg_scale_start", "cfg_scale_end",
                     "EDM_s_churn", "s_noise", "DPMPP_eta",
                     "control_scale_start", "control_scale_end",
                     "restore_cfg", "keep_model_loaded", "sampler"],
    "SUPIR_decode": ["use_tiled_vae", "decoder_tile_size"],
    "SaveImage": ["filename_prefix"],
}


def _assign_widgets(entry, node_type, values):
    names = _WIDGET_MAP.get(node_type, [])
    connected = set(entry["inputs"].keys())
    for i, name in enumerate(names):
        if i < len(values) and name not in connected:
            entry["inputs"][name] = values[i]


def _convert_workflow_to_api(workflow_json):
    """Convert UI-format workflow (nodes/links) to API format."""
    links = {l[0]: l for l in workflow_json["links"]}
    prompt = {}
    for node in workflow_json["nodes"]:
        nid = str(node["id"])
        entry = {"class_type": node["type"], "inputs": {}}
        if "inputs" in node:
            for inp in node["inputs"]:
                link_id = inp.get("link")
                if link_id is not None and link_id in links:
                    link = links[link_id]
                    entry["inputs"][inp["name"]] = [str(link[1]), link[2]]
        if "widgets_values" in node:
            _assign_widgets(entry, node["type"], node["widgets_values"])
        prompt[nid] = entry
    return prompt


def _upload_to_comfy(filename, png_bytes):
    """Upload an image to ComfyUI via POST multipart to /upload/image."""
    boundary = "----ComfyUploadBoundary"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="image"; filename="{filename}"\r\n'
        f"Content-Type: image/png\r\n\r\n"
    ).encode("utf-8") + png_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")

    req = urllib.request.Request(
        f"{COMFY_URL}/upload/image",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
    log_tex.info(f"[COMFY] uploaded {filename}: {result}")
    return result


def _texture_to_png(jpeg_bytes):
    """Convert JPEG bytes to PNG bytes in memory."""
    img = Image.open(io.BytesIO(jpeg_bytes)).convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _submit_upscale(tile_id, texture_jpeg, positive_prompt=None, negative_prompt=None):
    """Submit a SUPIR upscale job to ComfyUI and return the result JPEG bytes."""
    tex_filename = f"tile_{tile_id}_texture.png"
    tex_png = _texture_to_png(texture_jpeg)
    _upload_to_comfy(tex_filename, tex_png)

    workflow_path = os.path.join(_UPSCALER_DIR, "supir_upscaler.json")
    with open(workflow_path) as f:
        workflow = json.load(f)
    prompt = _convert_workflow_to_api(workflow)

    # Patch inputs: node 1 = texture, node 8 = save prefix
    if "1" in prompt:
        prompt["1"]["inputs"]["image"] = tex_filename
    if "8" in prompt:
        prompt["8"]["inputs"]["filename_prefix"] = f"supir_{tile_id}"

    # Patch SUPIR conditioner prompts (node 5) if custom prompts provided
    if "5" in prompt:
        if positive_prompt is not None:
            prompt["5"]["inputs"]["positive_prompt"] = positive_prompt
        if negative_prompt is not None:
            prompt["5"]["inputs"]["negative_prompt"] = negative_prompt

    actual_pos = prompt.get("5", {}).get("inputs", {}).get("positive_prompt", "<MISSING>")
    actual_neg = prompt.get("5", {}).get("inputs", {}).get("negative_prompt", "<MISSING>")
    log_tex.info(f"[COMFY] submitting SUPIR upscale for {tile_id} → {COMFY_URL}")
    log_tex.info(f"[COMFY]   positive_prompt: {actual_pos}")
    log_tex.info(f"[COMFY]   negative_prompt: {actual_neg}")
    payload = json.dumps({"prompt": prompt}).encode("utf-8")
    req = urllib.request.Request(
        f"{COMFY_URL}/prompt",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    resp = urllib.request.urlopen(req, timeout=30)
    result = json.loads(resp.read())
    prompt_id = result.get("prompt_id")
    log_tex.info(f"[COMFY] queued prompt_id={prompt_id} for {tile_id}")

    # Poll for completion
    start = time.time()
    while True:
        elapsed = time.time() - start
        if elapsed > 300:
            raise TimeoutError(f"ComfyUI upscale timed out after {elapsed:.0f}s for {tile_id}")
        time.sleep(2)
        try:
            hist_resp = urllib.request.urlopen(f"{COMFY_URL}/history/{prompt_id}", timeout=10)
            history = json.loads(hist_resp.read())
        except Exception:
            continue
        if prompt_id not in history:
            continue
        entry = history[prompt_id]
        status = entry.get("status", {})
        status_str = status.get("status_str", "")

        if status_str == "error":
            raise RuntimeError(f"ComfyUI upscale failed for {tile_id}: {status}")

        if status_str == "success" or status.get("completed"):
            outputs = entry.get("outputs", {})
            for nid, out in outputs.items():
                if "images" in out:
                    for img_info in out["images"]:
                        fname = img_info["filename"]
                        subfolder = img_info.get("subfolder", "")
                        img_type = img_info.get("type", "output")
                        view_url = (
                            f"{COMFY_URL}/view?"
                            f"filename={urllib.parse.quote(fname)}"
                            f"&type={img_type}"
                        )
                        if subfolder:
                            view_url += f"&subfolder={urllib.parse.quote(subfolder)}"
                        log_tex.info(f"[COMFY] downloading result: {fname}")
                        with urllib.request.urlopen(view_url, timeout=30) as dl_resp:
                            result_png = dl_resp.read()
                        # Convert to JPEG
                        result_img = Image.open(io.BytesIO(result_png)).convert("RGB")
                        buf = io.BytesIO()
                        result_img.save(buf, format="JPEG", quality=90)
                        elapsed = time.time() - start
                        log_tex.info(f"[COMFY] SUPIR upscale done for {tile_id} in {elapsed:.1f}s")
                        return buf.getvalue()
            raise RuntimeError(f"ComfyUI completed but no output images for {tile_id}")

    raise RuntimeError(f"ComfyUI polling loop exited unexpectedly for {tile_id}")


def fetch_enhanced_texture(bbox, resolution=256, s2_jpeg=None, tile_id=None,
                           positive_prompt=None, negative_prompt=None):
    """Enhance an existing dataforsyningen texture via ComfyUI SUPIR upscaler.

    Only works with textures already in the DB — never fetches from the internet.
    Returns (jpeg_bytes, source_string) or (None, None).
    """
    if s2_jpeg is None:
        return None, None

    if not COMFY_URL:
        return None, None

    if tile_id is not None:
        depth = int(tile_id.split("-")[0]) if "-" in tile_id else -1
        if depth == ENHANCE_DEPTH:
            try:
                enhanced = _submit_upscale(tile_id, s2_jpeg,
                                           positive_prompt=positive_prompt,
                                           negative_prompt=negative_prompt)
                return enhanced, "dataforsyningen_enhanced"
            except Exception as e:
                log_tex.error(f"[COMFY] upscale failed for {tile_id}: {type(e).__name__}: {e}")
                return None, None

    return None, None
