"""Flask-owned access to the shared asset catalog.

The browser never opens or addresses the asset service directly.  Terrain-
coupled reads happen here so Flask can spatially reconcile assets with the
tile/texture being served.
"""
from __future__ import annotations

import colorsys
import io
import json
import math
import sqlite3
import statistics
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw

from terrain_config import GREENLAND_BBOX


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ASSETS_DB_PATH = ROOT / "assetserver" / "assets.db"
DEFAULT_METADATA_PATH = ROOT / "assetserver" / "assets_metadata.json"

ROAD_SUPERSAMPLE = 4
DEFAULT_LINE_WIDTH_M = 3.0
_BUILDING_COLOR_CACHE: dict[tuple[str, str, str], tuple[int, int, int]] = {}


def connect(path: Path = DEFAULT_ASSETS_DB_PATH) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(path), timeout=5.0)
    db.execute("PRAGMA busy_timeout=5000")
    db.execute("PRAGMA journal_mode=WAL")
    db.execute(
        "CREATE TABLE IF NOT EXISTS assets ("
        "id TEXT PRIMARY KEY,type TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,"
        "lat REAL NOT NULL,lon REAL NOT NULL,heading_deg REAL NOT NULL DEFAULT 0,"
        "z REAL,properties TEXT NOT NULL DEFAULT '{}',saved_at REAL,"
        "updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,"
        "cx REAL,cy REAL,min_x REAL,min_y REAL,max_x REAL,max_y REAL)"
    )
    columns = {row[1] for row in db.execute("PRAGMA table_info(assets)")}
    required = {"cx", "cy", "min_x", "min_y", "max_x", "max_y"}
    missing = sorted(required - columns)
    if missing:
        db.close()
        raise RuntimeError(
            "assets.db has an obsolete schema; purge and reload it "
            f"(missing: {', '.join(missing)})"
        )
    db.execute("CREATE INDEX IF NOT EXISTS idx_assets_cxy ON assets(cx,cy)")
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_assets_bounds "
        "ON assets(type,min_x,max_x,min_y,max_y)"
    )
    db.commit()
    return db


def _properties(raw: str) -> dict[str, Any]:
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("asset properties must decode to a JSON object")
    return value


def query_asset_by_type(
    db: sqlite3.Connection,
    asset_type: str,
    qx: float,
    qy: float,
    max_range: float,
) -> list[dict[str, Any]]:
    rows = db.execute(
        "SELECT id, type, properties FROM assets "
        "WHERE type = ? AND enabled = 1 "
        "AND cx BETWEEN ? AND ? AND cy BETWEEN ? AND ? LIMIT 20000",
        (
            asset_type,
            qx - max_range, qx + max_range,
            qy - max_range, qy + max_range,
        ),
    ).fetchall()
    return [
        {"id": asset_id, "type": row_type, "properties": _properties(raw)}
        for asset_id, row_type, raw in rows
    ]


def _point_in_polygon(x: float, y: float, polygon: list[tuple[float, float]]) -> bool:
    inside = False
    previous = polygon[-1]
    for current in polygon:
        if ((current[1] > y) != (previous[1] > y)):
            crossing = (
                (previous[0] - current[0]) * (y - current[1])
                / (previous[1] - current[1]) + current[0]
            )
            if x < crossing:
                inside = not inside
        previous = current
    return inside


def _hue_saturation(rgb: "np.ndarray") -> tuple["np.ndarray", "np.ndarray"]:
    """Vectorised colorsys.rgb_to_hsv hue/saturation for an (N, 3) 0-255 array."""
    scaled = rgb / 255.0
    maxc = scaled.max(axis=1)
    minc = scaled.min(axis=1)
    span = maxc - minc
    with np.errstate(invalid="ignore", divide="ignore"):
        saturation = np.where(maxc == 0, 0.0, span / np.where(maxc == 0, 1.0, maxc))
        safe_span = np.where(span == 0, 1.0, span)
        rc = (maxc - scaled[:, 0]) / safe_span
        gc = (maxc - scaled[:, 1]) / safe_span
        bc = (maxc - scaled[:, 2]) / safe_span
    hue = np.zeros_like(maxc)
    red_max = scaled[:, 0] == maxc
    green_max = (~red_max) & (scaled[:, 1] == maxc)
    blue_max = ~(red_max | green_max)
    hue[red_max] = (bc - gc)[red_max]
    hue[green_max] = (2.0 + rc - bc)[green_max]
    hue[blue_max] = (4.0 + gc - rc)[blue_max]
    hue = (hue / 6.0) % 1.0
    # colorsys returns hue 0 for a greyscale pixel rather than a wrapped value.
    hue[span == 0] = 0.0
    return hue, saturation


