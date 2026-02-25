from __future__ import annotations

import json
import math
import sqlite3
import time
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

ASSETS_RESPONSE_SCHEMA_VERSION = 4
STRUCTURE_SITES_TABLE = "structure_sites"
VEHICLE_INSTANCES_TABLE = "vehicle_instances"
DEFAULT_VEHICLE_INSTANCE_ID = "amv-01"
LEGACY_VEHICLE_STATE_METADATA_KEY = "vehicle_state_v1"
LEGACY_VEHICLE_HEADLIGHTS_METADATA_KEY = "vehicle_headlights_v1"
ASSETS_METADATA_PATH = Path(__file__).with_name("assets_metadata.json")

# ── Fallback defaults ────────────────────────────────────────────────────

_FALLBACK_VEHICLE_DEFINITION = {
  "url": "/models/patria_amv.glb",
  "realLengthM": 7.7,
  "tireDiameterM": 1.27,
  "altOffsetM": 0.05,
}

_FALLBACK_STRUCTURE_DEFINITION = {
  "url": "/models/house_test.glb",
  "altOffsetM": 0.4,
  "hotReloadMs": 2000,
  "enabled": False,
}

_FALLBACK_SEED_VEHICLE_INSTANCES = [
  {"id": "amv-01", "lat": 64.18423381, "lon": -51.70139232, "headingDeg": 234.341, "z": 16.279, "headlightsOn": True},
]

_FALLBACK_SEED_STRUCTURE_INSTANCES = [
  {"id": "nuuk-01", "lat": 64.179102, "lon": -51.712988, "headingDeg": 22, "scale": 1.00, "tileId": "12-1375-791"},
  {"id": "nuuk-02", "lat": 64.174556, "lon": -51.703948, "headingDeg": 58, "scale": 0.96, "tileId": "12-1376-791"},
  {"id": "nuuk-03", "lat": 64.185330, "lon": -51.703495, "headingDeg": 96, "scale": 1.08, "tileId": "12-1376-792"},
  {"id": "nuuk-04", "lat": 64.182984, "lon": -51.726468, "headingDeg": 144, "scale": 1.03, "tileId": "12-1374-792"},
  {"id": "nuuk-05", "lat": 64.173514, "lon": -51.718454, "headingDeg": 210, "scale": 0.98, "tileId": "12-1374-791"},
  {"id": "nuuk-06", "lat": 64.178473, "lon": -51.724776, "headingDeg": 288, "scale": 1.04, "tileId": "12-1374-791"},
]


# ── Shared helpers ───────────────────────────────────────────────────────

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


def _validation_error_fields(exc: ValidationError) -> set[str]:
  fields: set[str] = set()
  for err in exc.errors(include_url=False):
    loc = err.get("loc", ())
    if not loc:
      continue
    field_name = loc[0]
    if isinstance(field_name, str):
      fields.add(field_name)
  return fields


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


def _coerce_schema_version(value: Any) -> int | None:
  number = _coerce_finite_number(value)
  if number is None:
    return None
  int_value = int(number)
  if int_value == number and int_value >= 0:
    return int_value
  return None


# ── Pydantic models ─────────────────────────────────────────────────────

class VehicleHeadlightsModel(BaseModel):
  model_config = ConfigDict(extra="ignore")

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


class VehicleDefinitionModel(BaseModel):
  model_config = ConfigDict(extra="ignore")

  url: str = str(_FALLBACK_VEHICLE_DEFINITION["url"])
  realLengthM: float = Field(default=float(_FALLBACK_VEHICLE_DEFINITION["realLengthM"]), gt=0)
  tireDiameterM: float = Field(default=float(_FALLBACK_VEHICLE_DEFINITION["tireDiameterM"]), gt=0)
  altOffsetM: float = float(_FALLBACK_VEHICLE_DEFINITION["altOffsetM"])

  @field_validator("url", mode="before")
  @classmethod
  def normalize_url(cls, value: Any) -> str:
    if not isinstance(value, str):
      raise ValueError("must be a string")
    text = value.strip()
    if not text:
      raise ValueError("must be a non-empty string")
    return text

  @field_validator("realLengthM", "tireDiameterM", "altOffsetM")
  @classmethod
  def validate_finite_number(cls, value: float) -> float:
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


