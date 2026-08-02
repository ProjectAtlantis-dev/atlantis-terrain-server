"""Flask-owned access to the shared asset catalog.

The browser never opens or addresses the asset service directly.  Terrain-
coupled reads happen here so Flask can spatially reconcile assets with the
tile/texture being served.
"""
from __future__ import annotations

import io
import json
import math
import sqlite3
import statistics
import time
import colorsys
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ASSETS_DB_PATH = ROOT / "assetserver" / "assets.db"
DEFAULT_METADATA_PATH = ROOT / "assetserver" / "assets_metadata.json"

ROAD_WIDTH_SCALE = {
    "road:Hovedvej": 1.35,
    "road:Lokalvej": 1.25,
    "road:Adgangsvej": 1.25,
    "road:Kørespor": 1.15,
    "road:Under anlæg": 1.2,
    "road:Tunnel": 1.2,
    "path:Anlagt": 1.15,
    "path:Natursti": 1.1,
}
ROAD_SUPERSAMPLE = 4
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
        "updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    )
    columns = {row[1] for row in db.execute("PRAGMA table_info(assets)")}
    for column in ("cx", "cy", "min_x", "min_y", "max_x", "max_y"):
        if column not in columns:
            db.execute(f"ALTER TABLE assets ADD COLUMN {column} REAL")
    db.execute("CREATE INDEX IF NOT EXISTS idx_assets_cxy ON assets(cx,cy)")
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_assets_bounds "
        "ON assets(type,min_x,max_x,min_y,max_y)"
    )
    db.commit()
    return db


