from __future__ import annotations

import json
import math
import sqlite3
import time
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

VEHICLE_STATE_METADATA_KEY = "vehicle_state_v1"
VEHICLE_HEADLIGHTS_METADATA_KEY = "vehicle_headlights_v1"


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


def _validation_error_detail(exc: ValidationError) -> str:
  errors = exc.errors(include_url=False)
  if not errors:
    return "invalid payload"
  first = errors[0]
  loc = ".".join(str(part) for part in first.get("loc", ()))
  msg = str(first.get("msg", "invalid value"))
  if loc:
    return f"{loc}: {msg}"
  return msg


class VehicleHeadlightsModel(BaseModel):
  model_config = ConfigDict(extra="ignore")

  enabled: bool = True
  color: int = Field(default=0xFFF4E0, ge=0, le=0xFFFFFF)
  intensity: float = Field(default=800.0, ge=0)
  distanceM: float = Field(default=120.0, ge=0)
  angleDeg: float = Field(default=39.6, ge=1, le=85)
  penumbra: float = Field(default=0.4, ge=0, le=1)
  decay: float = Field(default=2.0, ge=0)
  mountFrontRatio: float = Field(default=0.48, ge=0, le=1)
  mountHeightM: float = 1.4
  mountSpacingM: float = Field(default=0.95, ge=0)
  targetForwardM: float = Field(default=60.0, ge=0)
  targetHeightM: float = -0.5
  targetXScale: float = Field(default=0.3, ge=0, le=1)

  @field_validator("color", mode="before")
  @classmethod
  def parse_color(cls, value: Any) -> int:
    color = _coerce_color(value)
    if color is None:
      raise ValueError(
        "must be a valid color in [0, 16777215] (supports #RRGGBB and 0xRRGGBB)"
      )
    return color

  @field_validator(
    "intensity",
    "distanceM",
    "angleDeg",
    "penumbra",
    "decay",
    "mountFrontRatio",
    "mountHeightM",
    "mountSpacingM",
    "targetForwardM",
    "targetHeightM",
    "targetXScale",
  )
  @classmethod
  def finite_headlight_number(cls, value: float) -> float:
    if not math.isfinite(value):
      raise ValueError("must be finite")
    return value


class VehicleStateCommonModel(BaseModel):
  model_config = ConfigDict(extra="ignore")

  lat: float
  lon: float
  headingDeg: float
  z: float | None = None
  terrainDepth: int | None = Field(default=None, ge=0)
  terrainTileId: str | None = None

  @field_validator("lat")
  @classmethod
  def validate_lat(cls, value: float) -> float:
    if not math.isfinite(value):
      raise ValueError("must be finite")
    if value < -90 or value > 90:
      raise ValueError("must be in [-90, 90]")
    return value

  @field_validator("lon")
  @classmethod
  def validate_lon(cls, value: float) -> float:
    if not math.isfinite(value):
      raise ValueError("must be finite")
    if value < -180 or value > 180:
      raise ValueError("must be in [-180, 180]")
    return value

  @field_validator("headingDeg")
  @classmethod
  def normalize_heading(cls, value: float) -> float:
    if not math.isfinite(value):
      raise ValueError("must be finite")
    return value % 360.0

  @field_validator("z")
  @classmethod
  def finite_optional_z(cls, value: float | None) -> float | None:
    if value is None:
      return None
    if not math.isfinite(value):
      raise ValueError("must be finite")
    return value

  @field_validator("terrainTileId", mode="before")
  @classmethod
  def normalize_tile_id(cls, value: Any) -> str | None:
    if value is None:
      return None
    text = str(value).strip()
    return text or None


class VehicleStateRecordModel(VehicleStateCommonModel):
  savedAt: float

  @field_validator("savedAt")
  @classmethod
  def validate_saved_at(cls, value: float) -> float:
    if not math.isfinite(value):
      raise ValueError("must be finite")
    return value


class SaveVehicleStateRequestModel(VehicleStateCommonModel):
  reason: str | None = None

  @field_validator("reason", mode="before")
  @classmethod
  def normalize_reason(cls, value: Any) -> str | None:
    if value is None:
      return None
    text = str(value).strip()
    return text or None


def _default_vehicle_headlights() -> dict[str, Any]:
  return VehicleHeadlightsModel().model_dump()


