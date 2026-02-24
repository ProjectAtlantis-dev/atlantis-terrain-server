from __future__ import annotations

import json
import math
import sqlite3
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

ASSETS_RESPONSE_SCHEMA_VERSION = 3
STRUCTURE_SITES_TABLE = "structure_sites"
ASSETS_METADATA_PATH = Path(__file__).with_name("assets_metadata.json")

_FALLBACK_STRUCTURE_MODEL = {
  "url": "/models/house_test.glb",
  "altOffsetM": 0.4,
  "hotReloadMs": 2000,
  "enabled": False,
}
_FALLBACK_STRUCTURE_SEED_INSTANCES = [
  {"id": "nuuk-01", "lat": 64.179102, "lon": -51.712988, "headingDeg": 22, "scale": 1.00, "tileId": "12-1375-791"},
  {"id": "nuuk-02", "lat": 64.174556, "lon": -51.703948, "headingDeg": 58, "scale": 0.96, "tileId": "12-1376-791"},
  {"id": "nuuk-03", "lat": 64.185330, "lon": -51.703495, "headingDeg": 96, "scale": 1.08, "tileId": "12-1376-792"},
  {"id": "nuuk-04", "lat": 64.182984, "lon": -51.726468, "headingDeg": 144, "scale": 1.03, "tileId": "12-1374-792"},
  {"id": "nuuk-05", "lat": 64.173514, "lon": -51.718454, "headingDeg": 210, "scale": 0.98, "tileId": "12-1374-791"},
  {"id": "nuuk-06", "lat": 64.178473, "lon": -51.724776, "headingDeg": 288, "scale": 1.04, "tileId": "12-1374-791"},
]
_FALLBACK_VEHICLE_MODEL = {
  "url": "/models/patria_amv.glb",
  "lat": 64.18423381,
  "lon": -51.70139232,
  "headingDeg": 234.341,
  "z": 16.279,
  "realLengthM": 7.7,
  "tireDiameterM": 1.27,
  "altOffsetM": 0.05,
}
_FALLBACK_ASSETS_METADATA = {
  "metadataVersion": 1,
  "structure_metadata": {
    "model": dict(_FALLBACK_STRUCTURE_MODEL),
  },
  "vehicle_metadata": {
    "model": dict(_FALLBACK_VEHICLE_MODEL),
  },
  "seed_structure_instances": [dict(site) for site in _FALLBACK_STRUCTURE_SEED_INSTANCES],
}


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


class VehicleModelConfig(BaseModel):
  model_config = ConfigDict(extra="ignore")

  url: str = str(_FALLBACK_VEHICLE_MODEL["url"])
  lat: float = float(_FALLBACK_VEHICLE_MODEL["lat"])
  lon: float = float(_FALLBACK_VEHICLE_MODEL["lon"])
  headingDeg: float = float(_FALLBACK_VEHICLE_MODEL["headingDeg"])
  z: float = float(_FALLBACK_VEHICLE_MODEL["z"])
  realLengthM: float = Field(default=float(_FALLBACK_VEHICLE_MODEL["realLengthM"]), gt=0)
  tireDiameterM: float = Field(default=float(_FALLBACK_VEHICLE_MODEL["tireDiameterM"]), gt=0)
  altOffsetM: float = float(_FALLBACK_VEHICLE_MODEL["altOffsetM"])

  @field_validator("url", mode="before")
  @classmethod
  def normalize_url(cls, value: Any) -> str:
    if not isinstance(value, str):
      raise ValueError("must be a string")
    text = value.strip()
    if not text:
      raise ValueError("must be a non-empty string")
    return text

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

  @field_validator("z", "realLengthM", "tireDiameterM", "altOffsetM")
  @classmethod
  def validate_finite_number(cls, value: float) -> float:
    if not math.isfinite(value):
      raise ValueError("must be finite")
    return value


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


def _coerce_schema_version(value: Any) -> int | None:
  number = _coerce_finite_number(value)
  if number is None:
    return None
  int_value = int(number)
  if int_value == number and int_value >= 0:
    return int_value
  return None


def _sanitize_structure_model(raw: Any) -> dict[str, Any]:
  out = dict(_FALLBACK_STRUCTURE_MODEL)
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


