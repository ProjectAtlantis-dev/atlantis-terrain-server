from __future__ import annotations

import base64
import io
import json
import logging
import math
import os
import re
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
import zlib
from concurrent.futures import ThreadPoolExecutor
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

from colored_log import get_logger
from terrain_config import BOOTSTRAP_SEED_DEPTH, ENHANCE_DEPTH

log = get_logger("terrain")
log_db = get_logger("terrain.db")
log_tex = get_logger("terrain.tex")
log_cog = get_logger("terrain.cog")

ROOT = Path(__file__).resolve().parent.parent

from flask import Flask, Response, g, jsonify, request, send_from_directory
DIST_DIR = ROOT / "webserver" / "dist"
STATIC_DIR = str(DIST_DIR)

FLASK_DIR = Path(__file__).resolve().parent
LOCAL_DB_PATH = FLASK_DIR / "terrain.db"
CLIENT_LOG_PATH = FLASK_DIR / os.environ.get("CLIENT_LOG_FILE", "client_debug.log")


def _resolve_db_path() -> Path:
  explicit = os.environ.get("TERRAIN_DB_PATH", "").strip()
  if explicit:
    return Path(explicit).expanduser().resolve()
  return LOCAL_DB_PATH


DB_PATH = _resolve_db_path()

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="")


def _env_bool(name: str, default: bool = False) -> bool:
  raw = os.environ.get(name)
  if raw is None:
    return default
  return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
  raw = os.environ.get(name)
  if raw is None:
    return default
  try:
    return int(raw)
  except (TypeError, ValueError):
    return default


CLIENT_LOG_MAX_BYTES = max(1024, _env_int("CLIENT_LOG_MAX_BYTES", 8 * 1024 * 1024))
CLIENT_LOG_BACKUP_COUNT = max(1, _env_int("CLIENT_LOG_BACKUP_COUNT", 4))
_client_log = logging.getLogger("terrain.client")
if not _client_log.handlers:
  CLIENT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
  _client_handler = RotatingFileHandler(
    str(CLIENT_LOG_PATH),
    maxBytes=CLIENT_LOG_MAX_BYTES,
    backupCount=CLIENT_LOG_BACKUP_COUNT,
    encoding="utf-8",
  )
  class _ClientColorFormatter(logging.Formatter):
    """Pretty-print JSON client logs with ANSI colors."""
    _LEVEL_COLORS = {
      logging.DEBUG:    "\033[36m",    # cyan
      logging.INFO:     "\033[32m",    # green
      logging.WARNING:  "\033[33m",    # yellow
      logging.ERROR:    "\033[31m",    # red
      logging.CRITICAL: "\033[1;31m",  # bold red
    }
    _RESET = "\033[0m"
    _DIM = "\033[2m"
    _BOLD = "\033[1m"
    _PHASE_COLOR = "\033[35m"  # magenta

    def format(self, record):
      ts = self.formatTime(record, self.datefmt)
      color = self._LEVEL_COLORS.get(record.levelno, "")
      level = record.levelname
      # Try to pretty-print the JSON message
      msg = record.getMessage()
      try:
        obj = json.loads(msg)
        phase = obj.pop("phase", "client.log")
        pretty = json.dumps(obj, indent=2, ensure_ascii=False, default=str)
        return (
          f"{self._DIM}{ts}{self._RESET} "
          f"{color}[{level}]{self._RESET} "
          f"{self._PHASE_COLOR}{phase}{self._RESET} "
          f"{pretty}"
        )
      except Exception:
        return f"{self._DIM}{ts}{self._RESET} {color}[{level}]{self._RESET} {msg}"

  _client_handler.setFormatter(_ClientColorFormatter())
  _client_log.addHandler(_client_handler)
  _client_log.setLevel(logging.INFO)
  _client_log.propagate = False


ENABLE_WATER_MASKS = _env_bool("ENABLE_WATER_MASKS", default=False)

# Lazily imported terrain backend symbols.
_backend_ready = False
_backend_error: str | None = None
_np: Any = None
_Image: Any = None
_to_stereo: Any = None
_query_tiles_stereo: Any = None
_load_no_data_cache: Any = None
_GRID_N: int = 65
_tile_bbox: Any = None
_texture_ids_in: Any = None
_read_texture: Any = None
_write_texture: Any = None
_water_mask_ids_in: Any = None
_read_water_mask: Any = None
_write_water_mask: Any = None
_build_water_mask: Any = None
_fetch_sentinel2_texture: Any = None
_fetch_dataforsyningen_texture: Any = None
_fetch_enhanced_texture: Any = None
_init_textures: Any = None
_enqueue_seam_jobs: Any = None

_tex_pool = ThreadPoolExecutor(max_workers=4)
_tex_fetching: set[str] = set()
_tex_fetching_lock = threading.Lock()

_enhance_pool = ThreadPoolExecutor(max_workers=2)
_enhancing: set[str] = set()
_enhancing_lock = threading.Lock()
ENHANCE_MAX_QUEUED = 4  # max tiles in ComfyUI queue at once

_cog_fetch_lock = threading.Lock()
_cog_fetching_tiles: set[str] = set()

_SUPIR_TILE_RE = re.compile(r"\b(?:supir|upscaled)_(\d+-\d+-\d+)\b")
_INPUT_TILE_RE = re.compile(r"\btile_(\d+-\d+-\d+)_(?:texture|heightmap)\.png\b")


def _recover_comfy_jobs():
  """On startup, check ComfyUI /queue for in-flight tile jobs and resume tracking them."""
  from texture import COMFY_URL
  log_tex.info(f"[ENHANCE RECOVERY] checking ComfyUI at {COMFY_URL}")
  try:
    resp = urllib.request.urlopen(f"{COMFY_URL}/queue", timeout=10)
    queue = json.loads(resp.read())
  except Exception as e:
    log_tex.warning(f"[ENHANCE RECOVERY] can't reach ComfyUI: {e}")
    return

  # Extract (prompt_id, tile_id) pairs from running + pending
  jobs: list[tuple[str, str]] = []  # (prompt_id, tile_id)
  ignored_wrong_depth = 0
  for item in queue.get("queue_running", []) + queue.get("queue_pending", []):
    # prompt_id is item[1] in the list format comfy uses
    prompt_id = item[1] if isinstance(item, (list, tuple)) and len(item) > 1 else None
    if not prompt_id:
      continue
    # find tile IDs in the prompt data
    found: set[str] = set()
    for text in _iter_all_strings(item):
      for m in _SUPIR_TILE_RE.findall(text):
        found.add(m)
      for m in _INPUT_TILE_RE.findall(text):
        found.add(m)
    for tid in found:
      parsed = _parse_tile_id(tid)
      if parsed is None or parsed[0] != ENHANCE_DEPTH:
        ignored_wrong_depth += 1
        continue
      jobs.append((prompt_id, tid))

  if not jobs:
    if ignored_wrong_depth:
      log_tex.info(f"[ENHANCE RECOVERY] ignored {ignored_wrong_depth} non-depth-{ENHANCE_DEPTH} jobs")
    return

  # Filter out tiles that are already enhanced in the DB
  db = sqlite3.connect(str(DB_PATH), check_same_thread=False)
  try:
    already = set()
    for _, tid in jobs:
      row = db.execute(
        "SELECT source FROM textures WHERE tile_id = ?", (tid,)
      ).fetchone()
      if row and row[0] in ("dataforsyningen_enhanced", "sentinel2_enhanced", "upscaled"):
        already.add(tid)
  finally:
    db.close()

  jobs = [(pid, tid) for pid, tid in jobs if tid not in already]
  if not jobs:
    if already:
      log_tex.info(f"[ENHANCE RECOVERY] {len(already)} comfy jobs already enhanced, nothing to recover")
    return

  tile_ids = [tid for _, tid in jobs]
  log_tex.info(f"[ENHANCE RECOVERY] recovering {len(jobs)} in-flight comfy jobs: {tile_ids}")
  with _enhancing_lock:
    for _, tid in jobs:
      _enhancing.add(tid)

  for prompt_id, tid in jobs:
    _enhance_pool.submit(_recover_worker, prompt_id, tid)


