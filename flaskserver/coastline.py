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

import io
import urllib.parse
import urllib.request

import numpy as np
from PIL import Image

from colored_log import get_logger


log_coast = get_logger("terrain.coastline")

OFFICIAL_COASTLINE_VERSION = 1
_WMS_URL = "https://gis.govmin.gl/geoserver/wms"
_WMS_LAYER = "Greenland:gl_aabent_land"
_OVERSAMPLE = 8


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


def apply_official_coastline(heightmap, bbox, resolution: int):
    """Clamp authoritative sea samples to sea level; never alter mapped land.

    If both DEMs have no data, a mask that is entirely sea still yields a valid
    flat ocean tile.  A partial sea mask cannot safely invent missing land and
    therefore remains unresolved for the normal parent fallback.
    """
    water = fetch_official_water_mask(bbox, resolution)
    if water is None:
        return heightmap, False

    if heightmap is None:
        if np.all(water):
            return np.zeros((resolution, resolution), dtype=np.float32), True
        return None, False

    result = np.asarray(heightmap, dtype=np.float32).copy()
    finite_water = water & np.isfinite(result)
    result[finite_water] = np.minimum(result[finite_water], np.float32(0.0))
    result[water & ~np.isfinite(result)] = np.float32(0.0)
    return result, bool(np.any(water))
