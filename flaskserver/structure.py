from __future__ import annotations

import json
import math
import sqlite3
from typing import Any

ASSETS_BOOTSTRAP_METADATA_KEY = "assets_bootstrap"
ASSETS_BOOTSTRAP_LEGACY_METADATA_KEY = "assets_bootstrap_v1"
ASSETS_BOOTSTRAP_SCHEMA_VERSION = 1
STRUCTURE_SITES_TABLE = "structure_sites"

_DEFAULT_STRUCTURE_MODEL = {
  "url": "/models/house_test.glb",
  "altOffsetM": 0.4,
  "hotReloadMs": 2000,
  "enabled": False,
}
_DEFAULT_STRUCTURE_SITES = [
  {"id": "nuuk-01", "lat": 64.179102, "lon": -51.712988, "headingDeg": 22, "scale": 1.00, "tileId": "12-1375-791"},
  {"id": "nuuk-02", "lat": 64.174556, "lon": -51.703948, "headingDeg": 58, "scale": 0.96, "tileId": "12-1376-791"},
  {"id": "nuuk-03", "lat": 64.185330, "lon": -51.703495, "headingDeg": 96, "scale": 1.08, "tileId": "12-1376-792"},
  {"id": "nuuk-04", "lat": 64.182984, "lon": -51.726468, "headingDeg": 144, "scale": 1.03, "tileId": "12-1374-792"},
  {"id": "nuuk-05", "lat": 64.173514, "lon": -51.718454, "headingDeg": 210, "scale": 0.98, "tileId": "12-1374-791"},
  {"id": "nuuk-06", "lat": 64.178473, "lon": -51.724776, "headingDeg": 288, "scale": 1.04, "tileId": "12-1374-791"},
]
_DEFAULT_VEHICLE_MODEL = {
  "url": "/models/patria_amv.glb",
  "lat": 64.18423381,
  "lon": -51.70139232,
  "headingDeg": 234.341,
  "z": 16.279,
  "realLengthM": 7.7,
  "tireDiameterM": 1.27,
  "altOffsetM": 0.05,
}


def _copy_default_assets_bootstrap() -> dict[str, Any]:
  return {
    "structureModel": dict(_DEFAULT_STRUCTURE_MODEL),
    "structureSites": [],
    "vehicleModel": dict(_DEFAULT_VEHICLE_MODEL),
  }


def _default_assets_bootstrap_metadata_payload() -> dict[str, Any]:
  return {
    "version": ASSETS_BOOTSTRAP_SCHEMA_VERSION,
    "structureModel": dict(_DEFAULT_STRUCTURE_MODEL),
    "vehicleModel": dict(_DEFAULT_VEHICLE_MODEL),
  }


def _metadata_json_value(
  db: sqlite3.Connection,
  key: str,
  logger: Any,
) -> tuple[Any | None, bool]:
  row = db.execute(
    "SELECT value FROM metadata WHERE key = ?",
    (key,),
  ).fetchone()
  if row is None or row[0] is None:
    return None, False
  try:
    return json.loads(row[0]), False
  except Exception as exc:
    logger.warning(
      f"[METADATA] invalid JSON key={key}: {type(exc).__name__}: {exc}"
    )
    return None, True


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


def _sanitize_structure_model(raw: Any) -> dict[str, Any]:
  out = dict(_DEFAULT_STRUCTURE_MODEL)
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


def _seed_default_structure_sites_if_empty(
  db: sqlite3.Connection,
  logger: Any,
) -> bool:
  row = db.execute(
    f"SELECT COUNT(*) FROM {STRUCTURE_SITES_TABLE}"
  ).fetchone()
  count = int(row[0]) if row is not None else 0
  if count > 0:
    return False
  for site in _DEFAULT_STRUCTURE_SITES:
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
    f"[STRUCTURE] seeded {len(_DEFAULT_STRUCTURE_SITES)} default structure sites"
  )
  return True


def _load_structure_sites_from_db(
  db: sqlite3.Connection,
  logger: Any,
) -> tuple[list[dict[str, Any]], bool]:
  _ensure_structure_sites_table(db)
  seeded = _seed_default_structure_sites_if_empty(db, logger)
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
  return out, seeded


def _sanitize_vehicle_model(raw: Any) -> dict[str, Any]:
  out = dict(_DEFAULT_VEHICLE_MODEL)
  if not isinstance(raw, dict):
    return out
  url = raw.get("url")
  if isinstance(url, str):
    stripped = url.strip()
    if stripped:
      out["url"] = stripped
  lat = _coerce_finite_number(raw.get("lat"))
  if lat is not None and -90 <= lat <= 90:
    out["lat"] = lat
  lon = _coerce_finite_number(raw.get("lon"))
  if lon is not None and -180 <= lon <= 180:
    out["lon"] = lon
  heading_deg = _coerce_finite_number(raw.get("headingDeg"))
  if heading_deg is not None:
    out["headingDeg"] = heading_deg % 360.0
  z = _coerce_finite_number(raw.get("z"))
  if z is not None:
    out["z"] = z
  real_length_m = _coerce_finite_number(raw.get("realLengthM"))
  if real_length_m is not None and real_length_m > 0:
    out["realLengthM"] = real_length_m
  tire_diameter_m = _coerce_finite_number(raw.get("tireDiameterM"))
  if tire_diameter_m is not None and tire_diameter_m > 0:
    out["tireDiameterM"] = tire_diameter_m
  alt_offset_m = _coerce_finite_number(raw.get("altOffsetM"))
  if alt_offset_m is not None:
    out["altOffsetM"] = alt_offset_m
  return out