def _iter_all_strings(value):
  """Recursively yield all strings from a nested structure."""
  if isinstance(value, str):
    yield value
  elif isinstance(value, dict):
    for v in value.values():
      yield from _iter_all_strings(v)
  elif isinstance(value, (list, tuple)):
    for v in value:
      yield from _iter_all_strings(v)


def _recover_worker(prompt_id: str, tile_id: str):
  """Poll ComfyUI for a pre-existing job and save the result when done."""
  from texture import COMFY_URL
  log_tex.info(f"[ENHANCE RECOVERY] waiting for {tile_id} (prompt={prompt_id[:8]}...)")
  start = time.time()
  wdb = None
  try:
    while time.time() - start < 600:
      time.sleep(3)
      try:
        resp = urllib.request.urlopen(f"{COMFY_URL}/history/{prompt_id}", timeout=10)
        history = json.loads(resp.read())
      except Exception:
        continue
      if prompt_id not in history:
        continue
      entry = history[prompt_id]
      status = entry.get("status", {})
      status_str = status.get("status_str", "")

      if status_str == "error":
        log_tex.error(f"[ENHANCE RECOVERY] {tile_id} failed on comfy")
        return

      if status_str == "success" or status.get("completed"):
        # Download result image
        outputs = entry.get("outputs", {})
        for nid, out in outputs.items():
          if "images" not in out:
            continue
          for img_info in out["images"]:
            fname = img_info["filename"]
            subfolder = img_info.get("subfolder", "")
            img_type = img_info.get("type", "output")
            view_url = (
              f"{COMFY_URL}/view?"
              f"filename={urllib.parse.quote(fname)}"
              f"&type={img_type}"
            )
            if subfolder:
              view_url += f"&subfolder={urllib.parse.quote(subfolder)}"
            with urllib.request.urlopen(view_url, timeout=30) as dl:
              result_png = dl.read()
            from PIL import Image as _PILImage
            result_img = _PILImage.open(io.BytesIO(result_png)).convert("RGB")
            buf = io.BytesIO()
            result_img.save(buf, format="JPEG", quality=90)
            jpeg_bytes = buf.getvalue()
            wdb = sqlite3.connect(str(DB_PATH), check_same_thread=False)
            wdb.execute("PRAGMA journal_mode=WAL")
            if _init_textures is not None:
              _init_textures(wdb)
            _write_texture(wdb, tile_id, jpeg_bytes, "dataforsyningen_enhanced")
            _update_water_mask_for_tile(wdb, tile_id, jpeg_bytes, "dataforsyningen_enhanced")
            log_tex.info(f"[ENHANCE RECOVERY] {tile_id} saved ({len(jpeg_bytes)} bytes)")
            return
        log_tex.warning(f"[ENHANCE RECOVERY] {tile_id} completed but no output images")
        return

    log_tex.warning(f"[ENHANCE RECOVERY] {tile_id} timed out after 600s")
  except Exception as e:
    log_tex.error(f"[ENHANCE RECOVERY] {tile_id} error: {e}")
  finally:
    if wdb is not None:
      wdb.close()
    with _enhancing_lock:
      _enhancing.discard(tile_id)



def _bootstrap_backend() -> None:
  global _backend_ready, _backend_error
  global _np, _Image, _to_stereo, _query_tiles_stereo, _load_no_data_cache
  global _GRID_N, _tile_bbox, _texture_ids_in, _read_texture, _write_texture
  global _water_mask_ids_in, _read_water_mask, _write_water_mask, _build_water_mask
  global _fetch_sentinel2_texture, _fetch_dataforsyningen_texture, _fetch_enhanced_texture, _init_textures, _enqueue_seam_jobs

  if _backend_ready or _backend_error is not None:
    return

  try:
    import numpy as np  # type: ignore
    from PIL import Image  # type: ignore

    from coords import to_stereo
    from database import GRID_N, _tile_bbox as terrain_tile_bbox, seed_tiles, open_db
    from seam_queue import enqueue_tile_and_neighbors
    from serve import load_no_data_cache, query_tiles_stereo
    from texture import (
      fetch_dataforsyningen_texture,
      fetch_enhanced_texture,
      fetch_sentinel2_texture,
      build_water_mask,
      init_textures,
      read_water_mask,
      read_texture,
      texture_ids_in,
      water_mask_ids_in,
      write_water_mask,
      write_texture,
    )

    db = open_db(str(DB_PATH))

    tile_count = db.execute("SELECT COUNT(*) FROM tiles").fetchone()[0]
    if tile_count == 0:
      seed_depth = max(0, min(BOOTSTRAP_SEED_DEPTH, ENHANCE_DEPTH))
      log_db.info(
        f"Empty tiles table — fast bootstrap seed to depth {seed_depth} "
        f"(target ceiling depth {ENHANCE_DEPTH})..."
      )
      seed_tiles(db, max_depth=seed_depth)
      tile_count = db.execute("SELECT COUNT(*) FROM tiles").fetchone()[0]
      log_db.info(f"Seeded {tile_count} tile skeletons at bootstrap depth {seed_depth}.")
    else:
      hm_count = db.execute("SELECT COUNT(*) FROM tiles WHERE heightmap IS NOT NULL").fetchone()[0]
      log_db.info(f"Tile grid already seeded: {tile_count} skeletons, {hm_count} populated with heightmaps")

    # Keep traversal ceiling metadata at full target depth, even if bootstrap
    # seeded fewer levels initially.
    cur_max = db.execute("SELECT value FROM metadata WHERE key = 'max_depth'").fetchone()
    if cur_max is None or int(cur_max[0]) < ENHANCE_DEPTH:
      db.execute("INSERT OR REPLACE INTO metadata (key, value) VALUES ('max_depth', ?)", (str(ENHANCE_DEPTH),))
      db.commit()
      log_db.info(f"Updated max_depth metadata to {ENHANCE_DEPTH}")

    try:
      no_data_count = load_no_data_cache(db)
    except Exception:
      no_data_count = 0

    db.close()

    _np = np
    _Image = Image
    _to_stereo = to_stereo
    _GRID_N = GRID_N
    _tile_bbox = terrain_tile_bbox
    _query_tiles_stereo = query_tiles_stereo
    _load_no_data_cache = load_no_data_cache
    _texture_ids_in = texture_ids_in
    _read_texture = read_texture
    _write_texture = write_texture
    _water_mask_ids_in = water_mask_ids_in
    _read_water_mask = read_water_mask
    _write_water_mask = write_water_mask
    _build_water_mask = build_water_mask
    _fetch_sentinel2_texture = fetch_sentinel2_texture
    _fetch_dataforsyningen_texture = fetch_dataforsyningen_texture
    _fetch_enhanced_texture = fetch_enhanced_texture
    _init_textures = init_textures
    _enqueue_seam_jobs = enqueue_tile_and_neighbors

    _backend_ready = True
    log.info(f"Terrain backend ready. DB={DB_PATH}")
    log_db.info(f"No-data cache: {no_data_count} tiles")
    _recover_comfy_jobs()

  except Exception as exc:  # pragma: no cover - runtime setup path
    _backend_error = (
      f"Terrain backend unavailable: {type(exc).__name__}: {exc}. "
      "Install dependencies into ./venv and ensure pipeline modules are present."
    )
    log.error(_backend_error)


