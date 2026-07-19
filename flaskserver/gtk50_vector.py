"""Sea masks rasterized from the Åbent Land Grønland 1:50k vector blocks.

The Databoks ``Vektor_50000`` product ships one GeoPackage per 100 km
GR96/UTM-24N block (``GL50_Vektordata_100km_<N>_<E>.gpkg``, where the
indices are ``floor(northing/100km)`` and ``floor(easting/100km)``).
``ingest_coastline.py`` downloads blocks into ``gtk50_blocks/``.

``tidalwater_s`` polygons are the sea itself (larger islands appear as
interior rings); ``island_s`` covers the rest, so water minus islands is
an exact vector sea mask. When every block covering a bbox is present
locally, this replaces the rendered-WMS blue-pixel decoding in
``coastline.py``. Blocks the FTP does not offer at all (ice sheet, far
ocean) can never be downloaded, so bboxes touching those fall back to
the WMS path.
"""
from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from pyproj import Transformer
from shapely import wkb as shapely_wkb
from shapely.ops import transform as shapely_transform

from colored_log import get_logger

log_vec = get_logger("terrain.gtk50")

VECTOR_SOURCE = "gtk50_vector"
VECTOR_VERSION = 2
BLOCK_DIR = Path(__file__).resolve().parent / "gtk50_blocks"
BLOCK_SIZE_M = 100_000
_OVERSAMPLE = 8
# Data is clipped exactly at block edges; pad the block lookup so a bbox
# grazing an edge always pulls the neighbor too.
_EDGE_PAD_M = 100.0

_to_utm = Transformer.from_crs(3413, 3184, always_xy=True)
_to_stereo = Transformer.from_crs(3184, 3413, always_xy=True)

_block_cache: dict[str, tuple[list, list] | None] = {}
_block_lock = threading.Lock()


def block_name(north_idx: int, east_idx: int) -> str:
    return f"{north_idx}_{east_idx:02d}"


def block_path(block: str) -> Path:
    return BLOCK_DIR / f"GL50_Vektordata_100km_{block}.gpkg"


def blocks_for_bbox(bbox) -> list[str]:
    """100 km UTM-24N block ids intersecting an EPSG:3413 bbox.

    The 3413→3184 image of a rectangle is curved, so sample a point grid
    over the bbox rather than just its corners.
    """
    x0, y0, x1, y1 = (float(v) for v in bbox)
    xs = np.linspace(x0, x1, 5)
    ys = np.linspace(y0, y1, 5)
    gx, gy = np.meshgrid(xs, ys)
    ux, uy = _to_utm.transform(gx.ravel(), gy.ravel())
    e_lo = int((ux.min() - _EDGE_PAD_M) // BLOCK_SIZE_M)
    e_hi = int((ux.max() + _EDGE_PAD_M) // BLOCK_SIZE_M)
    n_lo = int((uy.min() - _EDGE_PAD_M) // BLOCK_SIZE_M)
    n_hi = int((uy.max() + _EDGE_PAD_M) // BLOCK_SIZE_M)
    return [
        block_name(n, e)
        for n in range(n_lo, n_hi + 1)
        for e in range(e_lo, e_hi + 1)
    ]


def _gpkg_wkb(blob: bytes) -> bytes:
    """Strip the GeoPackage binary header, leaving standard WKB."""
    flags = blob[3]
    envelope = (flags >> 1) & 0x07
    envelope_len = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[envelope]
    return bytes(blob[8 + envelope_len:])


def _load_block(block: str):
    """Return (water_polys, island_polys) in EPSG:3413, or None if absent.

    Parsed geometry is cached per process; blocks are immutable downloads.
    """
    with _block_lock:
        if block in _block_cache:
            return _block_cache[block]
    path = block_path(block)
    if not path.exists():
        with _block_lock:
            _block_cache[block] = None
        return None
    water: list = []
    islands: list = []
    db = sqlite3.connect(str(path))
    try:
        for table, target in (("tidalwater_s", water), ("island_s", islands)):
            try:
                rows = db.execute(f'SELECT geom FROM "{table}"').fetchall()
            except sqlite3.OperationalError:
                continue
            for (blob,) in rows:
                if blob is None:
                    continue
                geom = shapely_wkb.loads(_gpkg_wkb(blob))
                geom = shapely_transform(_to_stereo.transform, geom)
                if geom.geom_type == "MultiPolygon":
                    target.extend(geom.geoms)
                elif geom.geom_type == "Polygon":
                    target.append(geom)
    finally:
        db.close()
    log_vec.info(
        f"[gtk50] loaded block {block}: {len(water)} sea polys, "
        f"{len(islands)} islands"
    )
    with _block_lock:
        _block_cache[block] = (water, islands)
    return water, islands


def vector_water_mask(bbox, resolution: int) -> np.ndarray | None:
    """South-first boolean sea mask for an EPSG:3413 bbox, or None.

    None means at least one covering block is not on disk — callers fall
    back to the rendered-WMS authority.
    """
    blocks = [_load_block(b) for b in blocks_for_bbox(bbox)]
    if any(b is None for b in blocks):
        return None

    x0, y0, x1, y1 = (float(v) for v in bbox)
    size = int(resolution) * _OVERSAMPLE
    sx = size / (x1 - x0)
    sy = size / (y1 - y0)

    def px(ring) -> list[tuple[float, float]]:
        coords = np.asarray(ring.coords)
        return list(zip((coords[:, 0] - x0) * sx, (y1 - coords[:, 1]) * sy))

    image = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(image)
    pad = 2 * _OVERSAMPLE  # skip polygons safely outside the raster
    for water, _ in blocks:
        for poly in water:
            wx0, wy0, wx1, wy1 = poly.bounds
            if wx1 < x0 or wx0 > x1 or wy1 < y0 or wy0 > y1:
                continue
            draw.polygon(px(poly.exterior), fill=1)
            for ring in poly.interiors:
                draw.polygon(px(ring), fill=0)
    for _, islands in blocks:
        for poly in islands:
            ix0, iy0, ix1, iy1 = poly.bounds
            if ix1 < x0 or ix0 > x1 or iy1 < y0 or iy0 > y1:
                continue
            draw.polygon(px(poly.exterior), fill=0)

    high_res = np.asarray(image, dtype=np.uint8)
    fractions = high_res.reshape(
        int(resolution), _OVERSAMPLE, int(resolution), _OVERSAMPLE
    ).mean(axis=(1, 3))
    return np.flipud(fractions >= 0.5)
