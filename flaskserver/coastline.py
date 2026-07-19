"""Official Greenland coastline mask from the public Open Land map service.

The ASIAQ technical basemap contains an excellent ``KYSTLINJE`` layer, but its
free downloads cover towns and settlements only (the Nuuk file is roughly
8 x 9 km).  The Greenland Government's public ``gl_aabent_land`` service is
the fjord-wide GTK50 map and is therefore the coastline authority used here.

The service is a rendered WMS rather than a feature service.  We request an
oversampled map and classify its distinctive blue water fill, then aggregate
each block down to one terrain vertex.  Oversampling makes labels, grid lines,
and contours minority pixels instead of holes in the water mask.
"""
from __future__ import annotations

import datetime
import io
import os
import threading
import urllib.parse
import urllib.request
import zlib

import numpy as np
from PIL import Image

from colored_log import get_logger


log_coast = get_logger("terrain.coastline")

OFFICIAL_COASTLINE_VERSION = 1
OFFICIAL_COASTLINE_SOURCE = "govmin_gl_aabent_land"

# Masked water is dropped below sea level at read time so a sea-level water
# surface has volume above the seabed. Bump WATER_FLOOR_VERSION whenever the
# derived geometry changes: open_db() flushes every cached seam on mismatch.
WATER_FLOOR_DROP_M = 10.0
WATER_FLOOR_VERSION = 2
_WMS_URL = "https://gis.govmin.gl/geoserver/wms"
_WMS_LAYER = "Greenland:gl_aabent_land"
_OVERSAMPLE = 8

# Terrain tiles are read repeatedly while the camera is stationary.  Keep the
# operational proof useful without emitting the same coastline line on every
# /api/tiles request.
_logged_effective_tiles: set[str] = set()
_logged_effective_tiles_lock = threading.Lock()


def _fetch_url(url: str, timeout: int = 30) -> bytes:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "atlantis-terrain/official-coastline"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def _water_pixels(rgb: np.ndarray) -> np.ndarray:
    """Identify the blue water cartography without accepting white ice/land."""
    values = rgb.astype(np.int16)
    red, green, blue = values[..., 0], values[..., 1], values[..., 2]
    return (
        (blue >= 145)
        & ((blue - red) >= 18)
        & ((green - red) >= 10)
        & ((blue - green) >= 12)
    )


def fetch_official_water_mask(bbox, resolution: int) -> np.ndarray | None:
    """Return a south-first boolean sea mask for an EPSG:3413 bbox.

    ``None`` means the remote authority was unavailable or returned an invalid
    response.  Callers must retain the unmodified DEM in that case.
    """
    sample_resolution = resolution * _OVERSAMPLE
    params = {
        "SERVICE": "WMS",
        "VERSION": "1.1.1",  # stable x/y bbox order
        "REQUEST": "GetMap",
        "LAYERS": _WMS_LAYER,
        "STYLES": "",
        "SRS": "EPSG:3413",
        "BBOX": ",".join(str(float(value)) for value in bbox),
        "WIDTH": str(sample_resolution),
        "HEIGHT": str(sample_resolution),
        "FORMAT": "image/png",
    }
    url = f"{_WMS_URL}?{urllib.parse.urlencode(params)}"

    try:
        payload = _fetch_url(url)
        with Image.open(io.BytesIO(payload)) as image:
            rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
        expected = (sample_resolution, sample_resolution, 3)
        if rgb.shape != expected:
            raise ValueError(f"unexpected WMS image shape {rgb.shape}, wanted {expected}")

        high_res = _water_pixels(rgb)
        # WMS rows are north-first. Aggregate first, then flip to the database's
        # south-first heightmap convention.
        fractions = high_res.reshape(
            resolution, _OVERSAMPLE, resolution, _OVERSAMPLE
        ).mean(axis=(1, 3))
        return np.flipud(fractions >= 0.45)
    except Exception as exc:
        log_coast.warning(
            f"Official coastline unavailable for bbox="
            f"[{bbox[0]:.0f},{bbox[1]:.0f},{bbox[2]:.0f},{bbox[3]:.0f}]: "
            f"{type(exc).__name__}: {exc}"
        )
        return None


def apply_water_mask(heightmap, water):
    """Return derived render geometry without mutating the raw DEM."""
    if heightmap is None:
        return None
    result = np.asarray(heightmap, dtype=np.float32).copy()
    water = np.asarray(water, dtype=bool)
    if water.shape != result.shape:
        raise ValueError(
            f"water mask shape {water.shape} does not match DEM {result.shape}"
        )
    floor = np.float32(-WATER_FLOOR_DROP_M)
    finite_water = water & np.isfinite(result)
    result[finite_water] = np.minimum(result[finite_water], floor)
    result[water & ~np.isfinite(result)] = floor
    return result