def _rgb_pixel(image: Image.Image, x: int, y: int) -> tuple[int, int, int]:
    """Read a statically typed RGB triple from any Pillow image mode."""
    pixel = image.getpixel((x, y))
    if isinstance(pixel, tuple):
        return int(pixel[0]), int(pixel[1]), int(pixel[2])
    if pixel is None:
        return 0, 0, 0
    value = int(pixel)
    return value, value, value


def _roof_color(pixels) -> tuple[int, int, int] | None:
    """Weighted roof color, preferring non-earth pixels inside the footprint.

    Accepts an (N, 3) array or any sequence of RGB triples.
    """
    pixels = np.asarray(pixels, dtype=np.float64)
    if pixels.size == 0:
        return None
    brightness = pixels.sum(axis=1) / 3.0
    usable = (brightness >= 20) & (brightness <= 248)
    if not usable.any():
        return None
    kept = pixels[usable]
    hue, saturation = _hue_saturation(kept)
    earth_tone = (hue >= 0.055) & (hue <= 0.46) & (saturation >= 0.12)
    # Earth tones are the surrounding ground bleeding in, so they carry the
    # least weight; saturated roof materials carry the most.
    weight = np.where(
        earth_tone, 1.0, np.where(saturation < 0.12, 2.0, 4.0),
    )
    total = weight.sum()
    channels = (kept * weight[:, None]).sum(axis=0) / total
    return (
        int(round(float(channels[0]))),
        int(round(float(channels[1]))),
        int(round(float(channels[2]))),
    )


def _sample_footprint_color(
    image: "np.ndarray",
    ring: list[list[float]],
    bbox: tuple[float, float, float, float],
) -> tuple[int, int, int] | None:
    """Roof colour for one footprint, sampled from an (H, W, 3) uint8 array.

    Rasterising the polygon with numpy rather than testing each pixel in
    Python is what makes flying into an uncached settlement cheap: the scalar
    version ran a point-in-polygon test and a PIL ``getpixel`` per pixel, which
    came to 1.75M and 780k calls respectively for one Nuuk-sized request.
    """
    height, width = image.shape[0], image.shape[1]
    x_min, y_min, x_max, y_max = bbox
    span_x, span_y = x_max - x_min, y_max - y_min
    polygon = [
        ((point[0] - x_min) / span_x * width,
         (y_max - point[1]) / span_y * height)
        for point in ring
    ]
    left = max(0, int(math.floor(min(point[0] for point in polygon))))
    right = min(width - 1, int(math.ceil(max(point[0] for point in polygon))))
    top = max(0, int(math.floor(min(point[1] for point in polygon))))
    bottom = min(height - 1, int(math.ceil(max(point[1] for point in polygon))))

    if right >= left and bottom >= top:
        grid_x = np.arange(left, right + 1, dtype=np.float64) + 0.5
        grid_y = np.arange(top, bottom + 1, dtype=np.float64) + 0.5
        xs = grid_x[None, :]
        ys = grid_y[:, None]
        # Even-odd ray casting, one edge at a time across the whole crop. A
        # horizontal edge can never toggle the crossing test, so it is skipped
        # and never divides by zero.
        inside = np.zeros((len(grid_y), len(grid_x)), dtype=bool)
        previous = polygon[-1]
        for current in polygon:
            denominator = previous[1] - current[1]
            if denominator != 0:
                straddles = (current[1] > ys) != (previous[1] > ys)
                crossing = (
                    (previous[0] - current[0]) * (ys - current[1]) / denominator
                    + current[0]
                )
                inside ^= straddles & (xs < crossing)
            previous = current
        selected = image[top:bottom + 1, left:right + 1][inside]
    else:
        selected = np.empty((0, 3), dtype=image.dtype)

    if len(selected) == 0:
        center_x = max(0, min(width - 1, int(round(sum(p[0] for p in polygon) / len(polygon)))))
        center_y = max(0, min(height - 1, int(round(sum(p[1] for p in polygon) / len(polygon)))))
        selected = image[center_y:center_y + 1, center_x]
    return _roof_color(selected.astype(np.float64, copy=False))