def _queue_seam_jobs_for_tile(db: sqlite3.Connection, tile_id: str) -> None:
  if _enqueue_seam_jobs is None:
    return
  parsed = _parse_tile_id(tile_id)
  if parsed is None or parsed[0] != ENHANCE_DEPTH:
    return
  try:
    _enqueue_seam_jobs(db, tile_id, center_priority=120, neighbor_priority=80)
    log_tex.info(f"[SEAM] queued blend jobs for {tile_id} and neighbors")
  except Exception as exc:
    log_tex.warning(f"[SEAM] failed to queue jobs for {tile_id}: {type(exc).__name__}: {exc}")


def _update_water_mask_for_tile(
  db: sqlite3.Connection,
  tile_id: str,
  texture_jpeg: bytes,
  texture_source: str,
) -> None:
  ok, reason, coverage = _generate_water_mask_for_tile(
    db,
    tile_id,
    texture_jpeg,
    texture_source,
    allow_when_disabled=False,
  )
  if not ok and reason not in ("disabled",):
    log_tex.debug(f"[WATER MASK] {tile_id}: skipped ({reason})")
  if ok and coverage is not None:
    log_tex.debug(f"[WATER MASK] {tile_id}: cached coverage={coverage * 100:.1f}% source={texture_source}")


def _generate_water_mask_for_tile(
  db: sqlite3.Connection,
  tile_id: str,
  texture_jpeg: bytes,
  texture_source: str,
  *,
  allow_when_disabled: bool,
) -> tuple[bool, str, float | None]:
  if not allow_when_disabled and not ENABLE_WATER_MASKS:
    return False, "disabled", None
  if _build_water_mask is None or _write_water_mask is None:
    return False, "backend_unavailable", None
  tile_row = db.execute(
    "SELECT x_min, y_min, x_max, y_max, heightmap FROM tiles WHERE tile_id = ?",
    (tile_id,),
  ).fetchone()
  if tile_row is None:
    return False, "tile_missing", None
  hm_blob = tile_row[4]
  if hm_blob is None:
    return False, "heightmap_missing", None
  try:
    hm = _np.frombuffer(zlib.decompress(hm_blob), dtype=_np.float32).reshape((_GRID_N, _GRID_N))
  except Exception as exc:
    log_tex.warning(f"[WATER MASK] {tile_id}: failed to decode heightmap: {type(exc).__name__}: {exc}")
    return False, "heightmap_decode_failed", None

  bbox = (float(tile_row[0]), float(tile_row[1]), float(tile_row[2]), float(tile_row[3]))
  built = _build_water_mask(texture_jpeg, hm, bbox, resolution=256)
  if built is None:
    return False, "build_failed", None
  mask_png, coverage = built
  _write_water_mask(db, tile_id, mask_png, texture_source, coverage)
  return True, "ok", float(coverage)


def _terrain_unavailable_response(status: int = 503):
  _bootstrap_backend()
  if _backend_ready:
    return None
  return jsonify({"error": _backend_error or "Terrain backend unavailable"}), status



def _get_db() -> sqlite3.Connection:
  if "terrain_db" not in g:
    db = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    db.execute("PRAGMA journal_mode=WAL")
    if _init_textures is not None:
      _init_textures(db)
    g.terrain_db = db
  return g.terrain_db


@app.teardown_appcontext
def _close_db(exc):
  db = g.pop("terrain_db", None)
  if db is not None:
    db.close()



def _arg_float(name: str, default: float) -> float:
  raw = request.args.get(name)
  if raw is None:
    return default
  try:
    return float(raw)
  except (TypeError, ValueError):
    return default



def _arg_int(name: str, default: int) -> int:
  raw = request.args.get(name)
  if raw is None:
    return default
  try:
    return int(raw)
  except (TypeError, ValueError):
    return default



def _nearest_ancestor_texture(tile_id: str, texture_ids: set[str]) -> str | None:
  parts = tile_id.split("-")
  if len(parts) != 3:
    return None
  try:
    d, c, r = int(parts[0]), int(parts[1]), int(parts[2])
  except ValueError:
    return None
  while d > 0:
    d -= 1
    c //= 2
    r //= 2
    ancestor_id = f"{d}-{c}-{r}"
    if ancestor_id in texture_ids:
      return ancestor_id
  return None



def _texture_flags(
  tile_id: str,
  texture_ids: set[str],
  fetching_ids: set[str],
) -> dict[str, str | bool | None]:
  has_exact = tile_id in texture_ids
  ancestor_id = None if has_exact else _nearest_ancestor_texture(tile_id, texture_ids)
  has_any = has_exact or ancestor_id is not None
  is_fetching = tile_id in fetching_ids

  if has_exact:
    status = "ready"
  elif ancestor_id is not None:
    status = "ancestor_fallback"
  elif is_fetching:
    status = "fetching"
  else:
    status = "missing"

  return {
    "status": status,
    "has_texture": has_exact,
    "available": has_any,
    "is_placeholder": ancestor_id is not None,
    "ancestor_id": ancestor_id,
    "is_fetching": is_fetching,
  }



def _parse_tile_id(tile_id: str) -> tuple[int, int, int] | None:
  parts = tile_id.split("-")
  if len(parts) != 3:
    return None
  try:
    return int(parts[0]), int(parts[1]), int(parts[2])
  except ValueError:
    return None



