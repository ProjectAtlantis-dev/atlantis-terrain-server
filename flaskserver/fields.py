"""Per-tile continuous FIELD set for procedural scatter (see PROCGEN_SCATTER_DESIGN.md).

Fuses the summer texture (veg / rock / snow / water) with ArcticDEM channels
(slope / southness / sun / altitude / moisture) into 0..1 rasters. The client's
per-species density rules combine these; nothing is thresholded into hard classes
here (hard classes speckle — fields blend). The land-cover community prior
(WorldCover/CAVM) fuses on top later as comm[k] weights.

Reuses what already works: `guide_assets.classify()` for the north-masked veg
weight (proven on the summer texture), `training_data.terrain_channels()` for DEM.
"""
from __future__ import annotations

import datetime
import struct
import threading
import zlib

import numpy as np
from PIL import Image
from scipy.ndimage import uniform_filter

from classifier.terrain_channels import terrain_channels

# order is the packed-raster channel order; keep stable (clients index by it)
FIELD_KEYS = ["veg", "rock", "snow", "water", "slope", "southness", "sun", "altitude", "moisture"]

FIELD_RES = 64          # served field raster edge (smooth fields — small is plenty)
_PACK_MAGIC = b"FLD1"   # header magic for the packed blob
FIELD_ALGORITHM_VERSION = 3
_CACHE_SCHEMA_LOCK = threading.Lock()


def _up(a: np.ndarray, res: int) -> np.ndarray:
    return np.asarray(Image.fromarray(a.astype(np.float32), "F").resize((res, res), Image.BILINEAR), np.float32)


def _vegetation_weight(rgb: np.ndarray, southness: np.ndarray) -> np.ndarray:
    """Continuous green-excess signal aligned with the current terrain channels."""
    values = rgb.astype(np.float32) / 255.0
    red, green, blue = values[..., 0], values[..., 1], values[..., 2]
    brightness = values.mean(-1)
    saturation = values.max(-1) - values.min(-1)
    excess_green = 2.0 * green - red - blue
    vegetation = np.clip((excess_green - 0.02) * 4.2, 0.0, 1.0)
    snow_like = (brightness > (190.0 / 255.0)) & (saturation < (30.0 / 255.0))
    blue_water = (blue > red + (12.0 / 255.0)) & (blue > green + (6.0 / 255.0))
    vegetation[snow_like | blue_water | (southness < -0.05)] = 0.0
    return vegetation.astype(np.float32)


