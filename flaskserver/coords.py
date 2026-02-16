"""Bidirectional coordinate conversion between WGS84 (lat/lon) and NSIDC Polar Stereographic North (EPSG:3413)."""

import numpy as np
from pyproj import Transformer

# EPSG:3413 - NSIDC Sea Ice Polar Stereographic North
# Centered at 70°N, 45°W. Units: meters.
_to_stereo = Transformer.from_crs("EPSG:4326", "EPSG:3413", always_xy=False)
_to_wgs84 = Transformer.from_crs("EPSG:3413", "EPSG:4326", always_xy=False)


def to_stereo(lat, lon):
    """Convert WGS84 (lat, lon) to polar stereographic (x, y) in meters.

    Accepts scalars or arrays.
    """
    x, y = _to_stereo.transform(lat, lon)
    return x, y


def to_wgs84(x, y):
    """Convert polar stereographic (x, y) in meters to WGS84 (lat, lon).

    Accepts scalars or arrays.
    """
    lat, lon = _to_wgs84.transform(x, y)
    return lat, lon


def distance_stereo(x1, y1, x2, y2):
    """Euclidean distance in meters between two points in polar stereo space."""
    return np.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)


def distance_wgs84(lat1, lon1, lat2, lon2):
    """Haversine distance in meters between two WGS84 points."""
    R = 6_371_000  # Earth mean radius in meters
    lat1, lon1, lat2, lon2 = map(np.radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = np.sin(dlat / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2) ** 2
    return R * 2 * np.arcsin(np.sqrt(a))


def tile_grid(bbox, resolution):
    """Build the canonical sample grid for a tile bbox.

    All pipeline stages (ArcticDEM, external elevation, procedural) MUST use this
    function to generate sample coordinates. This guarantees that adjacent tiles
    share identical values at their common edge — the last sample of tile A at
    x_max is the same world-space point as the first sample of tile B at x_min
    (= A's x_max). One point, one value, no seam.

    Args:
        bbox: (x_min, y_min, x_max, y_max) in EPSG:3413 meters
        resolution: number of samples per axis

    Returns:
        (xs, ys) — 1D arrays of length `resolution`, in EPSG:3413 meters.
        xs runs west-to-east, ys runs south-to-north (row 0 = y_min = south).
    """
    x_min, y_min, x_max, y_max = bbox
    xs = np.linspace(x_min, x_max, resolution)
    ys = np.linspace(y_min, y_max, resolution)
    return xs, ys