def _tile_priority(bbox: list[float], qx: float, qy: float, fwd_x: float, fwd_y: float) -> float:
  tcx = (bbox[0] + bbox[2]) / 2
  tcy = (bbox[1] + bbox[3]) / 2
  dx, dy = tcx - qx, tcy - qy
  dist = math.sqrt(dx * dx + dy * dy)
  if dist <= 0:
    return 0.0
  dot = (dx * fwd_x + dy * fwd_y) / dist
  return dist / max(dot, 0.01)



def _queue_texture_fetch(tile_id: str, bbox: tuple[float, float, float, float]) -> None:
  with _tex_fetching_lock:
    if tile_id in _tex_fetching:
      return
    _tex_fetching.add(tile_id)

  def _worker() -> None:
    db = None
    try:
      db = sqlite3.connect(str(DB_PATH), check_same_thread=False)
      db.execute("PRAGMA journal_mode=WAL")
      if _init_textures is not None:
        _init_textures(db)
      # Skip if already cached with a real source. Only sentinel2_crop
      # is re-fetchable — everything else is considered final.
      # See texture.py docstring for the full upgrade chain.
      existing = db.execute(
        "SELECT source FROM textures WHERE tile_id = ?", (tile_id,)
      ).fetchone()
      if existing and existing[0] != "sentinel2_crop":
        log_tex.debug(f"[tex-worker] {tile_id}: already cached ({existing[0]}), skipping")
        return
      log_tex.debug(f"[tex-worker] {tile_id}: fetching texture bbox={bbox}")
      # Dataforsyningen is the PRIMARY source. Do not reorder this.
      # Sentinel-2 is ONLY a temporary placeholder — see upgrade chain.
      jpeg = _fetch_dataforsyningen_texture(list(bbox), resolution=256)
      if jpeg is not None:
        log_tex.debug(f"[tex-worker] {tile_id}: got {len(jpeg)} bytes from dataforsyningen, writing to DB")
        _write_texture(db, tile_id, jpeg, "dataforsyningen")
        _update_water_mask_for_tile(db, tile_id, jpeg, "dataforsyningen")
      else:
        # Dataforsyningen failed (rate limit / timeout / no coverage).
        # Don't write anything — the ancestor crop keeps showing and the
        # tile stays uncached so Dataforsyningen gets retried next request.
        # Writing sentinel2_crop here would cause a visible flash when the
        # real dataforsyningen texture arrives later.
        log_tex.debug(f"[tex-worker] {tile_id}: dataforsyningen failed, leaving uncached for retry")
    except Exception as exc:  # pragma: no cover - runtime fetch path
      log_tex.error(f"[tex-worker] {tile_id} FAILED: {type(exc).__name__}: {exc}")
    finally:
      if db is not None:
        db.close()
      with _tex_fetching_lock:
        _tex_fetching.discard(tile_id)

  _tex_pool.submit(_worker)


_api_tiles_state: dict[str, str | None] = {"last_result": None}

@app.get("/api/tiles")
def api_tiles():
  unavailable = _terrain_unavailable_response()
  if unavailable is not None:
    return unavailable

  error = _arg_float("error", 0.0005)
  max_depth = _arg_int("maxDepth", 13)
  max_range = _arg_float("range", 16000.0)

  if "sx" in request.args and "sy" in request.args:
    qx = _arg_float("sx", 0.0)
    qy = _arg_float("sy", 0.0)
  else:
    lat = _arg_float("lat", 64.175)
    lon = _arg_float("lon", -51.7388)
    qx, qy = _to_stereo(lat, lon)

  log.debug(f"[/api/tiles] qx={qx:.0f} qy={qy:.0f} error={error} maxDepth={max_depth} range={max_range:.0f} params={dict(request.args)}")

  ox = _arg_float("ox", qx)
  oy = _arg_float("oy", qy)
  alt = _arg_float("alt", 0.0)
  heading = _arg_float("heading", 0.0)

  try:
    tiles, missing = _query_tiles_stereo(
      _get_db(),
      qx,
      qy,
      error_threshold=error,
      max_depth=max_depth,
      max_range=max_range,
      altitude=alt,
      log=lambda msg: log.debug(f"[/api/tiles] {msg}"),
    )
  except Exception as exc:
    log.error(f"[/api/tiles] query FAILED: {type(exc).__name__}: {exc}")
    return jsonify({"error": f"tile query failed: {type(exc).__name__}: {exc}"}), 500

  _tiles_result_key = f"{len(tiles)}:{len(missing)}:{qx:.0f}:{qy:.0f}"
  if _api_tiles_state["last_result"] != _tiles_result_key:
    _api_tiles_state["last_result"] = _tiles_result_key
    log.info(f"[/api/tiles] result: {len(tiles)} tiles, {len(missing)} missing (qx={qx:.0f} qy={qy:.0f})")
  else:
    log.debug(f"[/api/tiles] result: {len(tiles)} tiles, {len(missing)} missing")

  all_tile_ids = [t["id"] for t in tiles if t["heightmap"] is not None]
  check_ids = set(all_tile_ids)
  for tid in all_tile_ids:
    d, c, r = _parse_tile_id(tid) or (0, 0, 0)
    while d > 0:
      d -= 1
      c //= 2
      r //= 2
      check_ids.add(f"{d}-{c}-{r}")

  texture_ids = _texture_ids_in(_get_db(), list(check_ids))
  water_mask_ids = _water_mask_ids_in(_get_db(), list(check_ids)) if _water_mask_ids_in else set()
  with _tex_fetching_lock:
    tex_fetching = list(_tex_fetching)
  tex_fetching_set = set(tex_fetching)

  fwd_x = math.sin(heading) if heading else 0.0
  fwd_y = math.cos(heading) if heading else 1.0

  tile_data = []
  tex_status_counts = {
    "ready": 0,
    "ancestor_fallback": 0,
    "fetching": 0,
    "missing": 0,
  }
  for tile in tiles:
    hm = tile["heightmap"]
    if hm is None:
      continue

    bbox = tile["bbox"]
    tid = tile["id"]
    priority = _tile_priority(bbox, qx, qy, fwd_x, fwd_y)
    tex_flags = _texture_flags(tid, texture_ids, tex_fetching_set)
    tex_status = str(tex_flags["status"])
    if tex_status in tex_status_counts:
      tex_status_counts[tex_status] += 1

    tile_data.append(
      {
        "id": tid,
        "bbox": [bbox[0] - ox, bbox[1] - oy, bbox[2] - ox, bbox[3] - oy],
        "depth": tile["depth"],
        "resolution": _GRID_N,
        "heightmap": base64.b64encode(hm.astype(_np.float32).tobytes()).decode("ascii"),
        "hasTexture": bool(tex_flags["has_texture"]),
        "texAvailable": bool(tex_flags["available"]),
        "texStatus": tex_status,
        "texIsPlaceholder": bool(tex_flags["is_placeholder"]),
        "texAncestorId": tex_flags["ancestor_id"],
        "texIsFetching": bool(tex_flags["is_fetching"]),
        "hasWaterMask": tid in water_mask_ids,
        "waterMaskUrl": f"/api/watermask/{tid}.png",
        "texPriority": math.log(max(priority, 1.0)),
      }
    )

  missing_data = []
  for tid, bbox in missing:
    priority = _tile_priority(list(bbox), qx, qy, fwd_x, fwd_y)
    missing_data.append(
      {
        "id": tid,
        "bbox": [bbox[0] - ox, bbox[1] - oy, bbox[2] - ox, bbox[3] - oy],
        "priority": priority,
      }
    )

  # Background COG fetch for missing heightmap tiles
  if missing and _cog_fetch_lock.acquire(blocking=False):
    def _bg_cog_fetch(missing_list):
      try:
        from concurrent.futures import ThreadPoolExecutor, as_completed
        from ingest import _read_cog_heightmap
        from database import CONFIDENCE, write_tile
        from serve import mark_no_data

        db = sqlite3.connect(str(DB_PATH), check_same_thread=False)
        db.execute("PRAGMA journal_mode=WAL")
        log_cog.info(f"Starting {len(missing_list)} tiles from S3...")

        def _worker(tile_id, bbox):
          log_cog.debug(f"[cog-worker] {tile_id}: reading bbox=[{bbox[0]:.0f},{bbox[1]:.0f},{bbox[2]:.0f},{bbox[3]:.0f}]")
          return tile_id, _read_cog_heightmap(bbox, _GRID_N)

        fetched, no_data_count = 0, 0
        with ThreadPoolExecutor(max_workers=6) as pool:
          futs = {pool.submit(_worker, tid, bbox): tid for tid, bbox in missing_list}
          for fut in as_completed(futs):
            tid = futs[fut]
            try:
              tile_id, (data, src_name) = fut.result()
              if data is None:
                mark_no_data(db, tile_id)
                no_data_count += 1
                continue
              cm = _np.where(_np.isnan(data), _np.uint8(0), _np.uint8(CONFIDENCE['arcticdem']))
              hm = _np.where(_np.isnan(data), 0.0, data).astype(_np.float32)
              write_tile(db, tile_id, hm, cm, src_name, reconcile=False)
              fetched += 1
            except Exception:
              mark_no_data(db, tid)
              no_data_count += 1
            finally:
              _cog_fetching_tiles.discard(tid)

        log_cog.info(f"Done: {fetched} fetched, {no_data_count} no data")
        db.close()
      finally:
        _cog_fetching_tiles.clear()
        _cog_fetch_lock.release()

    _cog_fetching_tiles.clear()
    for tid, _ in missing:
      _cog_fetching_tiles.add(tid)
    threading.Thread(target=_bg_cog_fetch, args=(missing,), daemon=True).start()

  downloading = list(_cog_fetching_tiles)

  return jsonify(
    {
      "tiles": tile_data,
      "missing": missing_data,
      "downloading": downloading,
      "qx": qx,
      "qy": qy,
      "ox": ox,
      "oy": oy,
      "texCached": len(texture_ids),
      "waterMaskCached": len(water_mask_ids),
      "texFetching": len(tex_fetching),
      "texQueued": len(tex_fetching),
      "texStatusCounts": tex_status_counts,
    }
  )


