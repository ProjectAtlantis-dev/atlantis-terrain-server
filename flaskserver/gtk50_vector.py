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
from shapely.geometry import MultiPolygon, Polygon
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
_structure_cache: dict[
    str, list[tuple[str, Polygon, float | None, str | None]] | None
] = {}
_block_lock = threading.Lock()


def block_name(north_idx: int, east_idx: int) -> str:
    return f"{north_idx}_{east_idx:02d}"


def block_path(block: str) -> Path:
    return BLOCK_DIR / f"GL50_Vektordata_100km_{block}.gpkg"


def missing_blocks_for_bbox(bbox) -> list[str]:
    """Block ids this bbox needs that are not on disk.

    This is the whole reason coastline coverage needs no static configuration:
    the requirement is derivable per tile. ``gtk50_demand`` turns the result
    into a download.
    """
    return [b for b in blocks_for_bbox(bbox) if not block_path(b).exists()]


def block_is_usable(block: str) -> bool:
    """True when a local block actually parses into coastline geometry.

    Existence is not enough. A block whose tables are missing or unreadable
    parses to empty water and empty islands, which rasterises as solid land —
    indistinguishable downstream from a genuine inland tile. Checking that the
    parse yields geometry turns that silent wrong answer into a failed
    download that can be retried.
    """
    invalidate_block_cache(block)
    try:
        parsed = _load_block(block)
    except Exception as exc:
        log_vec.warning(
            f"[gtk50] block {block} is unreadable: "
            f"{type(exc).__name__}: {exc}"
        )
        return False
    if parsed is None:
        return False
    water, islands = parsed
    return bool(water) or bool(islands)


def clear_block_cache() -> None:
    """Drop every memoised parse, including memoised misses.

    Any path that has just downloaded blocks must call this before rebuilding
    masks. A long-running server that served tiles over a block while it was
    still downloading has ``None`` cached for it, and the rebuild would then
    skip precisely the tiles the download was meant to repair — silently, since
    a skipped tile just keeps its old WMS mask.
    """
    with _block_lock:
        _block_cache.clear()
        _structure_cache.clear()


def invalidate_block_cache(block: str) -> None:
    """Forget a memoised parse, including a memoised miss.

    ``_load_block`` caches ``None`` for an absent block, so a block downloaded
    while the server is running would keep reading as absent for the life of
    the process without this.
    """
    with _block_lock:
        _block_cache.pop(block, None)
        _structure_cache.pop(block, None)


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
            except sqlite3.OperationalError as exc:
                if "no such table" in str(exc).lower():
                    continue
                raise
            for (blob,) in rows:
                if blob is None:
                    continue
                geom = shapely_wkb.loads(_gpkg_wkb(blob))
                geom = shapely_transform(_to_stereo.transform, geom)
                if isinstance(geom, MultiPolygon):
                    target.extend(geom.geoms)
                elif isinstance(geom, Polygon):
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


def _load_structures(block: str):
    """Return polygon structures in EPSG:3413 for one GTK50 block."""
    with _block_lock:
        if block in _structure_cache:
            return _structure_cache[block]
    path = block_path(block)
    if not path.exists():
        with _block_lock:
            _structure_cache[block] = None
        return None
    structures: list[tuple[str, Polygon, float | None, str | None]] = []
    db = sqlite3.connect(str(path))
    try:
        # The broad building layer covers cabins and isolated utility
        # buildings. Power stations are a separate polygon theme and would be
        # the exact omission this source is intended to close.
        for table in ("building_s", "electricpowerstation_s"):
            try:
                rows = db.execute(
                    f'SELECT id, geom, heightabovesurfacelevel, '
                    f'COALESCE(id_lokalid, CAST(id AS TEXT)) FROM "{table}"'
                ).fetchall()
            except sqlite3.OperationalError as exc:
                if "no such table" in str(exc).lower():
                    continue
                raise
            for row_id, blob, raw_height, local_id in rows:
                if blob is None:
                    continue
                geom = shapely_wkb.loads(_gpkg_wkb(blob))
                geom = shapely_transform(_to_stereo.transform, geom)
                polygons = list(geom.geoms) if isinstance(geom, MultiPolygon) else [geom]
                for part, polygon in enumerate(polygons):
                    if not isinstance(polygon, Polygon) or polygon.is_empty:
                        continue
                    height = None
                    if raw_height is not None and 0.5 <= float(raw_height) <= 200.0:
                        height = float(raw_height)
                    suffix = f":{part}" if len(polygons) > 1 else ""
                    structure_id = f"gtk50:{block}:{table}:{local_id or row_id}{suffix}"
                    structures.append((structure_id, polygon, height, table))
    finally:
        db.close()
    log_vec.info(f"[gtk50] loaded block {block}: {len(structures)} structures")
    with _block_lock:
        _structure_cache[block] = structures
    return structures


def query_structures(
    bbox,
    *,
    ground_sampler,
    ox: float,
    oy: float,
    default_height_m: float = 5.0,
) -> list[dict]:
    """Return camera-local extrusions from available Greenland-wide blocks.

    Missing blocks return no structures while ``gtk50_demand`` downloads them;
    the next normal camera poll sees them. Ground comes from the deepest local
    terrain tile, while GTK50's optional height-above-surface supplies height.
    """
    x0, y0, x1, y1 = (float(value) for value in bbox)
    result: list[dict] = []
    for block in blocks_for_bbox(bbox):
        structures = _load_structures(block)
        if structures is None:
            continue
        for structure_id, polygon, height, table in structures:
            px0, py0, px1, py1 = polygon.bounds
            if px1 < x0 or px0 > x1 or py1 < y0 or py0 > y1:
                continue
            center = polygon.representative_point()
            ground = ground_sampler.sample(center.x, center.y)
            if ground is None:
                # Terrain demand and GTK50 acquisition are asynchronous. A
                # zero base is safer than inventing absolute elevation, and
                # this is recalculated on every response as DEM tiles arrive.
                ground = 0.0
            roof_z = float(ground) + float(height or default_height_m)
            ring = [
                [float(x) - ox, float(y) - oy, roof_z]
                for x, y in polygon.exterior.coords
            ]
            result.append({
                "id": structure_id,
                # Preserve the source classification verbatim. Consumers can
                # interpret the GeoPackage layer name without us inventing a
                # second taxonomy here.
                "sourceLayer": table,
                "groundZ": float(ground),
                "ring": ring,
                # Private reconciliation hints removed before serialization.
                "_center": [float(center.x) - ox, float(center.y) - oy],
            })
    return result


def vector_water_mask(bbox, resolution: int) -> np.ndarray | None:
    """South-first boolean sea mask for an EPSG:3413 bbox, or None.

    None means at least one covering block is not on disk — callers fall
    back to the rendered-WMS authority.
    """
    blocks = [_load_block(b) for b in blocks_for_bbox(bbox)]
    if any(b is None for b in blocks):
        return None
    available_blocks = [block for block in blocks if block is not None]

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
    for water, _ in available_blocks:
        for poly in water:
            wx0, wy0, wx1, wy1 = poly.bounds
            if wx1 < x0 or wx0 > x1 or wy1 < y0 or wy0 > y1:
                continue
            draw.polygon(px(poly.exterior), fill=1)
            for ring in poly.interiors:
                draw.polygon(px(ring), fill=0)
    for _, islands in available_blocks:
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