def _sanitize_vehicle_model(raw: Any, logger: Any | None = None) -> dict[str, Any]:
  defaults = VehicleModelConfig.model_validate(_FALLBACK_VEHICLE_MODEL).model_dump()
  if not isinstance(raw, dict):
    return defaults

  candidate = dict(defaults)
  candidate.update(raw)
  try:
    return VehicleModelConfig.model_validate(candidate).model_dump()
  except ValidationError as exc:
    invalid_fields = _validation_error_fields(exc)
    if not invalid_fields:
      if logger is not None:
        logger.warning(
          f"[ASSETS METADATA] invalid vehicle_metadata.model schema: {_validation_error_detail(exc)}"
        )
      return defaults

    recovered_raw = dict(raw)
    for key in invalid_fields:
      recovered_raw.pop(key, None)

    recovered_candidate = dict(defaults)
    recovered_candidate.update(recovered_raw)
    try:
      model = VehicleModelConfig.model_validate(recovered_candidate)
    except ValidationError as recovered_exc:
      if logger is not None:
        logger.warning(
          f"[ASSETS METADATA] invalid vehicle_metadata.model schema: {_validation_error_detail(recovered_exc)}"
        )
      return defaults

    if logger is not None:
      dropped_keys = ",".join(sorted(invalid_fields))
      logger.warning(
        f"[ASSETS METADATA] dropped invalid vehicle_metadata.model keys: {dropped_keys}"
      )
    return model.model_dump()


def _load_assets_metadata(
  logger: Any,
) -> tuple[str, bool, int, dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
  source = "metadata_file"
  corrupt = False
  raw_payload: Any = None

  try:
    raw_payload = json.loads(ASSETS_METADATA_PATH.read_text(encoding="utf-8"))
  except Exception as exc:
    logger.warning(
      f"[ASSETS METADATA] failed to load {ASSETS_METADATA_PATH.name}: "
      f"{type(exc).__name__}: {exc}"
    )
    raw_payload = dict(_FALLBACK_ASSETS_METADATA)
    source = "metadata_fallback"
    corrupt = True

  if not isinstance(raw_payload, dict):
    logger.warning("[ASSETS METADATA] root payload must be an object")
    raw_payload = dict(_FALLBACK_ASSETS_METADATA)
    source = "metadata_fallback"
    corrupt = True

  metadata_version = _coerce_schema_version(raw_payload.get("metadataVersion"))
  if metadata_version is None:
    metadata_version = int(_FALLBACK_ASSETS_METADATA["metadataVersion"])

  raw_structure_metadata = raw_payload.get("structure_metadata")
  raw_vehicle_metadata = raw_payload.get("vehicle_metadata")
  raw_seed_instances = raw_payload.get("seed_structure_instances")

  structure_model_raw = (
    raw_structure_metadata.get("model")
    if isinstance(raw_structure_metadata, dict)
    else _FALLBACK_ASSETS_METADATA["structure_metadata"]["model"]
  )
  vehicle_model_raw = (
    raw_vehicle_metadata.get("model")
    if isinstance(raw_vehicle_metadata, dict)
    else _FALLBACK_ASSETS_METADATA["vehicle_metadata"]["model"]
  )

  if raw_seed_instances is None:
    raw_seed_instances = _FALLBACK_ASSETS_METADATA["seed_structure_instances"]
  seed_instances = _sanitize_structure_sites(raw_seed_instances)
  if not seed_instances:
    seed_instances = _sanitize_structure_sites(_FALLBACK_ASSETS_METADATA["seed_structure_instances"])

  structure_model = _sanitize_structure_model(structure_model_raw)
  vehicle_model = _sanitize_vehicle_model(vehicle_model_raw, logger)

  return source, corrupt, metadata_version, structure_model, vehicle_model, seed_instances


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


def get_assets_bootstrap_response(db: sqlite3.Connection, logger: Any) -> dict[str, Any]:
  (
    metadata_source,
    metadata_corrupt,
    metadata_version,
    structure_model,
    vehicle_model,
    seed_instances,
  ) = _load_assets_metadata(logger)

  _ensure_structure_sites_table(db)
  seeded_structure_instances = _seed_structure_instances_if_empty(db, logger, seed_instances)
  structure_instances = _load_structure_instances_from_db(db)

  source = "defaults" if seeded_structure_instances else metadata_source

  return {
    "ok": True,
    "source": source,
    "metadataKey": None,
    "schemaVersion": ASSETS_RESPONSE_SCHEMA_VERSION,
    "version": metadata_version,
    "corrupt": metadata_corrupt,
    "structureInstancesSource": "db",
    "seeded": {
      "structureInstances": seeded_structure_instances,
    },
    "assets": {
      "structure_metadata": {
        "model": structure_model,
      },
      "vehicle_metadata": {
        "model": vehicle_model,
      },
      "structure_instances": structure_instances,
    },
  }