@app.get("/api/texture/<tile_id>.jpg")
def api_texture(tile_id: str):
  unavailable = _terrain_unavailable_response()
  if unavailable is not None:
    return unavailable

  log_tex.debug(f"[/api/texture] tile_id={tile_id}")

  db = _get_db()
  row = db.execute(
    "SELECT texture, source FROM textures WHERE tile_id = ?",
    (tile_id,),
  ).fetchone()

  cached_crop = None
  if row is not None:
    cached, source = row[0], row[1]
    log_tex.debug(f"[/api/texture] {tile_id}: cache HIT source={source} size={len(cached)} bytes")
    if source != "sentinel2_crop":
      return Response(
        cached,
        mimetype="image/jpeg",
        headers={
          "Cache-Control": "public, max-age=86400",
          "X-Tex-Source": source,
          "X-Tex-Status": "ready",
          "X-Tex-Quality": "full",
          "X-Tex-Temporary": "0",
        },
      )
    cached_crop = cached

  parsed = _parse_tile_id(tile_id)
  if parsed is None:
    log_tex.warning(f"[/api/texture] {tile_id}: invalid tile_id format")
    return Response(b"", status=400)
  d, c, r = parsed

  if row is None:
    log_tex.debug(f"[/api/texture] {tile_id}: cache MISS, queuing fetch (depth={d} col={c} row={r})")

  _queue_texture_fetch(tile_id, _tile_bbox(d, c, r))

  if cached_crop is not None:
    return Response(
      cached_crop,
      mimetype="image/jpeg",
      headers={
        "Cache-Control": "no-store",
        "X-Tex-Ancestor": "precomputed_crop",
        "X-Tex-Status": "ancestor_fallback",
        "X-Tex-Quality": "ancestor_crop",
        "X-Tex-Temporary": "1",
      },
    )

  child_d, child_c, child_r = d, c, r
  ancestor_found = None
  while d > 0:
    d -= 1
    c //= 2
    r //= 2
    ancestor_id = f"{d}-{c}-{r}"
    ancestor_tex = _read_texture(db, ancestor_id)
    if ancestor_tex is not None:
      ancestor_found = (ancestor_id, ancestor_tex)
      break

  if ancestor_found is None:
    log_tex.debug(f"[/api/texture] {tile_id}: no ancestor found, returning 202 (fetching)")
    return Response(
      b"",
      status=202,
      headers={"Cache-Control": "no-store", "X-Tex-Status": "fetching"},
    )

  ancestor_id, ancestor_tex = ancestor_found
  log_tex.debug(f"[/api/texture] {tile_id}: using ancestor {ancestor_id} ({len(ancestor_tex)} bytes)")
  img = _Image.open(io.BytesIO(ancestor_tex))
  w, h = img.size

  ancestor_depth = int(ancestor_id.split("-")[0])
  depth_diff = child_d - ancestor_depth
  sub_c = child_c % (1 << depth_diff)
  sub_r = child_r % (1 << depth_diff)
  n = 1 << depth_diff

  x0 = sub_c * w // n
  x1 = (sub_c + 1) * w // n
  y0 = (n - 1 - sub_r) * h // n
  y1 = (n - sub_r) * h // n

  cropped = img.crop((x0, y0, x1, y1)).resize((256, 256), _Image.Resampling.BILINEAR)
  buf = io.BytesIO()
  cropped.save(buf, format="JPEG", quality=85)

  return Response(
    buf.getvalue(),
    mimetype="image/jpeg",
    headers={
      "Cache-Control": "no-store",
      "X-Tex-Ancestor": ancestor_id,
      "X-Tex-Status": "ancestor_fallback",
      "X-Tex-Quality": "ancestor_crop",
      "X-Tex-Temporary": "1",
    },
  )


