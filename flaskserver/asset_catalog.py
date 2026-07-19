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
import time
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ASSETS_DB_PATH = ROOT / "assetserver" / "assets.db"
DEFAULT_METADATA_PATH = ROOT / "assetserver" / "assets_metadata.json"

ROAD_COLORS = {
    "road:Hovedvej": (51, 51, 54),
    "road:Lokalvej": (61, 61, 64),
    "road:Adgangsvej": (71, 71, 74),
    "road:Kørespor": (97, 92, 84),
    "road:Under anlæg": (107, 102, 92),
    "road:Tunnel": (41, 41, 43),
    "path:Anlagt": (102, 99, 94),
    "path:Natursti": (122, 112, 97),
}
DEFAULT_ROAD_COLOR = (77, 77, 77)


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


def paint_roads(
    jpeg: bytes,
    bbox: tuple[float, float, float, float],
    db_path: Path = DEFAULT_ASSETS_DB_PATH,
) -> tuple[bytes, int]:
    """Paint catalog roads onto a copy of a tile JPEG."""
    if not jpeg or not db_path.exists():
        return jpeg, 0
    db = connect(db_path)
    try:
        roads = query_roads(db, bbox)
    finally:
        db.close()
    if not roads:
        return jpeg, 0

    image = Image.open(io.BytesIO(jpeg)).convert("RGB")
    draw = ImageDraw.Draw(image)
    width, height = image.size
    x_min, y_min, x_max, y_max = bbox
    span_x = x_max - x_min
    span_y = y_max - y_min
    if span_x <= 0 or span_y <= 0:
        return jpeg, 0

    painted = 0
    for road in roads:
        points = []
        for point in road.get("path", []):
            if not isinstance(point, list) or len(point) < 2:
                continue
            points.append((
                (float(point[0]) - x_min) / span_x * width,
                (y_max - float(point[1])) / span_y * height,
            ))
        if len(points) < 2:
            continue
        width_m = float(road.get("widthM", 4.0))
        line_width = max(1, int(round(width_m / span_x * width)))
        key = f"{road.get('kind', 'road')}:{road.get('category', '')}"
        color = ROAD_COLORS.get(key, DEFAULT_ROAD_COLOR)
        draw.line(points, fill=color, width=line_width, joint="curve")
        painted += 1

    if not painted:
        return jpeg, 0
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=90, optimize=True)
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
