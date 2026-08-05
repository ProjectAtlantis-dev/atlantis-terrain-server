"""Vehicle definitions, instances, and persisted runtime state."""
from __future__ import annotations

import json
import math
import sqlite3
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_METADATA_PATH = ROOT / "assetserver" / "assets_metadata.json"


def read_asset_metadata(path: Path = DEFAULT_METADATA_PATH) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"asset metadata root must be an object: {path}")
    return value


def _properties(raw: str) -> dict[str, Any]:
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("vehicle properties must decode to a JSON object")
    return value


def _vehicle_type(metadata: dict[str, Any]) -> str:
    asset_type = str(metadata.get("vehicle_asset_type") or "").strip()
    if not asset_type:
        raise ValueError("asset metadata has no vehicle_asset_type")
    return asset_type


def _ensure_vehicle_seeds(
    db: sqlite3.Connection, asset_type: str, seeds: Any,
) -> bool:
    if db.execute(
        "SELECT 1 FROM assets WHERE type=? LIMIT 1", (asset_type,),
    ).fetchone():
        return False
    if not isinstance(seeds, list):
        return False
    inserted = False
    for seed in seeds:
        if not isinstance(seed, dict):
            raise ValueError("vehicle seed must be an object")
        props = {"headlightsOn": seed.get("headlightsOn", True)}
        for key in ("terrainDepth", "terrainTileId"):
            if seed.get(key) is not None:
                props[key] = seed[key]
        db.execute(
            "INSERT OR IGNORE INTO assets "
            "(id,type,enabled,lat,lon,heading_deg,z,properties,saved_at,updated_at) "
            "VALUES (?,?,1,?,?,?,?,?,?,CURRENT_TIMESTAMP)",
            (
                str(seed["id"]), asset_type, float(seed["lat"]),
                float(seed["lon"]), float(seed.get("headingDeg", 0)),
                seed.get("z"), json.dumps(props), time.time(),
            ),
        )
        inserted = True
    if inserted:
        db.commit()
    return inserted


def load_vehicle_assets(
    db: sqlite3.Connection, metadata: dict[str, Any],
) -> tuple[bool, dict[str, Any], list[dict[str, Any]]]:
    """Return seed status, model definition, and enabled vehicle instances."""
    asset_type = _vehicle_type(metadata)
    seeded = _ensure_vehicle_seeds(
        db, asset_type, metadata.get("seed_vehicle_instances", []),
    )
    instances = []
    rows = db.execute(
        "SELECT id, lat, lon, heading_deg, z, properties, saved_at "
        "FROM assets WHERE enabled = 1 AND type = ? "
        "ORDER BY updated_at DESC, id",
        (asset_type,),
    ).fetchall()
    for asset_id, lat, lon, heading, z, raw, saved_at in rows:
        props = _properties(raw)
        item = {
            "id": asset_id, "lat": lat, "lon": lon,
            "headingDeg": heading,
            "headlightsOn": props.get("headlightsOn", True),
            "savedAt": saved_at or 0,
        }
        if z is not None:
            item["z"] = z
        for key in ("terrainDepth", "terrainTileId"):
            if props.get(key) is not None:
                item[key] = props[key]
        instances.append(item)

    definition = dict(metadata.get("vehicle_definition", {}))
    headlights = definition.get("headlights")
    if isinstance(headlights, dict):
        headlights = dict(headlights)
        color = headlights.get("color")
        if isinstance(color, str) and color.startswith("#"):
            headlights["color"] = int(color[1:], 16)
        definition["headlights"] = headlights
    return seeded, definition, instances


def save_vehicle_state(
    db: sqlite3.Connection,
    payload: dict[str, Any],
    metadata_path: Path = DEFAULT_METADATA_PATH,
) -> tuple[dict[str, Any], int]:
    try:
        lat = float(payload["lat"])
        lon = float(payload["lon"])
        heading = float(payload["headingDeg"]) % 360
    except (KeyError, TypeError, ValueError):
        return {"error": "invalid vehicle state payload: lat/lon/headingDeg are required"}, 400
    if not all(math.isfinite(value) for value in (lat, lon, heading)):
        return {"error": "invalid vehicle state payload: coordinates must be finite"}, 400

    try:
        asset_type = _vehicle_type(read_asset_metadata(metadata_path))
    except ValueError as exc:
        return {"error": str(exc)}, 500
    row = db.execute(
        "SELECT id, properties FROM assets WHERE type=? "
        "ORDER BY enabled DESC, updated_at DESC, id LIMIT 1",
        (asset_type,),
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
        (vehicle_id, asset_type, lat, lon, heading, z, json.dumps(props), saved_at),
    )
    db.commit()
    state = {"lat": lat, "lon": lon, "headingDeg": heading, "savedAt": saved_at}
    if z is not None:
        state["z"] = z
    for key in ("terrainDepth", "terrainTileId"):
        if props.get(key) is not None:
            state[key] = props[key]
    return {"ok": True, "vehicleId": vehicle_id, "state": state}, 200