# The textured-tile lookup behind roof colours had the same two costs the
# ground sampler did: an unindexed tiles/textures join re-run every request
# (~276ms), then a linear scan of its result per building. The camera barely
# moves between one-second polls, so the join is cached with padding, and the
# per-building lookup addresses the quadtree directly instead of scanning.
_TEXTURED_TILE_PAD_M = 2000.0
_TEXTURED_TILE_TTL_S = 15.0
_textured_tile_lock = threading.Lock()
_textured_tile_state: dict[str, Any] = {
    "bbox": None, "version": None, "at": 0.0, "by_depth": None, "depths": None,
}


def _textured_tile_index(terrain_db, bounds):
    """Depth-keyed index of texture-backed tiles covering ``bounds``."""
    # Key the cache to the database file. Connections are per-request, so their
    # identity is useless, but two different databases must never share an
    # index. In-memory databases all report an empty path and cannot be told
    # apart, so they simply do not cache.
    try:
        row = terrain_db.execute("PRAGMA database_list").fetchone()
        db_key = row[2] if row else None
    except Exception:
        db_key = None
    if not db_key:
        return _load_textured_tile_index(terrain_db, bounds)[:2]

    try:
        version = terrain_db.execute("PRAGMA data_version").fetchone()[0]
    except Exception:
        version = None
    now = time.monotonic()
    with _textured_tile_lock:
        loaded = _textured_tile_state["bbox"]
        if (
            loaded is not None
            and _textured_tile_state.get("db") == db_key
            and _textured_tile_state["version"] == version
            and now - _textured_tile_state["at"] < _TEXTURED_TILE_TTL_S
            and loaded[0] <= bounds[0] and loaded[1] <= bounds[1]
            and loaded[2] >= bounds[2] and loaded[3] >= bounds[3]
        ):
            return _textured_tile_state["by_depth"], _textured_tile_state["depths"]

    by_depth, depths, padded = _load_textured_tile_index(terrain_db, bounds)
    with _textured_tile_lock:
        _textured_tile_state.update(
            bbox=padded, version=version, at=now, db=db_key,
            by_depth=by_depth, depths=depths,
        )
    return by_depth, depths


def _load_textured_tile_index(terrain_db, bounds):
    """Query and index texture-backed tiles; returns (by_depth, depths, bbox)."""
    padded = (
        bounds[0] - _TEXTURED_TILE_PAD_M, bounds[1] - _TEXTURED_TILE_PAD_M,
        bounds[2] + _TEXTURED_TILE_PAD_M, bounds[3] + _TEXTURED_TILE_PAD_M,
    )
    rows = [
        tuple(row) for row in terrain_db.execute(
            "SELECT t.tile_id,t.depth,t.x_min,t.y_min,t.x_max,t.y_max,"
            "x.updated_at "
            "FROM tiles t JOIN textures x ON x.tile_id=t.tile_id "
            "WHERE t.x_min <= ? AND t.x_max >= ? AND t.y_min <= ? AND t.y_max >= ? "
            "ORDER BY t.depth DESC",
            (padded[2], padded[0], padded[3], padded[1]),
        )
    ]
    # Address tiles by their position on the quadtree grid. Real tiles are
    # always grid-aligned; synthetic ones (tests) need not be, and addressing
    # them would silently drop colours, so fall back to the original scan.
    rx_min, ry_min, rx_max, ry_max = GREENLAND_BBOX
    by_depth: dict[int, dict[tuple[int, int], tuple]] = {}
    aligned = True
    for row in rows:
        depth, x_min, y_min = row[1], row[2], row[3]
        n_tiles = 1 << depth
        tile_w = (rx_max - rx_min) / n_tiles
        tile_h = (ry_max - ry_min) / n_tiles
        col = round((x_min - rx_min) / tile_w)
        grid_row = round((y_min - ry_min) / tile_h)
        if (
            abs(rx_min + col * tile_w - x_min) > tile_w * 1e-6
            or abs(ry_min + grid_row * tile_h - y_min) > tile_h * 1e-6
        ):
            aligned = False
            break
        by_depth.setdefault(depth, {})[(col, grid_row)] = row
    if aligned:
        return by_depth, sorted(by_depth, reverse=True), padded
    return None, rows, padded