# ── Headlights helpers ───────────────────────────────────────────────────

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


# ── Structure definition sanitizer ───────────────────────────────────────

def _sanitize_structure_definition(raw: Any) -> dict[str, Any]:
  out = dict(_FALLBACK_STRUCTURE_DEFINITION)
  if not isinstance(raw, dict):
    return out
  url = raw.get("url")
  if isinstance(url, str):
    stripped = url.strip()
    if stripped:
      out["url"] = stripped
  alt_offset = _coerce_finite_number(raw.get("altOffsetM"))
  if alt_offset is not None:
    out["altOffsetM"] = alt_offset
  hot_reload_ms = _coerce_finite_number(raw.get("hotReloadMs"))
  if hot_reload_ms is not None:
    out["hotReloadMs"] = max(500, int(hot_reload_ms))
  enabled = _coerce_bool(raw.get("enabled"))
  if enabled is not None:
    out["enabled"] = enabled
  return out


# ── Vehicle definition sanitizer ─────────────────────────────────────────

def _sanitize_vehicle_definition(raw: Any, logger: Any | None = None) -> dict[str, Any]:
  defaults = VehicleDefinitionModel.model_validate(_FALLBACK_VEHICLE_DEFINITION).model_dump()
  if not isinstance(raw, dict):
    return defaults

  candidate = dict(defaults)
  candidate.update(raw)
  try:
    return VehicleDefinitionModel.model_validate(candidate).model_dump()
  except ValidationError as exc:
    invalid_fields = _validation_error_fields(exc)
    if not invalid_fields:
      if logger is not None:
        logger.warning(
          f"[ASSETS METADATA] invalid vehicle_definition schema: {_validation_error_detail(exc)}"
        )
      return defaults

    recovered_raw = dict(raw)
    for key in invalid_fields:
      recovered_raw.pop(key, None)

    recovered_candidate = dict(defaults)
    recovered_candidate.update(recovered_raw)
    try:
      model = VehicleDefinitionModel.model_validate(recovered_candidate)
    except ValidationError as recovered_exc:
      if logger is not None:
        logger.warning(
          f"[ASSETS METADATA] invalid vehicle_definition schema: {_validation_error_detail(recovered_exc)}"
        )
      return defaults

    if logger is not None:
      dropped_keys = ",".join(sorted(invalid_fields))
      logger.warning(
        f"[ASSETS METADATA] dropped invalid vehicle_definition keys: {dropped_keys}"
      )
    return model.model_dump()


# ── Structure instance sanitizer ─────────────────────────────────────────

def _sanitize_structure_site(raw: Any, index: int) -> dict[str, Any] | None:
  if not isinstance(raw, dict):
    return None
  lat = _coerce_finite_number(raw.get("lat"))
  lon = _coerce_finite_number(raw.get("lon"))
  if lat is None or lon is None:
    return None
  if lat < -90 or lat > 90 or lon < -180 or lon > 180:
    return None
  id_raw = raw.get("id")
  if isinstance(id_raw, str):
    site_id = id_raw.strip() or f"site-{index + 1:02d}"
  else:
    site_id = f"site-{index + 1:02d}"
  heading_deg = _coerce_finite_number(raw.get("headingDeg"))
  if heading_deg is None:
    heading_deg = 0.0
  heading_deg = heading_deg % 360.0
  scale = _coerce_finite_number(raw.get("scale"))
  if scale is None:
    scale = 1.0
  scale = max(0.05, min(scale, 10.0))
  tile_id = raw.get("tileId")
  if tile_id is None:
    tile_id_value = None
  else:
    tile_id_text = str(tile_id).strip()
    tile_id_value = tile_id_text if tile_id_text else None
  out = {
    "id": site_id,
    "lat": lat,
    "lon": lon,
    "headingDeg": heading_deg,
    "scale": scale,
  }
  if tile_id_value is not None:
    out["tileId"] = tile_id_value
  return out