@app.post("/api/texture/<tile_id>/enhance")
def api_texture_enhance(tile_id: str):
  unavailable = _terrain_unavailable_response()
  if unavailable is not None:
    return unavailable

  # Parse optional prompt overrides from JSON body
  positive_prompt = None
  negative_prompt = None
  if request.is_json:
    body = request.get_json(silent=True) or {}
    positive_prompt = body.get("positive_prompt") or None
    negative_prompt = body.get("negative_prompt") or None

  db = _get_db()
  row = db.execute(
    "SELECT texture, source FROM textures WHERE tile_id = ?",
    (tile_id,),
  ).fetchone()
  if row is None:
    return Response(b"", status=404)

  existing_jpeg, source = row[0], row[1]
  # Already enhanced — return cached result
  if source in ("dataforsyningen_enhanced", "sentinel2_enhanced", "upscaled"):
    return Response(
      existing_jpeg,
      mimetype="image/jpeg",
      headers={
        "X-Tex-Source": source,
        "X-Tex-Status": "ready",
        "X-Tex-Quality": "full",
        "X-Tex-Temporary": "0",
      },
    )

  parsed = _parse_tile_id(tile_id)
  if parsed is None:
    return Response(b"", status=400)
  d, c, r = parsed

  # Only upscale target depth tiles
  if d != ENHANCE_DEPTH:
    log_tex.info(f"[ENHANCE] {tile_id}: rejected — depth {d} != target {ENHANCE_DEPTH}")
    return Response(b"", status=204, headers={"X-Tex-Status": "wrong_depth"})

  # Already in flight or queue full?
  with _enhancing_lock:
    if tile_id in _enhancing:
      return Response(
        b"",
        status=202,
        headers={"X-Tex-Status": "enhancing"},
      )
    if len(_enhancing) >= ENHANCE_MAX_QUEUED:
      return Response(
        b"",
        status=429,
        headers={"X-Tex-Status": "queue_full"},
      )

  if source != "dataforsyningen":
    log_tex.info(f"[ENHANCE] {tile_id}: rejected — source is '{source}', need 'dataforsyningen'")
    return Response(b"", status=204, headers={"X-Tex-Status": f"wrong_source_{source}"})

  bbox = _tile_bbox(d, c, r)

  # Fire off background upscale — return 202 immediately
  with _enhancing_lock:
    _enhancing.add(tile_id)

  def _enhance_worker():
    wdb = None
    try:
      wdb = sqlite3.connect(str(DB_PATH), check_same_thread=False)
      wdb.execute("PRAGMA journal_mode=WAL")
      if _init_textures is not None:
        _init_textures(wdb)
      enhanced, esrc = _fetch_enhanced_texture(
        list(bbox), resolution=256, s2_jpeg=existing_jpeg,
        tile_id=tile_id,
        positive_prompt=positive_prompt,
        negative_prompt=negative_prompt,
      )
      if enhanced is not None:
        _write_texture(wdb, tile_id, enhanced, esrc)
        _update_water_mask_for_tile(wdb, tile_id, enhanced, esrc)
        log_tex.info(f"[ENHANCE] {tile_id}: done, wrote {len(enhanced)} bytes as {esrc}")
      else:
        log_tex.warning(f"[ENHANCE] {tile_id}: upscaler returned None")
    except Exception as e:
      log_tex.error(f"[ENHANCE] {tile_id} failed: {type(e).__name__}: {e}")
    finally:
      if wdb is not None:
        wdb.close()
      with _enhancing_lock:
        _enhancing.discard(tile_id)

  _enhance_pool.submit(_enhance_worker)
  log_tex.info(f"[ENHANCE] {tile_id}: queued for background upscale")
  return Response(
    b"",
    status=202,
    headers={"X-Tex-Status": "enhancing"},
  )


@app.post("/api/texture/<tile_id>/discard_enhanced")
def api_texture_discard_enhanced(tile_id: str):
  """Discard an enhanced texture, its seam job, and re-queue neighbor seams."""
  unavailable = _terrain_unavailable_response()
  if unavailable is not None:
    return unavailable

  db = _get_db()
  row = db.execute(
    "SELECT source FROM textures WHERE tile_id = ?", (tile_id,)
  ).fetchone()
  if row is None:
    return jsonify({"error": "no texture found"}), 404

  source = row[0]
  if source not in ("dataforsyningen_enhanced", "sentinel2_enhanced", "upscaled"):
    return jsonify({"error": f"not enhanced (source={source})"}), 400

  db.execute("DELETE FROM textures WHERE tile_id = ?", (tile_id,))
  db.execute("DELETE FROM water_masks WHERE tile_id = ?", (tile_id,))
  db.commit()

  log_tex.info(f"[DISCARD] {tile_id}: discarded {source}")
  return jsonify({"ok": True, "discarded": source})


@app.get("/api/watermask/<tile_id>.png")
def api_watermask(tile_id: str):
  unavailable = _terrain_unavailable_response()
  if unavailable is not None:
    return unavailable

  db = _get_db()
  cached = _read_water_mask(db, tile_id)
  if cached is not None:
    mask_png, source, coverage = cached
    return Response(
      mask_png,
      mimetype="image/png",
      headers={
        "Cache-Control": "public, max-age=86400",
        "X-WaterMask-Source": source,
        "X-WaterMask-Coverage": f"{coverage:.4f}",
        "X-WaterMask-Status": "ready",
      },
    )
  if not ENABLE_WATER_MASKS:
    return Response(
      b"",
      status=204,
      headers={"Cache-Control": "no-store", "X-WaterMask-Status": "disabled"},
    )

  tex_row = db.execute(
    "SELECT texture, source FROM textures WHERE tile_id = ?",
    (tile_id,),
  ).fetchone()
  if tex_row is not None:
    texture_jpeg, texture_source = tex_row[0], str(tex_row[1])
    _update_water_mask_for_tile(db, tile_id, texture_jpeg, texture_source)
    cached = _read_water_mask(db, tile_id)
    if cached is not None:
      mask_png, source, coverage = cached
      return Response(
        mask_png,
        mimetype="image/png",
        headers={
          "Cache-Control": "public, max-age=86400",
          "X-WaterMask-Source": source,
          "X-WaterMask-Coverage": f"{coverage:.4f}",
          "X-WaterMask-Status": "ready",
        },
      )

  parsed = _parse_tile_id(tile_id)
  if parsed is None:
    return Response(b"", status=400)
  d, c, r = parsed
  _queue_texture_fetch(tile_id, _tile_bbox(d, c, r))
  return Response(
    b"",
    status=202,
    headers={"Cache-Control": "no-store", "X-WaterMask-Status": "fetching"},
  )