def _sanitize_assets_bootstrap(raw: Any) -> dict[str, Any]:
  if not isinstance(raw, dict):
    return _copy_default_assets_bootstrap()
  return {
    "structureModel": _sanitize_structure_model(raw.get("structureModel")),
    "structureSites": _sanitize_structure_sites(raw.get("structureSites")),
    "vehicleModel": _sanitize_vehicle_model(raw.get("vehicleModel")),
  }


def _coerce_schema_version(value: Any) -> int | None:
  number = _coerce_finite_number(value)
  if number is None:
    return None
  int_value = int(number)
  if int_value == number and int_value >= 0:
    return int_value
  return None


def _read_assets_bootstrap_payload(
  db: sqlite3.Connection,
  logger: Any,
) -> tuple[Any | None, str | None, bool]:
  corrupt = False
  payload, payload_corrupt = _metadata_json_value(
    db,
    ASSETS_BOOTSTRAP_METADATA_KEY,
    logger,
  )
  corrupt = corrupt or payload_corrupt
  if payload is not None:
    return payload, ASSETS_BOOTSTRAP_METADATA_KEY, corrupt

  legacy_payload, legacy_corrupt = _metadata_json_value(
    db,
    ASSETS_BOOTSTRAP_LEGACY_METADATA_KEY,
    logger,
  )
  corrupt = corrupt or legacy_corrupt
  if legacy_payload is not None:
    return legacy_payload, ASSETS_BOOTSTRAP_LEGACY_METADATA_KEY, corrupt
  return None, None, corrupt


def _ensure_default_assets_bootstrap_metadata(db: sqlite3.Connection) -> bool:
  existing = db.execute(
    "SELECT key FROM metadata WHERE key IN (?, ?) LIMIT 1",
    (ASSETS_BOOTSTRAP_METADATA_KEY, ASSETS_BOOTSTRAP_LEGACY_METADATA_KEY),
  ).fetchone()
  if existing is not None:
    return False
  payload = _default_assets_bootstrap_metadata_payload()
  db.execute(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
    (ASSETS_BOOTSTRAP_METADATA_KEY, json.dumps(payload, separators=(",", ":"))),
  )
  db.commit()
  return True


def _decode_assets_bootstrap_payload(
  raw_payload: Any,
  source_key: str | None,
  logger: Any,
) -> tuple[int, dict[str, Any], bool]:
  if source_key == ASSETS_BOOTSTRAP_LEGACY_METADATA_KEY:
    return ASSETS_BOOTSTRAP_SCHEMA_VERSION, _sanitize_assets_bootstrap(raw_payload), False
  if not isinstance(raw_payload, dict):
    return ASSETS_BOOTSTRAP_SCHEMA_VERSION, _copy_default_assets_bootstrap(), False

  raw_version = _coerce_schema_version(raw_payload.get("version"))
  if raw_version is None:
    return ASSETS_BOOTSTRAP_SCHEMA_VERSION, _sanitize_assets_bootstrap(raw_payload), False
  if raw_version != ASSETS_BOOTSTRAP_SCHEMA_VERSION:
    logger.warning(
      f"[ASSETS BOOTSTRAP] unsupported version={raw_version} "
      f"(expected {ASSETS_BOOTSTRAP_SCHEMA_VERSION})"
    )
    return raw_version, _copy_default_assets_bootstrap(), True
  return raw_version, _sanitize_assets_bootstrap(raw_payload), False


def get_assets_bootstrap_response(db: sqlite3.Connection, logger: Any) -> dict[str, Any]:
  metadata_seeded = _ensure_default_assets_bootstrap_metadata(db)
  _ensure_structure_sites_table(db)
  payload, source_key, corrupt = _read_assets_bootstrap_payload(db, logger)
  version, assets, version_error = _decode_assets_bootstrap_payload(payload, source_key, logger)
  corrupt = corrupt or version_error
  structure_sites, structure_seeded = _load_structure_sites_from_db(db, logger)
  assets["structureSites"] = structure_sites
  structure_sites_source = "db"
  if payload is None:
    source = "defaults"
    metadata_key = ASSETS_BOOTSTRAP_METADATA_KEY
  else:
    source = "metadata"
    metadata_key = source_key

  return {
    "ok": True,
    "source": source,
    "metadataKey": metadata_key,
    "schemaVersion": ASSETS_BOOTSTRAP_SCHEMA_VERSION,
    "version": version,
    "corrupt": corrupt,
    "structureSitesSource": structure_sites_source,
    "seeded": {
      "metadata": metadata_seeded,
      "structureSites": structure_seeded,
    },
    "assets": assets,
  }