def _deepest_tile_at(by_depth, depths, x, y):
    """Deepest texture-backed tile containing the point, or None.

    ``by_depth`` is None when the tile set is not grid-aligned; ``depths`` then
    carries the depth-ordered rows for a direct scan.
    """
    if by_depth is None:
        for tile in depths:
            if tile[2] <= x < tile[4] and tile[3] <= y < tile[5]:
                return tile
        return None
    rx_min, ry_min, rx_max, ry_max = GREENLAND_BBOX
    span_x = rx_max - rx_min
    span_y = ry_max - ry_min
    for depth in depths:
        n_tiles = 1 << depth
        col = int((x - rx_min) / span_x * n_tiles)
        row = int((y - ry_min) / span_y * n_tiles)
        tile = by_depth[depth].get((col, row))
        # The stored bbox stays authoritative, matching the previous scan.
        if tile is not None and tile[2] <= x < tile[4] and tile[3] <= y < tile[5]:
            return tile
    return None


def color_buildings_from_textures(
    terrain_db: sqlite3.Connection,
    buildings: list[dict[str, Any]],
    ox: float,
    oy: float,
) -> None:
    """Attach derived roof colors from the deepest cached imagery in-place."""
    if not buildings:
        return
    absolute_rings = {
        building["id"]: [[point[0] + ox, point[1] + oy, point[2]] for point in building["ring"]]
        for building in buildings
    }
    centers = {
        asset_id: (
            sum(point[0] for point in ring) / len(ring),
            sum(point[1] for point in ring) / len(ring),
        )
        for asset_id, ring in absolute_rings.items()
    }
    query_bounds = (
        min(center[0] for center in centers.values()),
        min(center[1] for center in centers.values()),
        max(center[0] for center in centers.values()),
        max(center[1] for center in centers.values()),
    )
    by_depth, depths = _textured_tile_index(terrain_db, query_bounds)

    assignments: dict[str, tuple] = {}
    for building in buildings:
        cx, cy = centers[building["id"]]
        tile = _deepest_tile_at(by_depth, depths, cx, cy)
        if isinstance(tile, tuple):
            assignments[building["id"]] = tile
    grouped: dict[str, list[dict[str, Any]]] = {}
    for building in buildings:
        tile = assignments.get(building["id"])
        if tile:
            grouped.setdefault(tile[0], []).append(building)
    for tile_id, group in grouped.items():
        tile = assignments[group[0]["id"]]
        version = str(tile[6])
        uncached = [
            building for building in group
            if (building["id"], tile_id, version) not in _BUILDING_COLOR_CACHE
        ]
        image = None
        if uncached:
            row = terrain_db.execute(
                "SELECT texture FROM textures WHERE tile_id=?", (tile_id,)
            ).fetchone()
            if row:
                # Decoded once per tile, then sampled per footprint as an array.
                image = np.asarray(
                    Image.open(io.BytesIO(row[0])).convert("RGB")
                )
        tile_bbox = (tile[2], tile[3], tile[4], tile[5])
        for building in group:
            cache_key = (building["id"], tile_id, version)
            color = _BUILDING_COLOR_CACHE.get(cache_key)
            if color is None and image is not None:
                color = _sample_footprint_color(
                    image, absolute_rings[building["id"]], tile_bbox
                )
                if color is not None:
                    if len(_BUILDING_COLOR_CACHE) > 20000:
                        _BUILDING_COLOR_CACHE.clear()
                    _BUILDING_COLOR_CACHE[cache_key] = color
            if color is not None:
                building["color"] = list(color)
                building["colorVersion"] = f"{tile_id}:{version}"