@app.post("/api/watermask/<tile_id>/generate")
def api_watermask_generate(tile_id: str):
  unavailable = _terrain_unavailable_response()
  if unavailable is not None:
    return unavailable

  db = _get_db()
  tex_row = db.execute(
    "SELECT texture, source FROM textures WHERE tile_id = ?",
    (tile_id,),
  ).fetchone()
  if tex_row is None:
    parsed = _parse_tile_id(tile_id)
    if parsed is None:
      return jsonify({"error": "bad tile id"}), 400
    d, c, r = parsed
    _queue_texture_fetch(tile_id, _tile_bbox(d, c, r))
    return jsonify({"ok": False, "status": "fetching_texture", "tileId": tile_id}), 202

  texture_jpeg, texture_source = tex_row[0], str(tex_row[1])
  ok, reason, coverage = _generate_water_mask_for_tile(
    db,
    tile_id,
    texture_jpeg,
    texture_source,
    allow_when_disabled=True,
  )
  if not ok:
    status = 409 if reason in ("tile_missing", "heightmap_missing") else 422
    return jsonify({"ok": False, "status": reason, "tileId": tile_id}), status

  return jsonify(
    {
      "ok": True,
      "status": "ready",
      "tileId": tile_id,
      "source": texture_source,
      "coverage": coverage,
      "waterMaskUrl": f"/api/watermask/{tile_id}.png",
    }
  )


@app.get("/api/enhance/status")
def api_enhance_status():
  unavailable = _terrain_unavailable_response()
  if unavailable is not None:
    return unavailable
  db = _get_db()
  # Check tiles table exists (may not if bootstrap is still running)
  has_tiles = db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='tiles'"
  ).fetchone()
  if not has_tiles:
    return jsonify({"error": "tiles table not ready yet"}), 503
  # Seeding progress at target depth (tile rows exist by design; this tracks DEM population).
  seed_total = db.execute(
    "SELECT COUNT(*) FROM tiles WHERE depth = ?",
    (ENHANCE_DEPTH,),
  ).fetchone()[0]
  seed_populated = db.execute(
    "SELECT COUNT(*) FROM tiles WHERE depth = ? AND source <> 'empty'",
    (ENHANCE_DEPTH,),
  ).fetchone()[0]
  seed_with_heightmap = db.execute(
    "SELECT COUNT(*) FROM tiles WHERE depth = ? AND heightmap IS NOT NULL",
    (ENHANCE_DEPTH,),
  ).fetchone()[0]
  seed_progress_pct = (
    round((float(seed_populated) * 100.0) / float(seed_total), 2)
    if seed_total > 0
    else 0.0
  )

  # Total target-depth tiles with heightmaps (eligible for enhance)
  total = db.execute(
    "SELECT COUNT(*) FROM tiles WHERE depth = ? AND heightmap IS NOT NULL",
    (ENHANCE_DEPTH,),
  ).fetchone()[0]
  # How many already have enhanced textures
  done = db.execute(
    """SELECT COUNT(*)
       FROM textures tx
       JOIN tiles t ON t.tile_id = tx.tile_id
       WHERE t.depth = ?
         AND tx.source IN ('dataforsyningen_enhanced', 'sentinel2_enhanced', 'upscaled')""",
    (ENHANCE_DEPTH,),
  ).fetchone()[0]
  # How many have base sentinel2 textures (could be enhanced)
  eligible = db.execute(
    """SELECT COUNT(*) FROM textures t
       JOIN tiles tl ON t.tile_id = tl.tile_id
       WHERE tl.depth = ? AND tl.heightmap IS NOT NULL
         AND t.source IN ('dataforsyningen', 'sentinel2')"""
    ,
    (ENHANCE_DEPTH,),
  ).fetchone()[0]
  with _enhancing_lock:
    in_progress = list(_enhancing)
  return jsonify({
    "total": total,
    "eligible": eligible,
    "done": done,
    "seed_total": seed_total,
    "seed_populated": seed_populated,
    "seed_with_heightmap": seed_with_heightmap,
    "seed_progress_pct": seed_progress_pct,
    "in_progress": len(in_progress),
    "in_progress_tiles": in_progress,
    "max_queued": ENHANCE_MAX_QUEUED,
  })


@app.get("/api/seam_status")
def api_seam_status():
  db = _get_db()
  has_table = db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='seam_jobs'"
  ).fetchone()
  if not has_table:
    return jsonify({"pending": [], "running": [], "done_recent": [], "failed": []})
  pending = [r[0] for r in db.execute(
    "SELECT tile_id FROM seam_jobs WHERE status = 'pending' ORDER BY priority DESC"
  ).fetchall()]
  running = [r[0] for r in db.execute(
    "SELECT tile_id FROM seam_jobs WHERE status = 'running'"
  ).fetchall()]
  # Recently finished (last 30 seconds) so the UI can flash them briefly
  done_recent = [r[0] for r in db.execute(
    "SELECT tile_id FROM seam_jobs WHERE status = 'done' AND updated_at > datetime('now', '-30 seconds')"
  ).fetchall()]
  failed = [r[0] for r in db.execute(
    "SELECT tile_id FROM seam_jobs WHERE status = 'failed'"
  ).fetchall()]
  return jsonify({
    "pending": pending,
    "running": running,
    "done_recent": done_recent,
    "failed": failed,
  })


@app.post("/api/seam_retry_failed")
def api_seam_retry_failed():
  from seam_queue import retry_failed
  db = _get_db()
  count = retry_failed(db)
  log.info(f"[SEAM] retried {count} failed jobs")
  return jsonify({"retried": count})


