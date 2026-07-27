"""Bidirectional coordinate conversion between WGS84 (lat/lon) and NSIDC Polar Stereographic North (EPSG:3413)."""

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