def query_roads(
    db: sqlite3.Connection, bbox: tuple[float, float, float, float]
) -> list[dict[str, Any]]:
    x_min, y_min, x_max, y_max = bbox
    rows = db.execute(
        "SELECT id, type, properties FROM assets "
        "WHERE enabled = 1 AND json_type(properties,'$.path')='array' "
        "AND min_x <= ? AND max_x >= ? AND min_y <= ? AND max_y >= ?",
        (x_max, x_min, y_max, y_min),
    ).fetchall()
    result = []
    for asset_id, source_layer, raw in rows:
        props = _properties(raw)
        path = props.get("path")
        if isinstance(path, list) and len(path) >= 2:
            result.append({"id": asset_id, "type": source_layer, **props})
    return result


def _smooth_points(points: list[tuple[float, float]], passes: int = 2) -> list[tuple[float, float]]:
    """Corner-cut a survey polyline while preserving its exact endpoints."""
    result = points
    for _ in range(passes):
        if len(result) < 3:
            break
        smoothed = [result[0]]
        for first, second in zip(result, result[1:]):
            smoothed.extend((
                (first[0] * 0.75 + second[0] * 0.25,
                 first[1] * 0.75 + second[1] * 0.25),
                (first[0] * 0.25 + second[0] * 0.75,
                 first[1] * 0.25 + second[1] * 0.75),
            ))
        smoothed.append(result[-1])
        result = smoothed
    return result


def _draw_round_line(draw: ImageDraw.ImageDraw, points, fill, width: int) -> None:
    if len(points) < 2 or width <= 0:
        return
    draw.line(points, fill=fill, width=width, joint="curve")
    radius = width / 2
    for x, y in (points[0], points[-1]):
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)


def _road_raster_specs(
    roads: list[dict[str, Any]],
    bbox: tuple[float, float, float, float],
    width: int,
    height: int,
    scale: int,
):
    """Yield the shared geometry used by color and classifier road paints."""
    x_min, y_min, x_max, y_max = bbox
    span_x = x_max - x_min
    span_y = y_max - y_min
    if span_x <= 0 or span_y <= 0:
        return
    for road in roads:
        points = []
        for point in road.get("path", []):
            if not isinstance(point, list) or len(point) < 2:
                continue
            points.append((
                (float(point[0]) - x_min) / span_x * width * scale,
                (y_max - float(point[1])) / span_y * height * scale,
            ))
        if len(points) < 2:
            continue
        points = _smooth_points(points)
        width_px = DEFAULT_LINE_WIDTH_M / span_x * width * scale
        minimum_screen_px = 1.5
        fill_width = max(
            1, int(round(max(width_px, minimum_screen_px * scale)))
        )
        yield road, points, fill_width


def road_corridor_mask(
    bbox: tuple[float, float, float, float],
    width: int,
    height: int,
    db_path: Path = DEFAULT_ASSETS_DB_PATH,
) -> tuple[Image.Image, int]:
    """Rasterize road/path coverage for classifier and scatter exclusion."""
    empty = Image.new("L", (width, height), 0)
    if width <= 0 or height <= 0 or not db_path.exists():
        return empty, 0
    db = connect(db_path)
    try:
        roads = query_roads(db, bbox)
    finally:
        db.close()
    if not roads:
        return empty, 0

    scale = ROAD_SUPERSAMPLE
    coverage = Image.new("L", (width * scale, height * scale), 0)
    draw = ImageDraw.Draw(coverage)
    painted = 0
    for _, points, fill_width in _road_raster_specs(
        roads, bbox, width, height, scale
    ):
        _draw_round_line(draw, points, 255, fill_width)
        painted += 1
    if not painted:
        return empty, 0
    return (
        coverage.resize((width, height), Image.Resampling.LANCZOS),
        painted,
    )