def write_water_mask(
    db,
    tile_id: str,
    water,
    source: str = OFFICIAL_COASTLINE_SOURCE,
    version: int = OFFICIAL_COASTLINE_VERSION,
) -> None:
    mask = np.asarray(water, dtype=np.uint8)
    if mask.ndim != 2:
        raise ValueError("water mask must be a 2D array")
    db.execute(
        "INSERT INTO coastline_masks "
        "(tile_id, width, height, mask, source, version, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(tile_id) DO UPDATE SET width=excluded.width, "
        "height=excluded.height, mask=excluded.mask, source=excluded.source, "
        "version=excluded.version, updated_at=excluded.updated_at",
        (
            tile_id,
            int(mask.shape[1]),
            int(mask.shape[0]),
            zlib.compress(mask.tobytes(), level=6),
            source,
            version,
            datetime.datetime.now(datetime.timezone.utc).isoformat(),
        ),
    )
    # The canonical DEM did not change, but its derived render edge may have.
    # Cached seams must therefore be rebuilt against the new mask.
    from terrain_seams import invalidate_tile_seams

    invalidate_tile_seams(db, tile_id)
    db.commit()


def read_water_mask(db, tile_id: str) -> np.ndarray | None:
    row = db.execute(
        "SELECT width, height, mask FROM coastline_masks WHERE tile_id = ?",
        (tile_id,),
    ).fetchone()
    if row is None:
        return None
    width, height, blob = int(row[0]), int(row[1]), row[2]
    values = np.frombuffer(zlib.decompress(blob), dtype=np.uint8)
    if values.size != width * height:
        raise ValueError(
            f"coastline mask for {tile_id} has {values.size} values; "
            f"expected {width * height}"
        )
    return values.reshape((height, width)).astype(bool)


def cache_official_water_mask(db, tile_id: str, bbox=None, resolution=65):
    if bbox is None:
        row = db.execute(
            "SELECT x_min, y_min, x_max, y_max FROM tiles WHERE tile_id = ?",
            (tile_id,),
        ).fetchone()
        if row is None:
            return None
        bbox = tuple(float(value) for value in row)
    water = None
    if os.environ.get("COASTLINE_VECTOR", "1") != "0":
        from gtk50_vector import VECTOR_SOURCE, VECTOR_VERSION, vector_water_mask

        water = vector_water_mask(bbox, resolution)
        if water is not None:
            write_water_mask(db, tile_id, water, VECTOR_SOURCE, VECTOR_VERSION)
            return water
    water = fetch_official_water_mask(bbox, resolution)
    if water is not None:
        write_water_mask(db, tile_id, water)
    return water


def ensure_water_floor_version(db) -> None:
    """Flush every cached seam once when the derived water geometry changes.

    Seams are baked from effective heightmaps, so a change to how the water
    floor is derived staleness-poisons the whole seam cache even though no
    mask row was rewritten.
    """
    row = db.execute(
        "SELECT value FROM metadata WHERE key = 'water_floor_version'"
    ).fetchone()
    if row is not None and int(row[0]) == WATER_FLOOR_VERSION:
        return
    deleted = db.execute("DELETE FROM terrain_seam_cache").rowcount
    db.execute(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
        ("water_floor_version", str(WATER_FLOOR_VERSION)),
    )
    db.commit()
    log_coast.info(
        f"[coastline] water floor version -> {WATER_FLOOR_VERSION}, "
        f"flushed {deleted} cached seams"
    )


def effective_heightmap(db, tile_id: str, raw_heightmap):
    """Apply a cached mask at read time while preserving stored raw samples.

    Recomputed on every read. Caching the repaired arrays (or the
    decompressed masks) is a possible perf win, deliberately deferred
    until the vector mask pipeline is proven end-to-end.
    """
    water = read_water_mask(db, tile_id)
    if raw_heightmap is None:
        if water is not None and np.all(water):
            return np.full(water.shape, -WATER_FLOOR_DROP_M, dtype=np.float32)
        return None
    if water is None:
        return raw_heightmap
    result = apply_water_mask(raw_heightmap, water)
    with _logged_effective_tiles_lock:
        should_log = tile_id not in _logged_effective_tiles
        if should_log:
            _logged_effective_tiles.add(tile_id)
    if should_log:
        raw = np.asarray(raw_heightmap, dtype=np.float32)
        finite_water = water & np.isfinite(raw)
        raised_water = finite_water & (raw > 0.0)
        source_row = db.execute(
            "SELECT source FROM coastline_masks WHERE tile_id = ?", (tile_id,)
        ).fetchone()
        mask_source = source_row[0] if source_row is not None else "unknown"
        raw_water_max = (
            float(np.max(raw[finite_water])) if np.any(finite_water) else float("nan")
        )
        log_coast.info(
            f"[coastline-apply] tile={tile_id} source={mask_source} "
            f"water_vertices={int(np.sum(water))} "
            f"clamped_vertices={int(np.sum(raised_water))} "
            f"raw_water_max_m={raw_water_max:.3f}"
        )
    return result