def _sanitize_structure_sites(raw: Any) -> list[dict[str, Any]]:
  if not isinstance(raw, list):
    return []
  out: list[dict[str, Any]] = []
  for index, item in enumerate(raw[:512]):
    site = _sanitize_structure_site(item, index)
    if site is None:
      continue
    out.append(site)
  return out


# ── Vehicle instance sanitizer ───────────────────────────────────────────

def _sanitize_seed_vehicle_instance(
  raw: Any,
  index: int,
  logger: Any,
  fallback_seed: dict[str, Any],
) -> dict[str, Any] | None:
  if not isinstance(raw, dict):
    return None

  id_raw = raw.get("id")
  if isinstance(id_raw, str):
    vehicle_id = id_raw.strip() or f"vehicle-{index + 1:02d}"
  else:
    vehicle_id = f"vehicle-{index + 1:02d}"

  payload = {
    "lat": raw.get("lat", fallback_seed["lat"]),
    "lon": raw.get("lon", fallback_seed["lon"]),
    "headingDeg": raw.get("headingDeg", fallback_seed["headingDeg"]),
    "z": raw.get("z", fallback_seed.get("z")),
    "terrainDepth": raw.get("terrainDepth"),
    "terrainTileId": raw.get("terrainTileId"),
  }
  try:
    state = VehicleStateCommonModel.model_validate(payload)
  except ValidationError as exc:
    logger.warning(
      f"[VEHICLE] invalid seed vehicle instance id={vehicle_id}: "
      f"{_validation_error_detail(exc)}"
    )
    return None

  headlights_on = _coerce_bool(raw.get("headlightsOn"))
  if headlights_on is None:
    headlights_on = True

  return {
    "vehicleId": vehicle_id,
    "headlightsOn": headlights_on,
    "state": state,
  }


# ── Metadata loader ─────────────────────────────────────────────────────