def _sample_underlying_color(
    image: Image.Image,
    points: list[tuple[float, float]],
    coordinate_scale: int,
    sample_half_width: float = 0,
) -> tuple[int, int, int] | None:
    """Median RGB over the exact centerline/corridor that will be painted."""
    width, height = image.size
    samples: list[tuple[int, int, int]] = []
    for first, second in zip(points, points[1:]):
        x0, y0 = first[0] / coordinate_scale, first[1] / coordinate_scale
        x1, y1 = second[0] / coordinate_scale, second[1] / coordinate_scale
        length = math.hypot(x1 - x0, y1 - y0)
        steps = max(1, min(64, int(math.ceil(length / 2))))
        dx, dy = x1 - x0, y1 - y0
        if length > 1e-9:
            normal_x, normal_y = -dy / length, dx / length
        else:
            normal_x, normal_y = 0.0, 0.0
        half_width = sample_half_width / coordinate_scale
        if half_width >= 2:
            offsets = (-half_width, -half_width / 2, 0, half_width / 2, half_width)
        elif half_width > 0:
            offsets = (-half_width, 0, half_width)
        else:
            offsets = (0,)
        for step in range(steps + 1):
            amount = step / steps
            center_x = x0 + dx * amount
            center_y = y0 + dy * amount
            for offset in offsets:
                x = int(round(center_x + normal_x * offset))
                y = int(round(center_y + normal_y * offset))
                if 0 <= x < width and 0 <= y < height:
                    samples.append(_rgb_pixel(image, x, y))
    if not samples:
        return None
    return (
        int(statistics.median(pixel[0] for pixel in samples)),
        int(statistics.median(pixel[1] for pixel in samples)),
        int(statistics.median(pixel[2] for pixel in samples)),
    )


def _local_segments(
    points: list[tuple[float, float]],
    coordinate_scale: int,
    max_screen_length: float = 3.0,
):
    """Yield short continuous pieces so color follows the imagery locally."""
    max_length = max_screen_length * coordinate_scale
    for first, second in zip(points, points[1:]):
        length = math.hypot(second[0] - first[0], second[1] - first[1])
        pieces = max(1, int(math.ceil(length / max_length)))
        previous = first
        for index in range(1, pieces + 1):
            amount = index / pieces
            current = (
                first[0] + (second[0] - first[0]) * amount,
                first[1] + (second[1] - first[1]) * amount,
            )
            yield previous, current
            previous = current


def _pavement_color(sampled: tuple[int, int, int]) -> tuple[int, int, int]:
    """Keep local brightness/hue while gently muting orthophoto noise."""
    red, green, blue = sampled
    luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722
    muted = lambda channel: max(
        0, min(255, int(round((channel * 0.58 + luminance * 0.42) * 0.88)))
    )
    return (
        muted(red),
        muted(green),
        muted(blue),
    )