def _sanitize_vehicle_headlights(
  raw: Any,
  logger: Any | None = None,
) -> dict[str, Any]:
  if raw is None:
    return _default_vehicle_headlights()
  try:
    model = VehicleHeadlightsModel.model_validate(raw)
  except ValidationError as exc:
    if logger is not None:
      logger.warning(
        f"[VEHICLE HEADLIGHTS] invalid payload schema: {_validation_error_detail(exc)}"
      )
    return _default_vehicle_headlights()
  return model.model_dump()


def _ensure_default_vehicle_headlights_metadata(db: sqlite3.Connection) -> bool:
  row = db.execute(
    "SELECT value FROM metadata WHERE key = ?",
    (VEHICLE_HEADLIGHTS_METADATA_KEY,),
  ).fetchone()
  if row is not None and row[0] is not None:
    return False
  db.execute(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
    (
      VEHICLE_HEADLIGHTS_METADATA_KEY,
      json.dumps(_default_vehicle_headlights(), separators=(",", ":")),
    ),
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
      "headlights": _default_vehicle_headlights(),
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
      "headlights": _default_vehicle_headlights(),
    }

  headlights = _sanitize_vehicle_headlights(payload, logger)
  return {
    "ok": True,
    "source": "metadata",
    "metadataKey": VEHICLE_HEADLIGHTS_METADATA_KEY,
    "seeded": seeded,
    "corrupt": False,
    "headlights": headlights,
  }


def get_vehicle_state_response(db: sqlite3.Connection, logger: Any) -> dict[str, Any]:
  headlights_payload = get_vehicle_headlights_response(db, logger)
  headlights = _sanitize_vehicle_headlights(headlights_payload.get("headlights"), logger)
  row = db.execute(
    "SELECT value FROM metadata WHERE key = ?",
    (VEHICLE_STATE_METADATA_KEY,),
  ).fetchone()
  if row is None or row[0] is None:
    return {"ok": True, "state": None, "headlights": headlights}

  raw = row[0]
  try:
    payload = json.loads(raw)
  except Exception as exc:
    logger.warning(
      f"[VEHICLE STATE] invalid JSON in metadata key={VEHICLE_STATE_METADATA_KEY}: "
      f"{type(exc).__name__}: {exc}"
    )
    return {"ok": True, "state": None, "corrupt": True, "headlights": headlights}

  try:
    state_model = VehicleStateRecordModel.model_validate(payload)
  except ValidationError as exc:
    logger.warning(
      f"[VEHICLE STATE] invalid schema key={VEHICLE_STATE_METADATA_KEY}: "
      f"{_validation_error_detail(exc)}"
    )
    return {"ok": True, "state": None, "corrupt": True, "headlights": headlights}

  return {
    "ok": True,
    "state": state_model.model_dump(exclude_none=True),
    "headlights": headlights,
  }


def save_vehicle_state_response(
  db: sqlite3.Connection,
  data: dict[str, Any],
  logger: Any,
) -> tuple[dict[str, Any], int]:
  try:
    request = SaveVehicleStateRequestModel.model_validate(data)
  except ValidationError as exc:
    return {"error": f"invalid vehicle state payload: {_validation_error_detail(exc)}"}, 400

  state_model = VehicleStateRecordModel(
    lat=request.lat,
    lon=request.lon,
    headingDeg=request.headingDeg,
    savedAt=time.time(),
    z=request.z,
    terrainDepth=request.terrainDepth,
    terrainTileId=request.terrainTileId,
  )

  db.execute(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
    (
      VEHICLE_STATE_METADATA_KEY,
      state_model.model_dump_json(exclude_none=True),
    ),
  )
  db.commit()

  depth_log = (
    f" terrainDepth={request.terrainDepth}"
    if request.terrainDepth is not None
    else ""
  )
  reason_log = (
    f" reason={request.reason}"
    if request.reason is not None
    else ""
  )
  if request.z is None:
    logger.info(
      f"[VEHICLE STATE] saved lat={request.lat:.6f} lon={request.lon:.6f} "
      f"headingDeg={state_model.headingDeg:.2f}{depth_log}{reason_log}"
    )
  else:
    logger.info(
      f"[VEHICLE STATE] saved lat={request.lat:.6f} lon={request.lon:.6f} "
      f"headingDeg={state_model.headingDeg:.2f} z={request.z:.3f}{depth_log}{reason_log}"
    )
  return {"ok": True, "state": state_model.model_dump(exclude_none=True)}, 200
