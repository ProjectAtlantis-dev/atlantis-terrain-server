from __future__ import annotations

import json
import math
import sqlite3
import time
from typing import Any

VEHICLE_STATE_METADATA_KEY = "vehicle_state_v1"


def get_vehicle_state_response(db: sqlite3.Connection, logger: Any) -> dict[str, Any]:
  row = db.execute(
    "SELECT value FROM metadata WHERE key = ?",
    (VEHICLE_STATE_METADATA_KEY,),
  ).fetchone()
  if row is None or row[0] is None:
    return {"ok": True, "state": None}

  raw = row[0]
  try:
    state = json.loads(raw)
  except Exception as exc:
    logger.warning(
      f"[VEHICLE STATE] invalid JSON in metadata key={VEHICLE_STATE_METADATA_KEY}: "
      f"{type(exc).__name__}: {exc}"
    )
    return {"ok": True, "state": None, "corrupt": True}

  return {"ok": True, "state": state}


def save_vehicle_state_response(
  db: sqlite3.Connection,
  data: dict[str, Any],
  logger: Any,
) -> tuple[dict[str, Any], int]:
  try:
    lat = float(data.get("lat"))
    lon = float(data.get("lon"))
    heading_deg = float(data.get("headingDeg"))
  except (TypeError, ValueError):
    return {"error": "lat/lon/headingDeg must be finite numbers"}, 400
  raw_z = data.get("z")
  z = None
  if raw_z is not None:
    try:
      z_val = float(raw_z)
      if math.isfinite(z_val):
        z = z_val
      else:
        return {"error": "z must be a finite number when provided"}, 400
    except (TypeError, ValueError):
      return {"error": "z must be a finite number when provided"}, 400
  raw_terrain_depth = data.get("terrainDepth")
  terrain_depth = None
  if raw_terrain_depth is not None:
    try:
      terrain_depth_val = int(raw_terrain_depth)
      if terrain_depth_val < 0:
        return {"error": "terrainDepth must be >= 0 when provided"}, 400
      terrain_depth = terrain_depth_val
    except (TypeError, ValueError):
      return {"error": "terrainDepth must be an integer when provided"}, 400
  raw_terrain_tile_id = data.get("terrainTileId")
  terrain_tile_id = None
  if raw_terrain_tile_id is not None:
    terrain_tile_id = str(raw_terrain_tile_id).strip()
    if not terrain_tile_id:
      terrain_tile_id = None
  raw_reason = data.get("reason")
  reason = None
  if raw_reason is not None:
    reason = str(raw_reason).strip()
    if not reason:
      reason = None

  if not math.isfinite(lat) or not math.isfinite(lon) or not math.isfinite(heading_deg):
    return {"error": "lat/lon/headingDeg must be finite numbers"}, 400
  if lat < -90 or lat > 90:
    return {"error": "lat out of range [-90, 90]"}, 400
  if lon < -180 or lon > 180:
    return {"error": "lon out of range [-180, 180]"}, 400

  heading_deg = heading_deg % 360.0
  state = {
    "lat": lat,
    "lon": lon,
    "headingDeg": heading_deg,
    "savedAt": time.time(),
  }
  if z is not None:
    state["z"] = z
  if terrain_depth is not None:
    state["terrainDepth"] = terrain_depth
  if terrain_tile_id is not None:
    state["terrainTileId"] = terrain_tile_id
  raw_state = json.dumps(state, separators=(",", ":"))

  db.execute(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
    (VEHICLE_STATE_METADATA_KEY, raw_state),
  )
  db.commit()

  depth_log = (
    f" terrainDepth={terrain_depth}"
    if terrain_depth is not None
    else ""
  )
  reason_log = (
    f" reason={reason}"
    if reason is not None
    else ""
  )
  if z is None:
    logger.info(
      f"[VEHICLE STATE] saved lat={lat:.6f} lon={lon:.6f} headingDeg={heading_deg:.2f}{depth_log}{reason_log}"
    )
  else:
    logger.info(
      f"[VEHICLE STATE] saved lat={lat:.6f} lon={lon:.6f} headingDeg={heading_deg:.2f} z={z:.3f}{depth_log}{reason_log}"
    )
  return {"ok": True, "state": state}, 200