def compute_fields(
    rgb: np.ndarray,
    heightmap: np.ndarray,
    tile_size_m: float,
    res: int | None = None,
    water_mask: np.ndarray | None = None,
) -> dict:
    """rgb (H,W,3) uint8 summer texture + heightmap (G,G) float32 + tile span (m)
    -> dict of (res,res) float32 fields (0..1, southness -1..1). res defaults to the
    texture edge."""
    res = int(res or rgb.shape[0])
    if rgb.shape[0] != res or rgb.shape[1] != res:
        rgb = np.asarray(Image.fromarray(rgb).resize((res, res), Image.BILINEAR), np.uint8)

    ch = terrain_channels(heightmap, tile_size_m)
    # terrain_channels is DB-oriented (row 0 = south); the texture is image-oriented
    # (row 0 = north). Flip DEM channels to image orientation so they ALIGN with the
    # texture before fusing (same [::-1] the /api/channel endpoint applies).
    ch = {k: np.ascontiguousarray(v[::-1]) for k, v in ch.items()}
    slope = _up(ch["slope"], res)         # tan(angle): 0 flat, 1 = 45deg
    south = _up(ch["southness"], res)     # -1 N-facing .. +1 S-facing
    sun = _up(ch["sun"], res)             # insolation x terrain-shadow (warmth/exposure)
    elev = _up(ch["elev"], res)           # metres

    # --- texture surface signals (continuous) ---
    veg = _vegetation_weight(rgb, south)         # 0..1 vegetation, north-slope-masked
    a = rgb.astype(np.float32) / 255.0
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    bright = a.mean(-1)
    sat = a.max(-1) - a.min(-1)
    snow = np.clip((bright - 0.75) / 0.20, 0, 1) * np.clip(1.0 - sat * 5.0, 0, 1)
    blue = np.clip((b - np.maximum(r, g)) * 3.0, 0, 1)
    # Water fallback: blue flat surfaces can occur at any elevation, but the
    # dark-grey signal is only credible close to sea level. The former
    # `dark OR blue` rule labelled flat, dark coastal tundra as 85% water and
    # suppressed every plant in the player clipmap. Cached SAM masks, when
    # available, replace this heuristic below.
    dark = np.clip((0.36 - bright) / 0.30, 0, 1)
    flat = np.clip(1.0 - slope / 0.15, 0, 1)
    coast = np.clip((8.0 - elev) / 8.0, 0, 1)
    water = np.clip(
        np.maximum(dark * 0.85 * coast, blue * 1.3)
        * flat * (1.0 - veg) * (1.0 - snow),
        0,
        1,
    )
    if water_mask is not None:
        wm = np.asarray(water_mask, np.float32)
        if wm.shape != (res, res):
            wm = _up(wm, res)
        if float(wm.max(initial=0.0)) > 1.0:
            wm = wm / 255.0
        water = np.clip(wm, 0, 1)
    # rock = bare ground (the complement of veg/snow/water), damped in dark shadow
    # so shaded slopes don't all read as bright rock. No baseline inflation.
    greyish = 0.45 + 0.55 * np.clip((bright - 0.28) / 0.35, 0, 1)
    rock = np.clip((1.0 - veg - snow - water).clip(0, 1) * greyish, 0, 1)

    # --- DEM-derived environment fields ---
    amin, amax = float(elev.min()), float(elev.max())
    altitude = (elev - amin) / (amax - amin + 1e-6)         # normalized within tile
    nbhd = uniform_filter(elev, size=max(3, res // 8))
    in_hollow = np.clip((nbhd - elev) / 3.0, 0, 1)          # sits below neighbourhood
    moisture = np.clip(in_hollow * np.clip(1.0 - slope / 0.20, 0, 1), 0, 1)

    return {
        "veg": veg.astype(np.float32), "rock": rock.astype(np.float32),
        "snow": snow.astype(np.float32), "water": water.astype(np.float32),
        # slope/sun clamped to 0..1 (>45deg and very-high insolation both read as
        # "max" for placement; keeps the u8 pack lossless).
        "slope": np.clip(slope, 0, 1).astype(np.float32), "southness": south.astype(np.float32),
        "sun": np.clip(sun, 0, 1).astype(np.float32), "altitude": altitude.astype(np.float32),
        "moisture": moisture.astype(np.float32),
    }


# --- QA composite: texture + each field as a labelled panel ---------------------

_TINT = {  # colour a field's 0..1 ramp so panels read at a glance
    "veg": (60, 200, 60), "rock": (150, 150, 150), "snow": (230, 235, 245),
    "water": (60, 110, 210), "moisture": (70, 150, 220), "slope": (220, 180, 80),
    "sun": (240, 220, 120), "altitude": (200, 200, 200),
}


def qa_composite(rgb: np.ndarray, fields: dict, cols: int = 5) -> np.ndarray:
    """Montage: the texture + one panel per field (value ramps its tint)."""
    res = rgb.shape[0]
    panels = [("texture", rgb.astype(np.float32))]
    for k in FIELD_KEYS:
        f = fields[k]
        v = (f * 0.5 + 0.5) if k == "southness" else np.clip(f, 0, 1)
        tint = np.array(_TINT.get(k, (200, 200, 200)), np.float32)
        panels.append((k, v[..., None] * tint))
    rows = (len(panels) + cols - 1) // cols
    pad = 4
    W = cols * res + (cols + 1) * pad
    H = rows * (res + 16) + (rows + 1) * pad
    out = np.full((H, W, 3), 20, np.float32)
    for i, (name, img) in enumerate(panels):
        rr, cc = divmod(i, cols)
        y = pad + rr * (res + 16) + 16
        x = pad + cc * (res + pad)
        out[y:y + res, x:x + res] = np.clip(img, 0, 255)
        # crude label bar
        out[y - 14:y - 2, x:x + min(res, 8 * len(name))] = 60
    return out.astype(np.uint8)


# --- pack / cache: serve the field set as a compact per-tile blob ----------------
# Blob = zlib( b"FLD1" + u16 res + u8 nfields + u8 flags + nfields*res*res u8 ).
# Channels in FIELD_KEYS order; each 0..1 → 0..255, EXCEPT `southness` stored as
# (x*0.5+0.5) so the client unpacks it as v/255*2-1. Client: inflate → read header
# → Float/Uint8 view per channel, bilinear-sample at world xz.

def pack_fields(fields: dict, res: int = FIELD_RES) -> bytes:
    chans = []
    for k in FIELD_KEYS:
        f = fields[k]
        v = (f * 0.5 + 0.5) if k == "southness" else f
        u8 = np.clip(v, 0, 1)
        if u8.shape[0] != res or u8.shape[1] != res:
            u8 = np.asarray(Image.fromarray((u8 * 255).astype(np.uint8)).resize((res, res), Image.BILINEAR))
        else:
            u8 = (u8 * 255).astype(np.uint8)
        chans.append(u8)
    body = np.stack(chans, 0).tobytes()  # (nfields, res, res) u8
    header = _PACK_MAGIC + struct.pack("<HBB", res, len(FIELD_KEYS), 0)
    return zlib.compress(header + body, 6)


def unpack_fields(blob: bytes) -> dict:
    """Reference decoder (mirrors the client). Returns {key: (res,res) float32}."""
    raw = zlib.decompress(blob)
    assert raw[:4] == _PACK_MAGIC, "bad field blob"
    res, nf, _flags = struct.unpack("<HBB", raw[4:8])
    arr = np.frombuffer(raw[8:], np.uint8).reshape(nf, res, res).astype(np.float32) / 255.0
    out = {}
    for i, k in enumerate(FIELD_KEYS[:nf]):
        out[k] = arr[i] * 2.0 - 1.0 if k == "southness" else arr[i]
    return out


def init_fields_cache(db) -> None:
    # Flask serves field pages concurrently. Serialize the one-time migration
    # so first-load requests cannot both observe the old schema and race the
    # same ALTER TABLE (which otherwise returns a 500 to one requester).
    with _CACHE_SCHEMA_LOCK:
        db.execute(
            "CREATE TABLE IF NOT EXISTS fields ("
            "tile_id TEXT NOT NULL, res INTEGER NOT NULL, blob BLOB NOT NULL, "
            "updated_at TEXT NOT NULL, PRIMARY KEY (tile_id, res))"
        )
        columns = {row[1] for row in db.execute("PRAGMA table_info(fields)")}
        if "algorithm_version" not in columns:
            db.execute("ALTER TABLE fields ADD COLUMN algorithm_version INTEGER NOT NULL DEFAULT 1")
        if "source_version" not in columns:
            db.execute("ALTER TABLE fields ADD COLUMN source_version TEXT NOT NULL DEFAULT ''")
        db.commit()


def read_fields_cache(db, tile_id: str, res: int, source_version: str = "") -> bytes | None:
    row = db.execute(
        "SELECT blob FROM fields WHERE tile_id=? AND res=? "
        "AND algorithm_version=? AND source_version=?",
        (tile_id, res, FIELD_ALGORITHM_VERSION, source_version),
    ).fetchone()
    return row[0] if row else None


def write_fields_cache(
    db, tile_id: str, res: int, blob: bytes, source_version: str = ""
) -> None:
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    db.execute(
        "INSERT OR REPLACE INTO fields "
        "(tile_id, res, blob, updated_at, algorithm_version, source_version) "
        "VALUES (?,?,?,?,?,?)",
        (tile_id, res, blob, now, FIELD_ALGORITHM_VERSION, source_version),
    )
    db.commit()