def paint_roads_image(
    image: Image.Image,
    bbox: tuple[float, float, float, float],
    db_path: Path = DEFAULT_ASSETS_DB_PATH,
    debug: bool = False,
    *,
    roads: list[dict[str, Any]] | None = None,
) -> tuple[Image.Image, int]:
    """Paint catalog roads onto an RGB image without changing its encoding."""
    image = image.convert("RGB")
    if roads is None:
        if not db_path.exists():
            return image, 0
        db = connect(db_path)
        try:
            roads = query_roads(db, bbox)
        finally:
            db.close()
    if not roads:
        return image, 0

    width, height = image.size
    scale = ROAD_SUPERSAMPLE
    overlay = Image.new("RGBA", (width * scale, height * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    painted = 0
    for road, points, fill_width in _road_raster_specs(
        roads, bbox, width, height, scale
    ):
        # One continuous two-lane surface. Supersampling supplies the edge
        # transition; extra casing/crown strokes incorrectly imply separate
        # carriageways and a median.
        alpha = 230 if debug else 145
        if debug:
            _draw_round_line(draw, points, (255, 20, 20, alpha), fill_width)
            painted += 1
            continue
        segment_painted = False
        for first, second in _local_segments(points, scale):
            sampled = _sample_underlying_color(
                image, [first, second], scale, sample_half_width=fill_width / 2
            )
            if sampled is None:
                continue
            color = _pavement_color(sampled)
            _draw_round_line(draw, [first, second], (*color, alpha), fill_width)
            segment_painted = True
        if segment_painted:
            painted += 1

    if not painted:
        return image, 0
    overlay = overlay.resize((width, height), Image.Resampling.LANCZOS)
    image = Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")
    return image, painted


def paint_roads(
    jpeg: bytes,
    bbox: tuple[float, float, float, float],
    db_path: Path = DEFAULT_ASSETS_DB_PATH,
    debug: bool = False,
    *,
    roads: list[dict[str, Any]] | None = None,
) -> tuple[bytes, int]:
    """Paint catalog roads onto a copy of a tile JPEG."""
    if not jpeg:
        return jpeg, 0
    image, painted = paint_roads_image(
        Image.open(io.BytesIO(jpeg)),
        bbox,
        db_path,
        debug=debug,
        roads=roads,
    )
    if not painted:
        return jpeg, 0
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=92, optimize=True)
    return output.getvalue(), painted


def _metadata(path: Path = DEFAULT_METADATA_PATH) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"asset metadata root must be an object: {path}")
    return value


def get_assets_response(
    db: sqlite3.Connection, metadata_path: Path = DEFAULT_METADATA_PATH
) -> dict[str, Any]:
    metadata = _metadata(metadata_path)
    vehicle_type = str(metadata.get("vehicle_asset_type") or "").strip()
    structure_type = str(metadata.get("structure_asset_type") or "").strip()
    if not vehicle_type or not structure_type:
        raise ValueError("asset metadata must define runtime asset type strings")
    seeded_structures = _ensure_seed_assets(
        db, structure_type, metadata.get("seed_structure_instances", []), vehicle=False
    )
    seeded_vehicles = _ensure_seed_assets(
        db, vehicle_type, metadata.get("seed_vehicle_instances", []), vehicle=True
    )
    vehicles = []
    structures = []
    rows = db.execute(
        "SELECT id, type, lat, lon, heading_deg, z, properties, saved_at "
        "FROM assets WHERE enabled = 1 AND type IN (?,?) "
        "ORDER BY updated_at DESC, id",
        (vehicle_type, structure_type),
    ).fetchall()
    for asset_id, asset_type, lat, lon, heading, z, raw, saved_at in rows:
        props = _properties(raw)
        if asset_type == vehicle_type:
            item = {
                "id": asset_id, "lat": lat, "lon": lon,
                "headingDeg": heading, "headlightsOn": props.get("headlightsOn", True),
                "savedAt": saved_at or 0,
            }
            if z is not None:
                item["z"] = z
            for key in ("terrainDepth", "terrainTileId"):
                if props.get(key) is not None:
                    item[key] = props[key]
            vehicles.append(item)
        else:
            item = {
                "id": asset_id, "lat": lat, "lon": lon,
                "headingDeg": heading, "scale": props.get("scale", 1),
            }
            if props.get("tileId"):
                item["tileId"] = props["tileId"]
            structures.append(item)
    vehicle_definition = dict(metadata.get("vehicle_definition", {}))
    headlights = vehicle_definition.get("headlights")
    if isinstance(headlights, dict):
        headlights = dict(headlights)
        color = headlights.get("color")
        if isinstance(color, str) and color.startswith("#"):
            headlights["color"] = int(color[1:], 16)
        vehicle_definition["headlights"] = headlights
    return {
        "ok": True,
        "source": "asset_catalog",
        "schemaVersion": 4,
        "seeded": {
            "structureInstances": seeded_structures,
            "vehicleInstances": seeded_vehicles,
        },
        "vehicle_definition": vehicle_definition,
        "structure_definition": metadata.get("structure_definition", {}),
        "vehicle_instances": vehicles,
        "structure_instances": structures,
    }


