"""Google satellite reference mosaics for classifier verification.

Debug and verification ONLY — never served to the browser client, never
stored in terrain.db (the google_refs table was deliberately retired), and
never distributed (see README attribution note). Web-mercator tiles cache
under ``sample/google_refs/`` (gitignored) so repeated verification runs
hit the network once per tile.

Authority is per-class (project rule): Google is the reference for water
bodies and sharp structural boundaries. It is NOT the vegetation
authority — its capture is late spring, so it under-shows green and
over-shows snow exactly where it matters.
"""
from __future__ import annotations

import math
import os
import time
import urllib.request

import numpy as np
from PIL import Image

from colored_log import get_logger
from coords import to_wgs84

log = get_logger("terrain.google-ref")

TILE_URL = "https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}"
CACHE_DIR = os.path.join(os.path.dirname(__file__), "sample", "google_refs")
# z16 ≈ 1.0 m/px at 64°N — matches a d12 tile (~660 m) rendered at 512 px.
DEFAULT_ZOOM = 16
_FETCH_PAUSE_S = 0.05


def _fetch_tile(zoom, x, y, cache_dir, *, allow_network=True):
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, f"z{zoom}_x{x}_y{y}.jpg")
    if not os.path.exists(path):
        if not allow_network:
            raise FileNotFoundError(path)
        request = urllib.request.Request(
            TILE_URL.format(x=x, y=y, z=zoom),
            headers={"User-Agent": "atlantis-terrain classifier verification"},
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            data = response.read()
        with open(path, "wb") as handle:
            handle.write(data)
        time.sleep(_FETCH_PAUSE_S)
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.uint8)


def google_reference(
    bbox, size=512, zoom=DEFAULT_ZOOM, cache_dir=CACHE_DIR,
    *, allow_network=True,
):
    """Google mosaic reprojected onto an EPSG:3413 bbox, image-oriented.

    Returns HxWx3 uint8 (row 0 = north) or None when any tile fetch fails
    (verification then simply skips the Google panels for that tile).
    """
    x = np.linspace(float(bbox[0]), float(bbox[2]), size)
    y = np.linspace(float(bbox[3]), float(bbox[1]), size)  # row 0 = north
    xx, yy = np.meshgrid(x, y)
    lat, lon = to_wgs84(xx, yy)

    n = 1 << zoom
    fx = (lon + 180.0) / 360.0 * n
    lat_rad = np.radians(lat)
    fy = (1.0 - np.arcsinh(np.tan(lat_rad)) / math.pi) / 2.0 * n
    px = np.clip((fx * 256.0).astype(np.int64), 0, n * 256 - 1)
    py = np.clip((fy * 256.0).astype(np.int64), 0, n * 256 - 1)

    tx0, tx1 = int(px.min() // 256), int(px.max() // 256)
    ty0, ty1 = int(py.min() // 256), int(py.max() // 256)
    mosaic = np.zeros(
        ((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256, 3), dtype=np.uint8
    )
    try:
        for ty in range(ty0, ty1 + 1):
            for tx in range(tx0, tx1 + 1):
                tile = _fetch_tile(
                    zoom, tx, ty, cache_dir, allow_network=allow_network
                )
                mosaic[
                    (ty - ty0) * 256:(ty - ty0 + 1) * 256,
                    (tx - tx0) * 256:(tx - tx0 + 1) * 256,
                ] = tile
    except FileNotFoundError:
        # Cache-only callers use absence as a normal "not exported yet" state.
        return None
    except OSError as exc:
        log.warning(
            "Google reference tile unavailable for mosaic "
            f"z{zoom}/{tx0}-{tx1}/{ty0}-{ty1}: "
            f"{type(exc).__name__}: {exc}"
        )
        return None
    return mosaic[py - ty0 * 256, px - tx0 * 256]