def _properties(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def query_buildings(
    db: sqlite3.Connection,
    qx: float,
    qy: float,
    max_range: float,
    ox: float,
    oy: float,
) -> list[dict[str, Any]]:
    try:
        rows = db.execute(
            "SELECT id, properties FROM assets "
            "WHERE type = 'building' AND enabled = 1 "
            "AND cx BETWEEN ? AND ? AND cy BETWEEN ? AND ? LIMIT 20000",
            (qx - max_range, qx + max_range, qy - max_range, qy + max_range),
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    result = []
    for asset_id, raw in rows:
        props = _properties(raw)
        ring = props.get("ring")
        if not isinstance(ring, list) or len(ring) < 3:
            continue
        result.append({
            "id": asset_id,
            "b": props.get("b"),
            "use": props.get("use"),
            "groundZ": props.get("groundZ", 0),
            "ring": [[point[0] - ox, point[1] - oy, point[2]] for point in ring],
        })
    return result


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


def _roof_color(pixels: list[tuple[int, int, int]]) -> tuple[int, int, int] | None:
    """Weighted roof color, preferring non-earth pixels inside the footprint."""
    weighted: list[tuple[tuple[int, int, int], float]] = []
    for pixel in pixels:
        red, green, blue = pixel
        brightness = (red + green + blue) / 3
        if brightness < 20 or brightness > 248:
            continue
        hue, saturation, _ = colorsys.rgb_to_hsv(red / 255, green / 255, blue / 255)
        earth_tone = 0.055 <= hue <= 0.46 and saturation >= 0.12
        if earth_tone:
            weight = 1.0
        elif saturation < 0.12:
            weight = 2.0  # neutral metal/concrete roofs
        else:
            weight = 4.0  # red/blue/cyan roof material
        weighted.append((pixel, weight))
    if not weighted:
        return None
    total = sum(weight for _, weight in weighted)
    channel = lambda index: int(round(
        sum(pixel[index] * weight for pixel, weight in weighted) / total
    ))
    return (
        channel(0),
        channel(1),
        channel(2),
    )


def _rgb_pixel(image: Image.Image, x: int, y: int) -> tuple[int, int, int]:
    """Read a statically typed RGB triple from any Pillow image mode."""
    pixel = image.getpixel((x, y))
    if isinstance(pixel, tuple):
        return int(pixel[0]), int(pixel[1]), int(pixel[2])
    if pixel is None:
        return 0, 0, 0
    value = int(pixel)
    return value, value, value


def _sample_footprint_color(
    image: Image.Image,
    ring: list[list[float]],
    bbox: tuple[float, float, float, float],
) -> tuple[int, int, int] | None:
    width, height = image.size
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
    pixels: list[tuple[int, int, int]] = [
        _rgb_pixel(image, x, y)
        for y in range(top, bottom + 1)
        for x in range(left, right + 1)
        if _point_in_polygon(x + 0.5, y + 0.5, polygon)
    ]
    if not pixels:
        center_x = max(0, min(width - 1, int(round(sum(p[0] for p in polygon) / len(polygon)))))
        center_y = max(0, min(height - 1, int(round(sum(p[1] for p in polygon) / len(polygon)))))
        pixels = [_rgb_pixel(image, center_x, center_y)]
    return _roof_color(pixels)


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
    try:
        tiles = terrain_db.execute(
            "SELECT t.tile_id,t.depth,t.x_min,t.y_min,t.x_max,t.y_max,x.updated_at "
            "FROM tiles t JOIN textures x ON x.tile_id=t.tile_id "
            "WHERE t.x_min <= ? AND t.x_max >= ? AND t.y_min <= ? AND t.y_max >= ? "
            "ORDER BY t.depth DESC",
            (query_bounds[2], query_bounds[0], query_bounds[3], query_bounds[1]),
        ).fetchall()
    except sqlite3.OperationalError:
        return

    assignments: dict[str, tuple] = {}
    for building in buildings:
        cx, cy = centers[building["id"]]
        for tile in tiles:
            if tile[2] <= cx < tile[4] and tile[3] <= cy < tile[5]:
                assignments[building["id"]] = tile
                break
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
                image = Image.open(io.BytesIO(row[0])).convert("RGB")
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
    try:
        rows = db.execute(
            "SELECT id, properties FROM assets "
            "WHERE type = 'road' AND enabled = 1 "
            "AND min_x <= ? AND max_x >= ? AND min_y <= ? AND max_y >= ?",
            (x_max, x_min, y_max, y_min),
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    result = []
    for asset_id, raw in rows:
        props = _properties(raw)
        path = props.get("path")
        if isinstance(path, list) and len(path) >= 2:
            result.append({"id": asset_id, **props})
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
        width_m = float(road.get("widthM", 4.0))
        key = f"{road.get('kind', 'road')}:{road.get('category', '')}"
        profile_scale = ROAD_WIDTH_SCALE.get(
            key, 1.25 if road.get("kind") == "road" else 1.1
        )
        width_px = width_m * profile_scale / span_x * width * scale
        if road.get("kind") == "road":
            minimum_screen_px = 1.5
        elif road.get("category") == "Anlagt":
            minimum_screen_px = 2.0
        else:
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


def _trail_color(
    sampled: tuple[int, int, int], natural: bool
) -> tuple[int, int, int]:
    """Keep the local terrain hue while giving the path readable contrast."""
    red, green, blue = (channel / 255 for channel in sampled)
    hue, saturation, value = colorsys.rgb_to_hsv(red, green, blue)
    # Natursti centerlines are often drawn over olive or grey-green terrain.
    # A 12% value change disappeared after alpha blending and JPEG encoding,
    # leaving only faint grey survey lines. Preserve and gently reinforce the
    # sampled chroma, but restore enough contrast for the baked trail surface
    # to read at walking-scale LODs.
    value *= 0.72 if natural else 0.80
    saturation = min(1.0, saturation * 1.05)
    out_red, out_green, out_blue = colorsys.hsv_to_rgb(
        hue, saturation, value
    )
    return (
        int(round(out_red * 255)),
        int(round(out_green * 255)),
        int(round(out_blue * 255)),
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
        alpha = 230 if debug else (180 if road.get("kind") == "path" else 145)
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
            if road.get("kind") == "path":
                color = _trail_color(sampled, road.get("category") == "Natursti")
            else:
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
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def get_assets_response(
    db: sqlite3.Connection, metadata_path: Path = DEFAULT_METADATA_PATH
) -> dict[str, Any]:
    metadata = _metadata(metadata_path)
    seeded_structures = _ensure_seed_assets(
        db, "structure", metadata.get("seed_structure_instances", [])
    )
    seeded_vehicles = _ensure_seed_assets(
        db, "vehicle", metadata.get("seed_vehicle_instances", [])
    )
    vehicles = []
    structures = []
    try:
        rows = db.execute(
            "SELECT id, type, lat, lon, heading_deg, z, properties, saved_at "
            "FROM assets WHERE enabled = 1 AND type IN ('vehicle', 'structure') "
            "ORDER BY updated_at DESC, id"
        ).fetchall()
    except sqlite3.OperationalError:
        rows = []
    for asset_id, asset_type, lat, lon, heading, z, raw, saved_at in rows:
        props = _properties(raw)
        if asset_type == "vehicle":
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
            try:
                headlights["color"] = int(color[1:], 16)
            except ValueError:
                pass
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
    db: sqlite3.Connection, asset_type: str, seeds: Any
) -> bool:
    if db.execute("SELECT 1 FROM assets WHERE type=? LIMIT 1", (asset_type,)).fetchone():
        return False
    if not isinstance(seeds, list):
        return False
    inserted = False
    for seed in seeds:
        if not isinstance(seed, dict):
            continue
        try:
            asset_id = str(seed["id"])
            lat = float(seed["lat"])
            lon = float(seed["lon"])
            heading = float(seed.get("headingDeg", 0))
        except (KeyError, TypeError, ValueError):
            continue
        if asset_type == "vehicle":
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

    row = db.execute(
        "SELECT id, properties FROM assets WHERE type='vehicle' "
        "ORDER BY enabled DESC, updated_at DESC, id LIMIT 1"
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
        "VALUES (?,'vehicle',1,?,?,?,?,?,?,CURRENT_TIMESTAMP) "
        "ON CONFLICT(id) DO UPDATE SET enabled=1,lat=excluded.lat,lon=excluded.lon,"
        "heading_deg=excluded.heading_deg,z=excluded.z,properties=excluded.properties,"
        "saved_at=excluded.saved_at,updated_at=CURRENT_TIMESTAMP",
        (vehicle_id, lat, lon, heading, z, json.dumps(props), saved_at),
    )
    db.commit()
    state = {"lat": lat, "lon": lon, "headingDeg": heading, "savedAt": saved_at}
    if z is not None:
        state["z"] = z
    for key in ("terrainDepth", "terrainTileId"):
        if props.get(key) is not None:
            state[key] = props[key]
    return {"ok": True, "vehicleId": vehicle_id, "state": state}, 200