def _ensure_seed_assets(
    db: sqlite3.Connection, asset_type: str, seeds: Any, *, vehicle: bool
) -> bool:
    if db.execute("SELECT 1 FROM assets WHERE type=? LIMIT 1", (asset_type,)).fetchone():
        return False
    if not isinstance(seeds, list):
        return False
    inserted = False
    for seed in seeds:
        if not isinstance(seed, dict):
            raise ValueError("asset seed must be an object")
        asset_id = str(seed["id"])
        lat = float(seed["lat"])
        lon = float(seed["lon"])
        heading = float(seed.get("headingDeg", 0))
        if vehicle:
            props = {"headlightsOn": seed.get("headlightsOn", True)}
            for key in ("terrainDepth", "terrainTileId"):
                if seed.get(key) is not None:
                    props[key] = seed[key]
            z = seed.get("z")
            saved_at = time.time()
        else:
            props = {"scale": seed.get("scale", 1)}
            if seed.get("tileId"):
                props["tileId"] = seed["tileId"]
            z = None
            saved_at = None
        db.execute(
            "INSERT OR IGNORE INTO assets "
            "(id,type,enabled,lat,lon,heading_deg,z,properties,saved_at,updated_at) "
            "VALUES (?,?,1,?,?,?,?,?,?,CURRENT_TIMESTAMP)",
            (asset_id, asset_type, lat, lon, heading, z, json.dumps(props), saved_at),
        )
        inserted = True
    if inserted:
        db.commit()
    return inserted


def save_vehicle_state(db: sqlite3.Connection, payload: dict[str, Any]) -> tuple[dict[str, Any], int]:
    try:
        lat = float(payload["lat"])
        lon = float(payload["lon"])
        heading = float(payload["headingDeg"]) % 360
    except (KeyError, TypeError, ValueError):
        return {"error": "invalid vehicle state payload: lat/lon/headingDeg are required"}, 400
    if not all(math.isfinite(value) for value in (lat, lon, heading)):
        return {"error": "invalid vehicle state payload: coordinates must be finite"}, 400

    vehicle_type = str(_metadata().get("vehicle_asset_type") or "").strip()
    if not vehicle_type:
        return {"error": "asset metadata has no vehicle_asset_type"}, 500
    row = db.execute(
        "SELECT id, properties FROM assets WHERE type=? "
        "ORDER BY enabled DESC, updated_at DESC, id LIMIT 1",
        (vehicle_type,),
    ).fetchone()
    vehicle_id = str(row[0]) if row else "amv-01"
    props = _properties(row[1]) if row else {"headlightsOn": True}
    for key in ("terrainDepth", "terrainTileId"):
        if payload.get(key) is not None:
            props[key] = payload[key]
        else:
            props.pop(key, None)
    z = payload.get("z")
    if z is not None:
        try:
            z = float(z)
        except (TypeError, ValueError):
            return {"error": "invalid vehicle state payload: z must be finite"}, 400
        if not math.isfinite(z):
            return {"error": "invalid vehicle state payload: z must be finite"}, 400
    saved_at = time.time()
    db.execute(
        "INSERT INTO assets "
        "(id,type,enabled,lat,lon,heading_deg,z,properties,saved_at,updated_at) "
        "VALUES (?,?,1,?,?,?,?,?,?,CURRENT_TIMESTAMP) "
        "ON CONFLICT(id) DO UPDATE SET type=excluded.type,enabled=1,"
        "lat=excluded.lat,lon=excluded.lon,"
        "heading_deg=excluded.heading_deg,z=excluded.z,properties=excluded.properties,"
        "saved_at=excluded.saved_at,updated_at=CURRENT_TIMESTAMP",
        (vehicle_id, vehicle_type, lat, lon, heading, z, json.dumps(props), saved_at),
    )
    db.commit()
    state = {"lat": lat, "lon": lon, "headingDeg": heading, "savedAt": saved_at}
    if z is not None:
        state["z"] = z
    for key in ("terrainDepth", "terrainTileId"):
        if props.get(key) is not None:
            state[key] = props[key]
    return {"ok": True, "vehicleId": vehicle_id, "state": state}, 200