def _load_assets_metadata(
  logger: Any,
) -> tuple[str, dict[str, Any], dict[str, Any], dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
  """Returns (source, vehicle_definition, vehicle_headlights, structure_definition,
              seed_vehicle_instances, seed_structure_instances)."""
  source = "metadata_file"
  raw_payload: Any = None

  try:
    raw_payload = json.loads(ASSETS_METADATA_PATH.read_text(encoding="utf-8"))
  except Exception as exc:
    logger.warning(
      f"[ASSETS METADATA] failed to load {ASSETS_METADATA_PATH.name}: "
      f"{type(exc).__name__}: {exc}"
    )
    raw_payload = None
    source = "defaults"

  if not isinstance(raw_payload, dict):
    if raw_payload is not None:
      logger.warning("[ASSETS METADATA] root payload must be an object")
    source = "defaults"
    raw_payload = {}

  metadata_version = _coerce_schema_version(raw_payload.get("metadataVersion"))

  # ── v2 schema: flat definitions ────────────────────────────────────
  if metadata_version is not None and metadata_version >= 2:
    raw_vehicle_def = raw_payload.get("vehicle_definition", {})
    raw_structure_def = raw_payload.get("structure_definition", {})
    raw_seed_vehicles = raw_payload.get("seed_vehicle_instances")
    raw_seed_structures = raw_payload.get("seed_structure_instances")

    # Extract headlights from vehicle_definition
    headlights_raw = raw_vehicle_def.get("headlights") if isinstance(raw_vehicle_def, dict) else None
    vehicle_headlights = _sanitize_vehicle_headlights(headlights_raw, logger)

  # ── v1 schema: nested metadata.model ───────────────────────────────
  else:
    raw_structure_metadata = raw_payload.get("structure_metadata")
    raw_vehicle_metadata = raw_payload.get("vehicle_metadata")

    raw_structure_def = (
      raw_structure_metadata.get("model")
      if isinstance(raw_structure_metadata, dict)
      else {}
    )
    raw_vehicle_def = (
      raw_vehicle_metadata.get("model")
      if isinstance(raw_vehicle_metadata, dict)
      else {}
    )
    raw_seed_vehicles = raw_payload.get("seed_vehicle_instances")
    raw_seed_structures = raw_payload.get("seed_structure_instances")
    vehicle_headlights = _default_vehicle_headlights()

  structure_definition = _sanitize_structure_definition(raw_structure_def)
  vehicle_definition = _sanitize_vehicle_definition(raw_vehicle_def, logger)

  # Seed structure instances
  seed_structure_instances = _sanitize_structure_sites(raw_seed_structures)
  if not seed_structure_instances:
    seed_structure_instances = _sanitize_structure_sites(_FALLBACK_SEED_STRUCTURE_INSTANCES)

  # Seed vehicle instances
  fallback_seed = dict(_FALLBACK_SEED_VEHICLE_INSTANCES[0])
  seed_vehicle_instances: list[dict[str, Any]] = []
  if isinstance(raw_seed_vehicles, list):
    for index, item in enumerate(raw_seed_vehicles[:256]):
      instance = _sanitize_seed_vehicle_instance(item, index, logger, fallback_seed)
      if instance is not None:
        seed_vehicle_instances.append(instance)
  if not seed_vehicle_instances:
    default_state = VehicleStateCommonModel.model_validate(fallback_seed)
    seed_vehicle_instances.append({
      "vehicleId": DEFAULT_VEHICLE_INSTANCE_ID,
      "headlightsOn": bool(fallback_seed.get("headlightsOn", True)),
      "state": default_state,
    })

  return source, vehicle_definition, vehicle_headlights, structure_definition, seed_vehicle_instances, seed_structure_instances


# ── DB: structure instances ──────────────────────────────────────────────

def _ensure_structure_sites_table(db: sqlite3.Connection) -> None:
  db.execute(
    f"""
    CREATE TABLE IF NOT EXISTS {STRUCTURE_SITES_TABLE} (
      id TEXT PRIMARY KEY,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      heading_deg REAL NOT NULL DEFAULT 0,
      scale REAL NOT NULL DEFAULT 1,
      tile_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """
  )


def _seed_structure_instances_if_empty(
  db: sqlite3.Connection,
  logger: Any,
  seed_instances: list[dict[str, Any]],
) -> bool:
  row = db.execute(
    f"SELECT COUNT(*) FROM {STRUCTURE_SITES_TABLE}"
  ).fetchone()
  count = int(row[0]) if row is not None else 0
  if count > 0:
    return False

  for site in seed_instances:
    db.execute(
      f"""
      INSERT OR REPLACE INTO {STRUCTURE_SITES_TABLE}
      (id, lat, lon, heading_deg, scale, tile_id, enabled)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      """,
      (
        str(site["id"]),
        float(site["lat"]),
        float(site["lon"]),
        float(site["headingDeg"]),
        float(site["scale"]),
        str(site.get("tileId")) if site.get("tileId") is not None else None,
      ),
    )
  db.commit()
  logger.info(
    f"[STRUCTURE] seeded {len(seed_instances)} default structure instances"
  )
  return True


def _load_structure_instances_from_db(
  db: sqlite3.Connection,
) -> list[dict[str, Any]]:
  rows = db.execute(
    f"""
    SELECT id, lat, lon, heading_deg, scale, tile_id
    FROM {STRUCTURE_SITES_TABLE}
    WHERE enabled = 1
    ORDER BY id
    """
  ).fetchall()
  out: list[dict[str, Any]] = []
  for index, row in enumerate(rows):
    site = _sanitize_structure_site(
      {
        "id": row[0],
        "lat": row[1],
        "lon": row[2],
        "headingDeg": row[3],
        "scale": row[4],
        "tileId": row[5],
      },
      index,
    )
    if site is None:
      continue
    out.append(site)
  return out


# ── DB: vehicle instances ────────────────────────────────────────────────

def _ensure_vehicle_instances_table(db: sqlite3.Connection) -> None:
  db.execute(
    f"""
    CREATE TABLE IF NOT EXISTS {VEHICLE_INSTANCES_TABLE} (
      vehicle_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      heading_deg REAL NOT NULL,
      z REAL,
      terrain_depth INTEGER,
      terrain_tile_id TEXT,
      headlights_on INTEGER NOT NULL DEFAULT 1,
      saved_at REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """
  )


def _migrate_headlights_column_if_needed(db: sqlite3.Connection, logger: Any) -> None:
  """Replace legacy headlights_json blob with simple headlights_on boolean."""
  columns = {
    row[1]
    for row in db.execute(f"PRAGMA table_info({VEHICLE_INSTANCES_TABLE})").fetchall()
  }
  if "headlights_json" not in columns:
    # Table either already has headlights_on or is brand new — nothing to do.
    return

  logger.info("[VEHICLE] migrating vehicle_instances: headlights_json → headlights_on")

  # Parse enabled state from the old JSON blob per row, default to on.
  rows = db.execute(
    f"SELECT vehicle_id, headlights_json FROM {VEHICLE_INSTANCES_TABLE}"
  ).fetchall()
  enabled_map: dict[str, bool] = {}
  for vid, hl_json in rows:
    on = True
    if isinstance(hl_json, str) and hl_json.strip():
      try:
        parsed = json.loads(hl_json)
        if isinstance(parsed, dict):
          on = bool(parsed.get("enabled", True))
      except Exception:
        pass
    enabled_map[str(vid)] = on

  db.execute(
    f"""
    CREATE TABLE {VEHICLE_INSTANCES_TABLE}_new (
      vehicle_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      heading_deg REAL NOT NULL,
      z REAL,
      terrain_depth INTEGER,
      terrain_tile_id TEXT,
      headlights_on INTEGER NOT NULL DEFAULT 1,
      saved_at REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """
  )
  db.execute(
    f"""
    INSERT INTO {VEHICLE_INSTANCES_TABLE}_new
      (vehicle_id, enabled, lat, lon, heading_deg, z, terrain_depth, terrain_tile_id, headlights_on, saved_at, updated_at)
    SELECT vehicle_id, enabled, lat, lon, heading_deg, z, terrain_depth, terrain_tile_id, 1, saved_at, updated_at
    FROM {VEHICLE_INSTANCES_TABLE}
    """
  )
  # Apply the per-row enabled state we parsed
  for vid, on in enabled_map.items():
    db.execute(
      f"UPDATE {VEHICLE_INSTANCES_TABLE}_new SET headlights_on = ? WHERE vehicle_id = ?",
      (1 if on else 0, vid),
    )
  db.execute(f"DROP TABLE {VEHICLE_INSTANCES_TABLE}")
  db.execute(f"ALTER TABLE {VEHICLE_INSTANCES_TABLE}_new RENAME TO {VEHICLE_INSTANCES_TABLE}")
  db.commit()
  logger.info("[VEHICLE] migrated headlights_json → headlights_on")


def _read_primary_vehicle_row(db: sqlite3.Connection) -> tuple | None:
  row = db.execute(
    f"""
    SELECT vehicle_id, lat, lon, heading_deg, z, terrain_depth, terrain_tile_id, headlights_on, saved_at
    FROM {VEHICLE_INSTANCES_TABLE}
    WHERE enabled = 1
    ORDER BY updated_at DESC, vehicle_id
    LIMIT 1
    """
  ).fetchone()
  if row is not None:
    return row
  return db.execute(
    f"""
    SELECT vehicle_id, lat, lon, heading_deg, z, terrain_depth, terrain_tile_id, headlights_on, saved_at
    FROM {VEHICLE_INSTANCES_TABLE}
    ORDER BY updated_at DESC, vehicle_id
    LIMIT 1
    """
  ).fetchone()


def _migrate_legacy_vehicle_metadata_if_needed(db: sqlite3.Connection, logger: Any) -> bool:
  row = db.execute(
    f"SELECT COUNT(*) FROM {VEHICLE_INSTANCES_TABLE}"
  ).fetchone()
  count = int(row[0]) if row is not None else 0
  if count > 0:
    return False

  legacy_state_row = db.execute(
    "SELECT value FROM metadata WHERE key = ?",
    (LEGACY_VEHICLE_STATE_METADATA_KEY,),
  ).fetchone()
  legacy_headlights_row = db.execute(
    "SELECT value FROM metadata WHERE key = ?",
    (LEGACY_VEHICLE_HEADLIGHTS_METADATA_KEY,),
  ).fetchone()

  if legacy_state_row is None and legacy_headlights_row is None:
    return False

  fallback = _FALLBACK_SEED_VEHICLE_INSTANCES[0]
  state_model = VehicleStateRecordModel(
    lat=fallback["lat"],
    lon=fallback["lon"],
    headingDeg=fallback["headingDeg"],
    z=fallback.get("z"),
    savedAt=time.time(),
  )

  if legacy_state_row is not None and legacy_state_row[0] is not None:
    try:
      raw_state = json.loads(legacy_state_row[0])
      state_model = VehicleStateRecordModel.model_validate(raw_state)
    except Exception as exc:
      logger.warning(
        f"[VEHICLE STATE] legacy metadata migration failed: {type(exc).__name__}: {exc}"
      )

  # Extract headlights enabled state from legacy blob, default to on.
  headlights_on = True
  if legacy_headlights_row is not None and legacy_headlights_row[0] is not None:
    try:
      raw_hl = json.loads(legacy_headlights_row[0])
      if isinstance(raw_hl, dict):
        headlights_on = bool(raw_hl.get("enabled", True))
    except Exception:
      pass

  db.execute(
    f"""
    INSERT OR REPLACE INTO {VEHICLE_INSTANCES_TABLE}
    (vehicle_id, enabled, lat, lon, heading_deg, z, terrain_depth, terrain_tile_id, headlights_on, saved_at, updated_at)
    VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    """,
    (
      DEFAULT_VEHICLE_INSTANCE_ID,
      state_model.lat,
      state_model.lon,
      state_model.headingDeg,
      state_model.z,
      state_model.terrainDepth,
      state_model.terrainTileId,
      1 if headlights_on else 0,
      state_model.savedAt,
    ),
  )
  db.execute(
    "DELETE FROM metadata WHERE key IN (?, ?)",
    (LEGACY_VEHICLE_STATE_METADATA_KEY, LEGACY_VEHICLE_HEADLIGHTS_METADATA_KEY),
  )
  db.commit()
  logger.info("[VEHICLE] migrated legacy metadata into vehicle_instances")
  return True


def _ensure_vehicle_instances_seeded(db: sqlite3.Connection, logger: Any, seed_instances: list[dict[str, Any]]) -> bool:
  _ensure_vehicle_instances_table(db)
  _migrate_headlights_column_if_needed(db, logger)
  migrated = _migrate_legacy_vehicle_metadata_if_needed(db, logger)

  row = db.execute(
    f"SELECT COUNT(*) FROM {VEHICLE_INSTANCES_TABLE}"
  ).fetchone()
  count = int(row[0]) if row is not None else 0
  if count > 0:
    return migrated

  for instance in seed_instances:
    state = instance["state"]
    db.execute(
      f"""
      INSERT OR REPLACE INTO {VEHICLE_INSTANCES_TABLE}
      (vehicle_id, enabled, lat, lon, heading_deg, z, terrain_depth, terrain_tile_id, headlights_on, saved_at, updated_at)
      VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      """,
      (
        str(instance["vehicleId"]),
        state.lat,
        state.lon,
        state.headingDeg,
        state.z,
        state.terrainDepth,
        state.terrainTileId,
        1 if instance.get("headlightsOn", True) else 0,
        time.time(),
      ),
    )
  db.commit()
  logger.info(f"[VEHICLE] seeded {len(seed_instances)} default vehicle instances")
  return True


def _load_vehicle_instances_from_db(db: sqlite3.Connection) -> list[dict[str, Any]]:
  rows = db.execute(
    f"""
    SELECT vehicle_id, lat, lon, heading_deg, z, terrain_depth, terrain_tile_id, headlights_on, saved_at
    FROM {VEHICLE_INSTANCES_TABLE}
    WHERE enabled = 1
    ORDER BY updated_at DESC, vehicle_id
    """
  ).fetchall()
  out: list[dict[str, Any]] = []
  for row in rows:
    payload = {
      "lat": row[1],
      "lon": row[2],
      "headingDeg": row[3],
      "z": row[4],
      "terrainDepth": row[5],
      "terrainTileId": row[6],
      "savedAt": row[8],
    }
    try:
      state_model = VehicleStateRecordModel.model_validate(payload)
    except ValidationError:
      continue
    out.append({
      "id": str(row[0]),
      "headlightsOn": bool(row[7]),
      **state_model.model_dump(exclude_none=True),
    })
  return out


# ── Public API: get_assets_response ──────────────────────────────────────

def get_assets_response(db: sqlite3.Connection, logger: Any) -> dict[str, Any]:
  (
    metadata_source,
    vehicle_definition,
    vehicle_headlights,
    structure_definition,
    seed_vehicle_instances,
    seed_structure_instances,
  ) = _load_assets_metadata(logger)

  # Structure DB
  _ensure_structure_sites_table(db)
  seeded_structures = _seed_structure_instances_if_empty(db, logger, seed_structure_instances)
  structure_instances = _load_structure_instances_from_db(db)

  # Vehicle DB
  seeded_vehicles = _ensure_vehicle_instances_seeded(db, logger, seed_vehicle_instances)
  vehicle_instances = _load_vehicle_instances_from_db(db)

  source = metadata_source

  return {
    "ok": True,
    "source": source,
    "schemaVersion": ASSETS_RESPONSE_SCHEMA_VERSION,
    "seeded": {
      "structureInstances": seeded_structures,
      "vehicleInstances": seeded_vehicles,
    },
    "vehicle_definition": {
      **vehicle_definition,
      "headlights": vehicle_headlights,
    },
    "structure_definition": structure_definition,
    "vehicle_instances": vehicle_instances,
    "structure_instances": structure_instances,
  }


# ── Public API: save_vehicle_state_response ──────────────────────────────

def _resolve_primary_vehicle_id(db: sqlite3.Connection) -> str:
  row = _read_primary_vehicle_row(db)
  if row is None:
    return DEFAULT_VEHICLE_INSTANCE_ID
  return str(row[0])


def save_vehicle_state_response(
  db: sqlite3.Connection,
  data: dict[str, Any],
  logger: Any,
) -> tuple[dict[str, Any], int]:
  try:
    request = SaveVehicleStateRequestModel.model_validate(data)
  except ValidationError as exc:
    return {"error": f"invalid vehicle state payload: {_validation_error_detail(exc)}"}, 400

  _ensure_vehicle_instances_table(db)
  vehicle_id = _resolve_primary_vehicle_id(db)

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
    f"""
    INSERT INTO {VEHICLE_INSTANCES_TABLE}
    (vehicle_id, enabled, lat, lon, heading_deg, z, terrain_depth, terrain_tile_id, saved_at, updated_at)
    VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(vehicle_id) DO UPDATE SET
      enabled = 1,
      lat = excluded.lat,
      lon = excluded.lon,
      heading_deg = excluded.heading_deg,
      z = excluded.z,
      terrain_depth = excluded.terrain_depth,
      terrain_tile_id = excluded.terrain_tile_id,
      saved_at = excluded.saved_at,
      updated_at = CURRENT_TIMESTAMP
    """,
    (
      vehicle_id,
      state_model.lat,
      state_model.lon,
      state_model.headingDeg,
      state_model.z,
      state_model.terrainDepth,
      state_model.terrainTileId,
      state_model.savedAt,
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
      f"[VEHICLE STATE] saved vehicle_id={vehicle_id} "
      f"lat={request.lat:.6f} lon={request.lon:.6f} "
      f"headingDeg={state_model.headingDeg:.2f}{depth_log}{reason_log}"
    )
  else:
    logger.info(
      f"[VEHICLE STATE] saved vehicle_id={vehicle_id} "
      f"lat={request.lat:.6f} lon={request.lon:.6f} "
      f"headingDeg={state_model.headingDeg:.2f} z={request.z:.3f}{depth_log}{reason_log}"
    )

  return {
    "ok": True,
    "vehicleId": vehicle_id,
    "state": state_model.model_dump(exclude_none=True),
  }, 200
