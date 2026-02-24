from __future__ import annotations

import json
import math
import sqlite3
import time
from typing import Any

VEHICLE_STATE_METADATA_KEY = "vehicle_state_v1"
VEHICLE_HEADLIGHTS_METADATA_KEY = "vehicle_headlights_v1"

_DEFAULT_VEHICLE_HEADLIGHTS = {
  "enabled": True,
  "color": 0xFFF4E0,
  "intensity": 800.0,
  "distanceM": 120.0,
  "angleDeg": 39.6,
  "penumbra": 0.4,
  "decay": 2.0,
  "mountFrontRatio": 0.48,
  "mountHeightM": 1.4,
  "mountSpacingM": 0.95,
  "targetForwardM": 60.0,
  "targetHeightM": -0.5,
  "targetXScale": 0.3,
}


def _copy_default_vehicle_headlights() -> dict[str, Any]:
  return dict(_DEFAULT_VEHICLE_HEADLIGHTS)


def _coerce_finite_number(value: Any) -> float | None:
  try:
    number = float(value)
  except (TypeError, ValueError):
    return None
  if not math.isfinite(number):
    return None
  return number


def _coerce_bool(value: Any) -> bool | None:
  if isinstance(value, bool):
    return value
  if isinstance(value, (int, float)):
    if value == 1:
      return True
    if value == 0:
      return False
  if isinstance(value, str):
    text = value.strip().lower()
    if text in {"1", "true", "yes", "on"}:
      return True
    if text in {"0", "false", "no", "off"}:
      return False
  return None


def _coerce_color(value: Any) -> int | None:
  if isinstance(value, bool):
    return None
  if isinstance(value, (int, float)):
    if not math.isfinite(float(value)):
      return None
    return int(max(0, min(0xFFFFFF, int(value))))
  if isinstance(value, str):
    raw_text = value.strip().lower()
    if not raw_text:
      return None
    force_hex = False
    text = raw_text
    if text.startswith("#"):
      force_hex = True
      text = text[1:]
    if text.startswith("0x"):
      force_hex = True
      text = text[2:]
    if not text:
      return None
    if force_hex or any(ch in "abcdef" for ch in text):
      if not all(ch in "0123456789abcdef" for ch in text):
        return None
      base = 16
    else:
      if not text.isdigit():
        return None
      base = 10
    try:
      return int(max(0, min(0xFFFFFF, int(text, base))))
    except ValueError:
      return None
  return None


def _sanitize_vehicle_headlights(raw: Any) -> dict[str, Any]:
  out = _copy_default_vehicle_headlights()
  if not isinstance(raw, dict):
    return out

  enabled = _coerce_bool(raw.get("enabled"))
  if enabled is not None:
    out["enabled"] = enabled

  color = _coerce_color(raw.get("color"))
  if color is not None:
    out["color"] = color

  intensity = _coerce_finite_number(raw.get("intensity"))
  if intensity is not None:
    out["intensity"] = max(0.0, intensity)

  distance_m = _coerce_finite_number(raw.get("distanceM"))
  if distance_m is not None:
    out["distanceM"] = max(0.0, distance_m)

  angle_deg = _coerce_finite_number(raw.get("angleDeg"))
  if angle_deg is not None:
    out["angleDeg"] = max(1.0, min(85.0, angle_deg))

  penumbra = _coerce_finite_number(raw.get("penumbra"))
  if penumbra is not None:
    out["penumbra"] = max(0.0, min(1.0, penumbra))

  decay = _coerce_finite_number(raw.get("decay"))
  if decay is not None:
    out["decay"] = max(0.0, decay)

  mount_front_ratio = _coerce_finite_number(raw.get("mountFrontRatio"))
  if mount_front_ratio is not None:
    out["mountFrontRatio"] = max(0.0, min(1.0, mount_front_ratio))

  mount_height_m = _coerce_finite_number(raw.get("mountHeightM"))
  if mount_height_m is not None:
    out["mountHeightM"] = mount_height_m

  mount_spacing_m = _coerce_finite_number(raw.get("mountSpacingM"))
  if mount_spacing_m is not None:
    out["mountSpacingM"] = max(0.0, mount_spacing_m)

  target_forward_m = _coerce_finite_number(raw.get("targetForwardM"))
  if target_forward_m is not None:
    out["targetForwardM"] = max(0.0, target_forward_m)

  target_height_m = _coerce_finite_number(raw.get("targetHeightM"))
  if target_height_m is not None:
    out["targetHeightM"] = target_height_m

  target_x_scale = _coerce_finite_number(raw.get("targetXScale"))
  if target_x_scale is not None:
    out["targetXScale"] = max(0.0, min(1.0, target_x_scale))

  return out


def _ensure_default_vehicle_headlights_metadata(db: sqlite3.Connection) -> bool:
  row = db.execute(
    "SELECT value FROM metadata WHERE key = ?",
    (VEHICLE_HEADLIGHTS_METADATA_KEY,),
  ).fetchone()
  if row is not None and row[0] is not None:
    return False
  payload = _copy_default_vehicle_headlights()
  db.execute(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
    (VEHICLE_HEADLIGHTS_METADATA_KEY, json.dumps(payload, separators=(",", ":"))),
  )
  db.commit()
  return True


def get_vehicle_headlights_response(db: sqlite3.Connection, logger: Any) -> dict[str, Any]:
  seeded = _ensure_default_vehicle_headlights_metadata(db)
  row = db.execute(
    "SELECT value FROM metadata WHERE key = ?",
    (VEHICLE_HEADLIGHTS_METADATA_KEY,),
  ).fetchone()
  if row is None or row[0] is None:
    return {
      "ok": True,
      "source": "defaults",
      "metadataKey": VEHICLE_HEADLIGHTS_METADATA_KEY,
      "seeded": seeded,
      "headlights": _copy_default_vehicle_headlights(),
    }

  try:
    payload = json.loads(row[0])
  except Exception as exc:
    logger.warning(
      f"[VEHICLE HEADLIGHTS] invalid JSON in metadata key={VEHICLE_HEADLIGHTS_METADATA_KEY}: "
      f"{type(exc).__name__}: {exc}"
    )
    return {
      "ok": True,
      "source": "metadata",
      "metadataKey": VEHICLE_HEADLIGHTS_METADATA_KEY,
      "seeded": seeded,
      "corrupt": True,
      "headlights": _copy_default_vehicle_headlights(),
    }

  return {
    "ok": True,
    "source": "metadata",
    "metadataKey": VEHICLE_HEADLIGHTS_METADATA_KEY,
    "seeded": seeded,
    "corrupt": False,
    "headlights": _sanitize_vehicle_headlights(payload),
  }


def get_vehicle_state_response(db: sqlite3.Connection, logger: Any) -> dict[str, Any]:
  headlights_payload = get_vehicle_headlights_response(db, logger)
  headlights = _sanitize_vehicle_headlights(headlights_payload.get("headlights"))
  row = db.execute(
    "SELECT value FROM metadata WHERE key = ?",
    (VEHICLE_STATE_METADATA_KEY,),
  ).fetchone()
  if row is None or row[0] is None:
    return {"ok": True, "state": None, "headlights": headlights}

  raw = row[0]
  try:
    state = json.loads(raw)
  except Exception as exc:
    logger.warning(
      f"[VEHICLE STATE] invalid JSON in metadata key={VEHICLE_STATE_METADATA_KEY}: "
      f"{type(exc).__name__}: {exc}"
    )
    return {"ok": True, "state": None, "corrupt": True, "headlights": headlights}

  return {"ok": True, "state": state, "headlights": headlights}


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