@app.post("/api/tile_inspect")
def api_tile_inspect():
  """Client clicked a tile in map mode — dump DB info."""
  unavailable = _terrain_unavailable_response()
  if unavailable is not None:
    return unavailable

  data = request.get_json(silent=True) or {}
  tid = data.get("tileId", "?")
  db = _get_db()
  row = db.execute(
    "SELECT source, updated_at, length(texture) FROM textures WHERE tile_id = ?",
    (tid,),
  ).fetchone()
  parsed = _parse_tile_id(tid)
  log_db.info(f"[INSPECT] {tid}")
  log_db.info(
    f"  client: tex={data.get('tex')} dim={data.get('texDim')} "
    f"color={data.get('color')} vc={data.get('vc')} po={data.get('po')} poFactor={data.get('poFactor')}"
  )

  # --- terrain tile info from tiles table ---
  if parsed:
    d, c, r = parsed
    tile_row = db.execute(
      "SELECT depth, x_min, y_min, x_max, y_max, geometric_error, source, "
      "updated_at, heightmap, confidence_map FROM tiles WHERE tile_id = ?",
      (tid,),
    ).fetchone()
    if tile_row:
      geo_err = tile_row[5]
      tile_src = tile_row[6]
      tile_updated = tile_row[7]
      hm_blob, cm_blob = tile_row[8], tile_row[9]
      bbox_db = [tile_row[1], tile_row[2], tile_row[3], tile_row[4]]
      tile_w = bbox_db[2] - bbox_db[0]
      tile_h = bbox_db[3] - bbox_db[1]
      log_db.info(f"  tile: source={tile_src} geo_err={geo_err:.2f}m depth={d} "
            f"size={tile_w:.0f}x{tile_h:.0f}m")
      log_db.info(f"  bbox: [{bbox_db[0]:.0f}, {bbox_db[1]:.0f}, {bbox_db[2]:.0f}, {bbox_db[3]:.0f}]")
      if hm_blob:
        try:
          import zlib
          hm = _np.frombuffer(zlib.decompress(hm_blob), dtype=_np.float32).reshape((_GRID_N, _GRID_N))
          log_db.info(f"  heightmap: min={hm.min():.1f}m max={hm.max():.1f}m "
                f"mean={hm.mean():.1f}m range={hm.max() - hm.min():.1f}m")
        except Exception as e:
          log_db.warning(f"  heightmap: error — {e}")
      else:
        log_db.info(f"  heightmap: NONE")

      # --- neighbor info ---
      neighbors = {}
      for label, nc, nr in [("N", c, r+1), ("S", c, r-1), ("E", c+1, r), ("W", c-1, r)]:
        if nc < 0 or nr < 0:
          continue
        nid = f"{d}-{nc}-{nr}"
        nr_row = db.execute(
          "SELECT source, heightmap IS NOT NULL FROM tiles WHERE tile_id = ?",
          (nid,),
        ).fetchone()
        if nr_row:
          neighbors[label] = f"{nr_row[0]}{'(hm)' if nr_row[1] else ''}"
        else:
          neighbors[label] = "missing"
      log_db.info(f"  neighbors: {neighbors}")
    else:
      log_db.warning(f"  tile: NOT IN tiles TABLE")

  # --- texture info from textures table ---
  if row:
    source, updated, size = row
    log_tex.info(f"  texture: source={source} updated={updated} size={size} bytes")
    try:
      tex_blob = db.execute(
        "SELECT texture FROM textures WHERE tile_id = ?", (tid,)
      ).fetchone()[0]
      img = _Image.open(io.BytesIO(tex_blob))
      arr = _np.array(img)
      zero_pct = _np.mean(arr.max(axis=2) == 0) * 100
      log_tex.info(
        f"  pixels: {img.size[0]}x{img.size[1]} min={arr.min()} max={arr.max()} "
        f"mean={arr.mean():.1f} zero={zero_pct:.1f}%"
      )
    except Exception as e:
      log_tex.warning(f"  pixels: error — {e}")
  else:
    log_tex.info(f"  texture: NOT IN DB")

  # --- texture ancestry ---
  if parsed and not row:
    ancestor = _nearest_ancestor_texture(tid, _texture_ids_in(db, [tid]))
    if ancestor:
      log_tex.info(f"  tex fallback: using ancestor {ancestor}")

  wm_row = db.execute(
    "SELECT source, coverage, length(mask_png), updated_at FROM water_masks WHERE tile_id = ?",
    (tid,),
  ).fetchone()
  if wm_row:
    wm_src, wm_cov, wm_size, wm_updated = wm_row
    log_tex.info(
      f"  water_mask: source={wm_src} coverage={float(wm_cov) * 100:.1f}% "
      f"size={wm_size} bytes updated={wm_updated}"
    )
  else:
    log_tex.info("  water_mask: NOT IN DB")

  hist = data.get("history", [])
  if hist:
    log_db.info(f"  history ({len(hist)} events):")
    for ev in hist:
      log_db.info(f"    {ev}")
  return jsonify({"ok": True})


def _client_log_level(raw_level: Any) -> int:
  if isinstance(raw_level, str):
    level = raw_level.strip().lower()
  else:
    level = ""
  return {
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warn": logging.WARNING,
    "warning": logging.WARNING,
    "error": logging.ERROR,
    "critical": logging.CRITICAL,
  }.get(level, logging.INFO)


@app.post("/api/client_log")
def api_client_log():
  data = request.get_json(silent=True) or {}
  raw_entries = data.get("entries")
  if isinstance(raw_entries, list):
    entries = raw_entries
  elif isinstance(data, dict):
    entries = [data]
  else:
    entries = []

  if not entries:
    return jsonify({"ok": True, "written": 0, "dropped": 0})

  # Keep each request bounded even if a client floods us.
  max_entries = 200
  incoming_count = len(entries)
  dropped = max(0, incoming_count - max_entries)
  written = 0

  scene_mode = data.get("sceneMode")

  for item in entries[:max_entries]:
    if not isinstance(item, dict):
      dropped += 1
      continue
    payload = {
      "ts": item.get("ts"),
      "sceneMode": item.get("sceneMode") or scene_mode,
      "phase": item.get("phase") or item.get("event"),
      "elapsedMs": item.get("elapsedMs"),
      "memory": item.get("memory"),
      "details": item.get("details"),
    }
    payload = {k: v for k, v in payload.items() if v is not None}
    if "phase" not in payload:
      payload["phase"] = "client.log"
    try:
      line = json.dumps(payload, ensure_ascii=False, default=str)
    except Exception:
      line = json.dumps(
        {"phase": payload.get("phase", "client.log"), "serializeError": True},
      )
    if len(line) > 20000:
      line = line[:20000] + "...<truncated>"
    _client_log.log(_client_log_level(item.get("level")), line)
    written += 1

  return jsonify(
    {
      "ok": True,
      "written": written,
      "dropped": dropped,
      "logPath": str(CLIENT_LOG_PATH),
    }
  )


@app.get("/api/health/terrain")
def terrain_health():
  unavailable = _terrain_unavailable_response(status=500)
  if unavailable is not None:
    return unavailable

  db_exists = DB_PATH.exists()
  try:
    row = _get_db().execute("SELECT COUNT(*) FROM tiles").fetchone()
    tile_rows = int(row[0]) if row else 0
  except Exception:
    tile_rows = 0

  return jsonify(
    {
      "ok": True,
      "dbPath": str(DB_PATH),
      "dbExists": db_exists,
      "tileRows": tile_rows,
    }
  )


@app.get("/")
def index():
  return send_from_directory(STATIC_DIR, "index.html")


@app.get("/<path:path>")
def static_files(path: str):
  if path.startswith("api/"):
    return Response(b"", status=404)
  candidate = DIST_DIR / path
  if candidate.is_file():
    return send_from_directory(STATIC_DIR, path)
  return send_from_directory(STATIC_DIR, "index.html")


if __name__ == "__main__":
  if not DIST_DIR.exists():
    raise SystemExit("dist/ not found. Run `npm run build` first.")
  logging.getLogger("werkzeug").setLevel(logging.WARNING)
  log.info(f"Serving static dist from: {DIST_DIR}")
  log.info(f"Terrain DB path: {DB_PATH}")
  log.info(f"Client debug log path: {CLIENT_LOG_PATH}")
  _bootstrap_backend()
  if not _backend_ready:
    raise SystemExit(f"Backend init failed: {_backend_error}")
  host = os.environ.get("FLASK_HOST", "127.0.0.1")
  port = int(os.environ.get("FLASK_PORT", "5180"))
  app.run(host=host, port=port, debug=False)
