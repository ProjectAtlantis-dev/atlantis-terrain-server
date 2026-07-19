from __future__ import annotations

import base64
import io
import json
import logging
import math
import os
import re
import socket
import sqlite3
import threading
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
from logging import FileHandler
from pathlib import Path
from typing import Any, cast

import asyncio

from colored_log import get_logger
from terrain_config import BOOTSTRAP_SEED_DEPTH, MAX_TILE_DEPTH

log = get_logger("terrain")
log_db = get_logger("terrain.db")
log_tex = get_logger("terrain.tex")
log_cog = get_logger("terrain.cog")

ROOT = Path(__file__).resolve().parent.parent

from flask import Flask, Response, g, jsonify, request, send_from_directory
DIST_DIR = ROOT / "webserver" / "dist"
STATIC_DIR = str(DIST_DIR)
CLIENT_LOG_HTML_PATH = ROOT / "webserver" / "client_log.html"

FLASK_DIR = Path(__file__).resolve().parent
LOCAL_DB_PATH = FLASK_DIR / "terrain.db"
CLIENT_LOG_PATH = FLASK_DIR / os.environ.get("CLIENT_LOG_FILE", "client_debug.log")
ASSETS_DB_PATH = Path(
  os.environ.get("ASSET_DB_PATH", ROOT / "assetserver" / "assets.db")
).expanduser().resolve()


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


def _require_available_port(host: str, port: int) -> None:
  """Abort startup before backend initialization when Flask cannot bind."""
  family = socket.AF_INET6 if ":" in host else socket.AF_INET
  try:
    with socket.socket(family, socket.SOCK_STREAM) as probe:
      probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
      probe.bind((host, port))
  except OSError as exc:
    raise SystemExit(
      f"Flask startup aborted: cannot bind to {host}:{port}: {exc}"
    ) from exc


# In-memory ring buffer of raw client log entries for the HTML viewer.
_client_log_ring = []        # list of dicts
_CLIENT_LOG_RING_MAX = 2000
_ws_clients: set = set()       # active async websocket connections
_ws_loop: asyncio.AbstractEventLoop | None = None  # set when ws server starts
_ws_queue: asyncio.Queue | None = None             # set when ws server starts

_client_log = logging.getLogger("terrain.client")
if not _client_log.handlers:
  CLIENT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
  _client_handler = FileHandler(
    str(CLIENT_LOG_PATH),
    mode="w",
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
    _KEY_COLOR = "\033[36m"    # cyan for JSON keys
    _STR_COLOR = "\033[33m"    # yellow for string values
    _NUM_COLOR = "\033[32m"    # green for numbers
    _BOOL_COLOR = "\033[35m"   # magenta for booleans/null
    # Regex to colorize JSON tokens in pretty-printed output
    _JSON_TOKEN_RE = re.compile(
      r'("(?:[^"\\]|\\.)*")\s*:'       # key followed by colon
      r'|("(?:[^"\\]|\\.)*")'          # string value
      r'|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)' # number
      r'|\b(true|false|null)\b'         # boolean/null
    )

    def _colorize_json(self, text):
      def _repl(m):
        if m.group(1) is not None:    # JSON key
          return f"{self._KEY_COLOR}{m.group(1)}{self._RESET}:"
        if m.group(2) is not None:    # string value
          return f"{self._STR_COLOR}{m.group(2)}{self._RESET}"
        if m.group(3) is not None:    # number
          return f"{self._NUM_COLOR}{m.group(3)}{self._RESET}"
        if m.group(4) is not None:    # bool/null
          return f"{self._BOOL_COLOR}{m.group(4)}{self._RESET}"
        return m.group(0)
      return self._JSON_TOKEN_RE.sub(_repl, text)

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
        pretty = self._colorize_json(pretty)
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
  _client_log.setLevel(logging.DEBUG)
  _client_log.propagate = False



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
_fetch_sentinel2_texture: Any = None
_fetch_dataforsyningen_texture: Any = None
_split_texture_metatile: Any = None
_harmonize_texture_metatile: Any = None
_init_textures: Any = None
_init_classifier_tiles: Any = None

_tex_pool = ThreadPoolExecutor(max_workers=4)
_tex_fetching: dict[str, tuple[str, int]] = {}
_tex_fetching_lock = threading.Lock()
_tex_demand_generations: dict[str, int] = {}
_tex_metatile_locks: dict[str, threading.Lock] = {}
_tex_metatile_locks_guard = threading.Lock()


def _texture_demand_is_stale(client_id: str, generation: int) -> bool:
  with _tex_fetching_lock:
    return generation < _tex_demand_generations.get(client_id, 0)


def _register_texture_demand(client_id: str, raw_generation: str | None) -> int:
  try:
    generation = int(raw_generation or 0)
  except (TypeError, ValueError):
    generation = 0
  with _tex_fetching_lock:
    if generation > _tex_demand_generations.get(client_id, 0):
      _tex_demand_generations[client_id] = generation
  return generation

# --- Texture retry queue (transient Dataforsyningen failures) ---
_TEX_RETRY_MAX = 3
_TEX_RETRY_DELAYS = [30, 60, 120]  # seconds between retries
_tex_retry_queue: list[tuple[str, tuple, int]] = []  # (tile_id, bbox, attempt)
_tex_retry_lock = threading.Lock()
_tex_retry_thread: threading.Thread | None = None


def _tex_retry_enqueue(tile_id: str, bbox: tuple, attempt: int = 0) -> None:
  with _tex_retry_lock:
    # Don't double-queue
    for tid, _, _ in _tex_retry_queue:
      if tid == tile_id:
        return
    _tex_retry_queue.append((tile_id, bbox, attempt))
    log_tex.debug(f"[tex-retry] enqueued {tile_id} attempt={attempt}")
  _ensure_tex_retry_thread()


def _ensure_tex_retry_thread() -> None:
  global _tex_retry_thread
  if _tex_retry_thread is not None and _tex_retry_thread.is_alive():
    return
  _tex_retry_thread = threading.Thread(target=_tex_retry_worker, daemon=True)
  _tex_retry_thread.start()


def _tex_retry_worker() -> None:
  """Background thread that retries rate-limited Dataforsyningen fetches."""
  while True:
    with _tex_retry_lock:
      if not _tex_retry_queue:
        return  # thread exits, will be restarted when new items enqueue
      tile_id, bbox, attempt = _tex_retry_queue.pop(0)

    delay = _TEX_RETRY_DELAYS[min(attempt, len(_TEX_RETRY_DELAYS) - 1)]
    log_tex.debug(f"[tex-retry] {tile_id}: waiting {delay}s (attempt {attempt + 1}/{_TEX_RETRY_MAX})")
    time.sleep(delay)

    db = None
    try:
      db = sqlite3.connect(str(DB_PATH), check_same_thread=False)
      db.execute("PRAGMA journal_mode=WAL")
      if _init_textures is not None:
        _init_textures(db)

      # Check tile hasn't been upgraded while we waited
      cur_row = db.execute(
        "SELECT source, texture FROM textures WHERE tile_id = ?", (tile_id,)
      ).fetchone()
      if cur_row and cur_row[0] not in _METATILE_UPGRADEABLE_SOURCES:
        log_tex.debug(f"[tex-retry] {tile_id}: already upgraded to {cur_row[0]}, skipping")
        continue

      metatile_id, _, _, _ = _texture_metatile_spec(tile_id)
      with _texture_metatile_lock(metatile_id):
        children, fail_reason = _fetch_texture_metatile(tile_id)
        if children is not None:
          written, no_coverage = _store_texture_metatile(db, children)
          if tile_id in written:
            log_tex.info(f"[tex-retry] {tile_id}: SUCCESS on attempt {attempt + 1}")
          elif tile_id in no_coverage:
            _resolve_no_coverage(db, tile_id, cur_row[1] if cur_row else None, "[tex-retry]")
        elif fail_reason == 'no_coverage':
          _resolve_no_coverage(db, tile_id, cur_row[1] if cur_row else None, "[tex-retry]")
        else:
          # Still transient
          if attempt + 1 < _TEX_RETRY_MAX:
            _tex_retry_enqueue(tile_id, bbox, attempt + 1)
            log_tex.debug(f"[tex-retry] {tile_id}: still transient, re-queued attempt {attempt + 2}")
          else:
            log_tex.warning(f"[tex-retry] {tile_id}: max retries exhausted")
            _resolve_no_coverage(db, tile_id, cur_row[1] if cur_row else None, "[tex-retry]")
    except Exception as exc:
      log_tex.error(f"[tex-retry] {tile_id}: FAILED: {type(exc).__name__}: {exc}")
    finally:
      if db is not None:
        db.close()


_cog_fetch_lock = threading.Lock()
_cog_fetching_tiles: set[str] = set()
_cog_fetched_total = 0      # lifetime count of COG tiles fetched from S3
_cog_skipped_total = 0      # lifetime count of tiles skipped (already had data)
_cog_already_fetched: set[str] = set()  # tile IDs we've already fetched this session
_COG_TILE_WORKERS = max(1, _env_int("COG_TILE_WORKERS", 6))

def _bootstrap_backend() -> None:
  global _backend_ready, _backend_error
  global _np, _Image, _to_stereo, _query_tiles_stereo, _load_no_data_cache
  global _GRID_N, _tile_bbox, _texture_ids_in, _read_texture, _write_texture
  global _fetch_sentinel2_texture, _fetch_dataforsyningen_texture, _split_texture_metatile
  global _harmonize_texture_metatile
  global _init_textures, _init_classifier_tiles

  if _backend_ready or _backend_error is not None:
    return

  try:
    import numpy as np  # type: ignore
    from PIL import Image  # type: ignore

    from coords import to_stereo
    from classifier.storage import init_classifier_tiles
    from database import GRID_N, _tile_bbox as terrain_tile_bbox, seed_tiles, open_db
    from serve import load_no_data_cache, query_tiles_stereo
    from texture import (
      fetch_dataforsyningen_texture,
      fetch_sentinel2_texture,
      harmonize_texture_metatile,
      init_textures,
      read_texture,
      split_texture_metatile,
      texture_ids_in,
      write_texture,
    )

    db = open_db(str(DB_PATH))

    tile_count = db.execute("SELECT COUNT(*) FROM tiles").fetchone()[0]
    if tile_count == 0:
      seed_depth = max(0, min(BOOTSTRAP_SEED_DEPTH, MAX_TILE_DEPTH))
      log_db.info(
        f"Empty tiles table — fast bootstrap seed to depth {seed_depth} "
        f"(target ceiling depth {MAX_TILE_DEPTH})..."
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
    if cur_max is None or int(cur_max[0]) < MAX_TILE_DEPTH:
      db.execute("INSERT OR REPLACE INTO metadata (key, value) VALUES ('max_depth', ?)", (str(MAX_TILE_DEPTH),))
      db.commit()
      log_db.info(f"Updated max_depth metadata to {MAX_TILE_DEPTH}")

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
    _fetch_sentinel2_texture = fetch_sentinel2_texture
    _fetch_dataforsyningen_texture = fetch_dataforsyningen_texture
    _split_texture_metatile = split_texture_metatile
    _harmonize_texture_metatile = harmonize_texture_metatile
    _init_textures = init_textures
    _init_classifier_tiles = init_classifier_tiles

    _backend_ready = True
    log.info(f"Terrain backend ready. DB={DB_PATH}")
    log_db.info(f"No-data cache: {no_data_count} tiles")

    import grundkort
    grundkort.ensure_grundkort_async()

    from ingest_coastline import ensure_gtk50_blocks
    threading.Thread(target=ensure_gtk50_blocks, daemon=True).start()

  except Exception as exc:  # pragma: no cover - runtime setup path
    _backend_error = (
      f"Terrain backend unavailable: {type(exc).__name__}: {exc}. "
      "Install dependencies into ./venv and ensure pipeline modules are present."
    )
    log.error(_backend_error)


def _terrain_unavailable_response(status: int = 503):
  _bootstrap_backend()
  if _backend_ready:
    return None
  return jsonify({"error": _backend_error or "Terrain backend unavailable"}), status



def _get_db() -> sqlite3.Connection:
  db = cast(sqlite3.Connection | None, g.get("terrain_db"))
  if db is None:
    db = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    db.execute("PRAGMA journal_mode=WAL")
    if _init_textures is not None:
      _init_textures(db)
    if _init_classifier_tiles is not None:
      _init_classifier_tiles(db)
    g.terrain_db = db
  return db


@app.teardown_appcontext
def _close_db(exc: BaseException | None) -> None:
  db = cast(sqlite3.Connection | None, g.pop("terrain_db", None))
  if db is not None:
    db.close()
  assets_db = cast(sqlite3.Connection | None, g.pop("assets_db", None))
  if assets_db is not None:
    assets_db.close()


def _get_assets_db() -> sqlite3.Connection:
  db = cast(sqlite3.Connection | None, g.get("assets_db"))
  if db is None:
    from asset_catalog import connect
    db = connect(ASSETS_DB_PATH)
    g.assets_db = db
  return db



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



OCEAN_MAX_ELEV_M = 0.5


def _is_ocean_tile(db, tile_id: str) -> bool:
  """True when the tile's heightmap is entirely at/below sea level.

  Tiles where both DEMs came up empty ('no_data') are open ocean too.
  Unknown (no row / no heightmap yet) → False; a later texture request
  re-checks once the heightmap has been ingested.
  """
  row = db.execute(
    "SELECT source, heightmap FROM tiles WHERE tile_id = ?", (tile_id,)
  ).fetchone()
  if row is None:
    return False
  source, hm_blob = row
  from coastline import read_water_mask
  official_water = read_water_mask(db, tile_id)
  if official_water is not None:
    return bool(_np.all(official_water))
  if source == 'no_data':
    return True
  if hm_blob is None:
    return False
  hm = _np.frombuffer(zlib.decompress(hm_blob), dtype=_np.float32)
  if _np.all(_np.isnan(hm)):
    return True
  return float(_np.nanmax(hm)) <= OCEAN_MAX_ELEV_M


def _repair_white_ocean_jpeg(db, tile_id: str, jpeg: bytes) -> bytes:
  """Fill WMS white no-data pixels over ocean (per heightmap) with OCEAN_RGB.

  Coastal frames arrive with real land + white sea fill and pass the
  whole-frame white check. No-op when the tile has no heightmap yet.
  """
  from texture import repair_white_ocean
  row = db.execute(
    "SELECT heightmap FROM tiles WHERE tile_id = ?", (tile_id,)
  ).fetchone()
  if not row or row[0] is None:
    return jpeg
  hm = _np.frombuffer(zlib.decompress(row[0]), dtype=_np.float32).reshape(_GRID_N, _GRID_N)
  from coastline import effective_heightmap
  hm = effective_heightmap(db, tile_id, hm)
  repaired = repair_white_ocean(jpeg, hm)
  if repaired is not None:
    log_tex.info(f"[tex-repair] {tile_id}: filled white ocean pixels with OCEAN_RGB")
    return repaired
  return jpeg


def _resolve_no_coverage(db, tile_id: str, existing_jpeg, log_prefix: str) -> None:
  """Terminal-state a tile Dataforsyningen has no imagery for.

  Ocean tiles get a flat deep-water texture. Land tiles keep their ancestor
  crop, stamped ancestor_crop_nodata. A white ancestor crop is poison (a
  pre-filter WMS no-data frame that got cached as imagery) — delete it so it
  can't keep getting served.
  """
  from texture import is_white_fill_jpeg, ocean_texture_jpeg

  if _is_ocean_tile(db, tile_id):
    _write_texture(db, tile_id, ocean_texture_jpeg(), "ocean_nodata")
    log_tex.info(f"{log_prefix} {tile_id}: no coverage + ocean heightmap → ocean_nodata")
  elif existing_jpeg and not is_white_fill_jpeg(existing_jpeg):
    _write_texture(db, tile_id, existing_jpeg, "ancestor_crop_nodata")
    log_tex.info(f"{log_prefix} {tile_id}: no coverage → ancestor_crop_nodata")
  elif existing_jpeg:
    db.execute("DELETE FROM textures WHERE tile_id = ?", (tile_id,))
    db.commit()
    log_tex.warning(f"{log_prefix} {tile_id}: no coverage, dropped white-fill ancestor crop")
  else:
    log_tex.info(f"{log_prefix} {tile_id}: no coverage, no fallback available yet")


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


def _crop_child_from_parent(parent_img, parent_depth, child_d, child_c, child_r):
  """Crop a single child tile's quadrant from a parent/ancestor image.

  Returns JPEG bytes.
  """
  w, h = parent_img.size
  depth_diff = child_d - parent_depth
  sub_c = child_c % (1 << depth_diff)
  sub_r = child_r % (1 << depth_diff)
  n = 1 << depth_diff

  x0 = sub_c * w // n
  x1 = (sub_c + 1) * w // n
  y0 = (n - 1 - sub_r) * h // n
  y1 = (n - sub_r) * h // n

  cropped = parent_img.crop((x0, y0, x1, y1)).resize((256, 256), _Image.Resampling.BILINEAR)
  buf = io.BytesIO()
  cropped.save(buf, format="JPEG", quality=85)
  return buf.getvalue()


def _seed_children_from_parent(db, parent_id: str) -> int:
  """Crop a parent texture into 4 child quadrants and write as ancestor_crop.

  Only writes children that have no texture yet. Returns count of children seeded.
  """
  parent_tex = _read_texture(db, parent_id)
  if parent_tex is None:
    return 0

  parsed = _parse_tile_id(parent_id)
  if parsed is None:
    return 0
  p_d, p_c, p_r = parsed

  parent_img = _Image.open(io.BytesIO(parent_tex))
  from texture import is_white_fill
  if is_white_fill(_np.asarray(parent_img.convert("RGB"), dtype=_np.uint8)):
    log_tex.warning(f"[tex-seed] {parent_id}: white-fill parent, refusing to seed children")
    return 0
  child_depth = p_d + 1
  seeded = 0

  for dc in range(2):
    for dr in range(2):
      child_c = p_c * 2 + dc
      child_r = p_r * 2 + dr
      child_id = f"{child_depth}-{child_c}-{child_r}"

      existing = db.execute(
        "SELECT source FROM textures WHERE tile_id = ?", (child_id,)
      ).fetchone()
      if existing:
        continue

      jpeg = _crop_child_from_parent(parent_img, p_d, child_depth, child_c, child_r)
      jpeg = _repair_white_ocean_jpeg(db, child_id, jpeg)
      _write_texture(db, child_id, jpeg, "ancestor_crop")
      seeded += 1

  if seeded:
    log_tex.debug(f"[tex-seed] {parent_id}: seeded {seeded}/4 children with ancestor_crop")
  return seeded



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



def _tile_priority(bbox: list[float], qx: float, qy: float,
                   fwd_x: float, fwd_y: float,
                   forward_scale: float = 2.0) -> float:
  tcx = (bbox[0] + bbox[2]) / 2
  tcy = (bbox[1] + bbox[3]) / 2
  dx, dy = tcx - qx, tcy - qy
  dist = math.sqrt(dx * dx + dy * dy)
  if dist <= 0:
    return 0.0
  along = dx * fwd_x + dy * fwd_y
  across = dx * fwd_y - dy * fwd_x
  scaled_along = along / max(1.0, forward_scale) if along > 0 else along
  priority_dist = math.hypot(across, scaled_along)
  dot = along / dist
  return priority_dist / max(dot, 0.01)


_METATILE_FINAL_SOURCE = "dataforsyningen_metatile4h2"
_METATILE_UPGRADEABLE_SOURCES = {
  "sentinel2_crop",
  "ancestor_crop",
  "ancestor_crop_ratelimit",
  "dataforsyningen",
  "dataforsyningen_metatile",
  "dataforsyningen_metatile4",
  "dataforsyningen_metatile4h",
}


def _texture_metatile_spec(tile_id: str) -> tuple[str, tuple, int, dict[str, tuple[int, int]]]:
  """Return aligned fetch information for the 4x4 group containing tile_id."""
  parsed = _parse_tile_id(tile_id)
  if parsed is None:
    raise ValueError(f"invalid tile id: {tile_id}")
  depth, column, row = parsed
  if depth == 0:
    return tile_id, tuple(_tile_bbox(depth, column, row)), 256, {tile_id: (0, 0)}

  depth_step = min(2, depth)
  grid_size = 1 << depth_step
  parent_depth = depth - depth_step
  parent_column = column // grid_size
  parent_row = row // grid_size
  metatile_id = f"{parent_depth}-{parent_column}-{parent_row}"
  children = {
    f"{depth}-{parent_column * grid_size + column_bit}-{parent_row * grid_size + row_bit}":
      (column_bit, row_bit)
    for column_bit in range(grid_size)
    for row_bit in range(grid_size)
  }
  return (
    metatile_id,
    tuple(_tile_bbox(parent_depth, parent_column, parent_row)),
    256 * grid_size,
    children,
  )


def _texture_metatile_lock(metatile_id: str) -> threading.Lock:
  with _tex_metatile_locks_guard:
    return _tex_metatile_locks.setdefault(metatile_id, threading.Lock())


def _fetch_texture_metatile(tile_id: str) -> tuple[dict[str, bytes] | None, str | None]:
  """Fetch and split one aligned metatile, without touching the database."""
  _, bbox, resolution, child_offsets = _texture_metatile_spec(tile_id)
  jpeg, fail_reason = _fetch_dataforsyningen_texture(
    list(bbox), resolution=resolution, lossless=resolution > 256
  )
  if jpeg is None:
    return None, fail_reason
  if resolution == 256:
    return {tile_id: jpeg}, None
  jpeg = _harmonize_texture_metatile(
    jpeg,
    child_resolution=256,
    grid_size=resolution // 256,
  )
  quadrants = _split_texture_metatile(
    jpeg,
    child_resolution=256,
    grid_size=resolution // 256,
  )
  return {
    child_id: quadrants[offset]
    for child_id, offset in child_offsets.items()
  }, None


def _store_texture_metatile(db, children: dict[str, bytes]) -> tuple[set[str], set[str]]:
  """Store valid metatile children without clobbering terminal/final states."""
  from texture import is_no_coverage_fill_jpeg

  written = set()
  no_coverage = set()
  for child_id, jpeg in children.items():
    if is_no_coverage_fill_jpeg(jpeg):
      no_coverage.add(child_id)
      continue
    existing = db.execute(
      "SELECT source FROM textures WHERE tile_id = ?", (child_id,)
    ).fetchone()
    if existing and existing[0] not in _METATILE_UPGRADEABLE_SOURCES:
      continue
    jpeg = _repair_white_ocean_jpeg(db, child_id, jpeg)
    _write_texture(db, child_id, jpeg, _METATILE_FINAL_SOURCE)
    written.add(child_id)
  return written, no_coverage



def _queue_texture_fetch(
  tile_id: str,
  bbox: tuple[float, float, float, float],
  demand_generation: int = 0,
  demand_client: str = "server",
) -> None:
  if demand_generation <= 0:
    with _tex_fetching_lock:
      demand_generation = _tex_demand_generations.get(demand_client, 0)
  with _tex_fetching_lock:
    existing_demand = _tex_fetching.get(tile_id)
    if existing_demand is not None:
      existing_client, existing_generation = existing_demand
      if existing_generation >= _tex_demand_generations.get(existing_client, 0):
        return
    _tex_fetching[tile_id] = (demand_client, demand_generation)

  _RE_FETCHABLE = _METATILE_UPGRADEABLE_SOURCES - {"ancestor_crop_ratelimit"}

  def _worker() -> None:
    db = None
    try:
      if _texture_demand_is_stale(demand_client, demand_generation):
        log_tex.debug(f"[tex-worker] {tile_id}: stale demand {demand_generation}, skipping")
        return
      db = sqlite3.connect(str(DB_PATH), check_same_thread=False)
      db.execute("PRAGMA journal_mode=WAL")
      if _init_textures is not None:
        _init_textures(db)

      # Skip if already in a non-refetchable state.
      existing = db.execute(
        "SELECT source FROM textures WHERE tile_id = ?", (tile_id,)
      ).fetchone()
      if existing and existing[0] not in _RE_FETCHABLE:
        log_tex.debug(f"[tex-worker] {tile_id}: already cached ({existing[0]}), skipping")
        return

      # Step 1: seed this tile + siblings from parent texture so all 4
      # children get an immediate ancestor_crop baseline.
      parsed = _parse_tile_id(tile_id)
      if parsed is not None:
        d, c, r = parsed
        if d > 0:
          parent_id = f"{d - 1}-{c // 2}-{r // 2}"
          _seed_children_from_parent(db, parent_id)

      # Step 2: fetch the aligned grandparent extent once and split all exact
      # children from the same reprojection. Concurrent sibling workers share
      # this lock and observe the first worker's writes instead of refetching.
      metatile_id, metatile_bbox, _, _ = _texture_metatile_spec(tile_id)
      with _texture_metatile_lock(metatile_id):
        existing = db.execute(
          "SELECT source FROM textures WHERE tile_id = ?", (tile_id,)
        ).fetchone()
        if existing and existing[0] == _METATILE_FINAL_SOURCE:
          log_tex.debug(f"[tex-worker] {tile_id}: metatile sibling already filled it")
          return

        log_tex.debug(
          f"[tex-worker] {tile_id}: fetching metatile {metatile_id} bbox={metatile_bbox}"
        )
        children, fail_reason = _fetch_texture_metatile(tile_id)
        if _texture_demand_is_stale(demand_client, demand_generation):
          log_tex.debug(f"[tex-worker] {tile_id}: demand changed during fetch, discarding")
          return
        if children is not None:
          written, no_coverage = _store_texture_metatile(db, children)
          log_tex.debug(
            f"[tex-worker] {tile_id}: metatile wrote {len(written)} children"
          )
          if tile_id in no_coverage:
            existing = db.execute(
              "SELECT texture FROM textures WHERE tile_id = ?", (tile_id,)
            ).fetchone()
            _resolve_no_coverage(
              db, tile_id, existing[0] if existing else None, "[tex-worker]"
            )
        elif fail_reason == 'no_coverage':
          # Permanent for the requested child. Sibling requests can still try
          # their group if provider coverage behavior changes at the boundary.
          existing = db.execute(
            "SELECT texture FROM textures WHERE tile_id = ?", (tile_id,)
          ).fetchone()
          _resolve_no_coverage(db, tile_id, existing[0] if existing else None, "[tex-worker]")
        else:
          # Transient (rate limit / timeout). Mark and enqueue for retry.
          existing = db.execute(
            "SELECT texture FROM textures WHERE tile_id = ?", (tile_id,)
          ).fetchone()
          if existing and existing[0]:
            _write_texture(db, tile_id, existing[0], "ancestor_crop_ratelimit")
          _tex_retry_enqueue(tile_id, bbox, attempt=0)
          log_tex.debug(
            f"[tex-worker] {tile_id}: transient → ancestor_crop_ratelimit, queued for retry"
          )
    except Exception as exc:  # pragma: no cover - runtime fetch path
      log_tex.error(f"[tex-worker] {tile_id} FAILED: {type(exc).__name__}: {exc}")
    finally:
      if db is not None:
        db.close()
      with _tex_fetching_lock:
        if _tex_fetching.get(tile_id) == (demand_client, demand_generation):
          _tex_fetching.pop(tile_id, None)

  _tex_pool.submit(_worker)


_api_tiles_state: dict[str, str | None] = {"last_result": None}
_terrain_lod_history: set[str] = set()
_last_camera: dict[str, float] | None = None  # last /api/tiles pose, feeds /api/heatmap
_BUILDING_QUERY_RANGE_M = 25000.0


def _buildings_for_tile_query(qx: float, qy: float, ox: float, oy: float):
  """Resolve scene buildings as part of the terrain-tile transaction."""
  from asset_catalog import color_buildings_from_textures, query_buildings

  buildings = query_buildings(
    _get_assets_db(), qx, qy, _BUILDING_QUERY_RANGE_M, ox, oy
  )
  color_buildings_from_textures(_get_db(), buildings, ox, oy)
  return buildings


@app.get("/api/tiles")
def api_tiles():
  unavailable = _terrain_unavailable_response()
  if unavailable is not None:
    return unavailable

  error = _arg_float("error", 0.0005)
  max_depth = min(_arg_int("maxDepth", MAX_TILE_DEPTH), MAX_TILE_DEPTH)
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
  # Preview passes flood closest-first; full passes fetch by view priority.
  preview = _arg_int("preview", 0) == 1
  has_heading = request.args.get("heading") is not None

  global _last_camera
  _last_camera = {"qx": qx, "qy": qy, "alt": alt, "heading": heading,
                  "maxDepth": max_depth, "range": max_range}

  try:
    tiles, missing = _query_tiles_stereo(
      _get_db(),
      qx,
      qy,
      error_threshold=error,
      max_depth=max_depth,
      max_range=max_range,
      altitude=alt,
      heading=heading if has_heading else None,
      preview=preview,
      lod_history=_terrain_lod_history,
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
  with _tex_fetching_lock:
    tex_fetching = list(_tex_fetching)
  tex_fetching_set = set(tex_fetching)

  # JS/vehicle convention: heading 0 points north and positive heading turns
  # toward west, hence east/X is -sin(heading).
  fwd_x = -math.sin(heading) if heading else 0.0
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
    # Dedup: skip tiles we've already fetched or attempted this session
    deduped = [(tid, bbox) for tid, bbox in missing if tid not in _cog_already_fetched]
    skipped = len(missing) - len(deduped)
    if skipped:
      log_cog.info(f"[COG dedup] {skipped} already fetched this session, {len(deduped)} new")
    if not deduped:
      _cog_fetch_lock.release()
    else:
      # Mark all as attempted before spawning thread
      for tid, _ in deduped:
        _cog_already_fetched.add(tid)

      def _bg_cog_fetch(missing_list):
        global _cog_fetched_total, _cog_skipped_total
        db = None
        try:
          from concurrent.futures import ThreadPoolExecutor, as_completed
          from ingest import _read_cog_heightmap, _resample_from_parent
          from database import CONFIDENCE, write_tile
          from serve import (
            mark_no_data, _UPGRADEABLE_SOURCES, _cache_coastline,
            _mark_official_ocean,
          )

          db = sqlite3.connect(str(DB_PATH), check_same_thread=False)
          db.execute("PRAGMA journal_mode=WAL")
          log_cog.info(f"Starting {len(missing_list)} tiles from S3... (session: {_cog_fetched_total} fetched, {_cog_skipped_total} skipped)")

          upgrade_ids = set()
          bbox_by_id = {tid: bbox for tid, bbox in missing_list}
          for tid, _ in missing_list:
            row = db.execute(
              "SELECT source FROM tiles WHERE tile_id = ?", (tid,)
            ).fetchone()
            if row and row[0] in _UPGRADEABLE_SOURCES:
              upgrade_ids.add(tid)

          def _worker(tile_id, bbox):
            log_cog.debug(f"[cog-worker] {tile_id}: reading bbox=[{bbox[0]:.0f},{bbox[1]:.0f},{bbox[2]:.0f},{bbox[3]:.0f}]")
            return tile_id, _read_cog_heightmap(bbox, _GRID_N)

          fetched, no_data_count, parent_resampled_count = 0, 0, 0
          # Collect tiles that COG couldn't resolve for a second-pass parent resample
          cog_failed = []
          with ThreadPoolExecutor(max_workers=_COG_TILE_WORKERS) as pool:
            futs = {pool.submit(_worker, tid, bbox): tid for tid, bbox in missing_list}
            for fut in as_completed(futs):
              tid = futs[fut]
              try:
                tile_id, (data, src_name) = fut.result()
                if data is None:
                  water = _cache_coastline(db, tile_id, bbox_by_id[tile_id])
                  if water is not None and _np.all(water):
                    _mark_official_ocean(db, tile_id)
                    fetched += 1
                    _cog_fetched_total += 1
                    continue
                  cog_failed.append(tile_id)
                  continue
                conf = CONFIDENCE.get(src_name, CONFIDENCE['arcticdem'])
                cm = _np.where(_np.isnan(data), _np.uint8(0), _np.uint8(conf))
                hm = _np.where(_np.isnan(data), 0.0, data).astype(_np.float32)
                write_tile(
                  db, tile_id, hm, cm, src_name, reconcile=False,
                  allow_overwrite=tile_id in upgrade_ids,
                )
                _cache_coastline(db, tile_id, bbox_by_id[tile_id])
                fetched += 1
                _cog_fetched_total += 1
              except Exception as exc:
                log_cog.warning(
                  f"  [COG FETCH] {tid}: failed after source read: "
                  f"{type(exc).__name__}: {exc}"
                )
                cog_failed.append(tid)
              finally:
                _cog_fetching_tiles.discard(tid)

          # Second pass: try parent resampling for tiles that had no COG data.
          # Sort by depth (shallowest first) so parent tiles get written before
          # their children try to resample from them — enables chaining
          # (depth-10 → depth-11 → depth-12 in one pass).
          cog_failed.sort(key=lambda tid: int(tid.split('-')[0]))
          for tile_id in cog_failed:
            try:
              data, src_name = _resample_from_parent(db, tile_id, bbox=None, resolution=_GRID_N)
              if data is not None:
                source_name = src_name if isinstance(src_name, str) else "parent_resampled"
                conf = CONFIDENCE.get(source_name, CONFIDENCE['arcticdem'])
                cm = _np.where(_np.isnan(data), _np.uint8(0), _np.uint8(conf))
                hm = _np.where(_np.isnan(data), 0.0, data).astype(_np.float32)
                from database import TileClobberError
                try:
                  write_tile(
                    db, tile_id, hm, cm, source_name, reconcile=False,
                    allow_overwrite=tile_id in upgrade_ids,
                  )
                  _cache_coastline(db, tile_id, bbox_by_id[tile_id])
                  parent_resampled_count += 1
                  _cog_fetched_total += 1
                  log_cog.info(f"  [PARENT RESAMPLE] {tile_id}: filled from parent")
                except TileClobberError:
                  # Already has data (e.g. from a previous request) — that's fine
                  parent_resampled_count += 1
                  _cog_skipped_total += 1
              else:
                mark_no_data(db, tile_id)
                no_data_count += 1
            except Exception as exc:
              log_cog.warning(f"  [PARENT RESAMPLE] {tile_id}: failed: {exc}")
              mark_no_data(db, tile_id)
              no_data_count += 1

          log_cog.info(f"Done: {fetched} fetched, {parent_resampled_count} parent-resampled, {no_data_count} no data (session totals: {_cog_fetched_total} fetched, {_cog_skipped_total} skipped)")
        finally:
          if db is not None:
            db.close()
          _cog_fetching_tiles.clear()
          _cog_fetch_lock.release()

      _cog_fetching_tiles.clear()
      for tid, _ in deduped:
        _cog_fetching_tiles.add(tid)
      threading.Thread(target=_bg_cog_fetch, args=(deduped,), daemon=True).start()

  downloading = list(_cog_fetching_tiles)

  try:
    buildings = _buildings_for_tile_query(qx, qy, ox, oy)
  except Exception as exc:
    # Terrain delivery remains usable if the optional asset catalog is being
    # rebuilt. Omit the field so the client preserves its current mesh.
    buildings = None
    log.warning(
      f"[/api/tiles] building query FAILED: {type(exc).__name__}: {exc}"
    )

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
      "texFetching": len(tex_fetching),
      "texQueued": len(tex_fetching),
      "texRetryQueue": len(_tex_retry_queue),
      "texStatusCounts": tex_status_counts,
      "buildings": buildings,
      "buildingCount": len(buildings) if buildings is not None else None,
    }
  )


@app.get("/api/assets")
def api_assets():
  """Viewer-facing startup assets, read by Flask from the shared catalog."""
  from asset_catalog import get_assets_response
  return jsonify(get_assets_response(_get_assets_db()))


@app.post("/api/vehicle_state")
def api_vehicle_state():
  """Persist vehicle state without exposing the asset service to the viewer."""
  from asset_catalog import save_vehicle_state
  payload, status = save_vehicle_state(_get_assets_db(), request.get_json(silent=True) or {})
  return jsonify(payload), status


@app.get("/api/roads")
def api_roads():
  """Compatibility endpoint; road rendering now comes from painted textures."""
  unavailable = _terrain_unavailable_response()
  if unavailable is not None:
    return unavailable
  if "sx" in request.args and "sy" in request.args:
    qx = _arg_float("sx", 0.0)
    qy = _arg_float("sy", 0.0)
  else:
    lat = _arg_float("lat", 64.175)
    lon = _arg_float("lon", -51.7388)
    qx, qy = _to_stereo(lat, lon)
  max_range = _arg_float("range", 20000.0)
  ox = _arg_float("ox", qx)
  oy = _arg_float("oy", qy)

  from asset_catalog import query_roads
  bbox = (qx - max_range, qy - max_range, qx + max_range, qy + max_range)
  rows = query_roads(_get_assets_db(), bbox)
  roads = [{
    **road,
    "path": [[x - ox, y - oy, z] for x, y, z in road["path"]],
  } for road in rows]
  log.debug(f"[/api/roads] {len(roads)} polylines near qx={qx:.0f} qy={qy:.0f} range={max_range:.0f}")
  return jsonify({"roads": roads, "count": len(roads), "qx": qx, "qy": qy})


def _painted_texture_response(
  jpeg: bytes,
  bbox: tuple[float, float, float, float],
  *,
  headers: dict[str, str],
  road_debug: bool = False,
) -> Response:
  """Apply terrain-coupled catalog overlays to a clean cached texture copy."""
  from asset_catalog import paint_roads
  painted, road_count = paint_roads(jpeg, bbox, ASSETS_DB_PATH, debug=road_debug)
  response_headers = dict(headers)
  response_headers["X-Road-Overlay-Count"] = str(road_count)
  response_headers["X-Road-Debug"] = "1" if road_debug else "0"
  if road_count:
    # Asset edits must be visible on the next texture request; the canonical
    # imagery remains cached in terrain.db and is never painted in place.
    response_headers["Cache-Control"] = "no-cache"
  return Response(painted, mimetype="image/jpeg", headers=response_headers)


@app.get("/api/texture/<tile_id>.jpg")
def api_texture(tile_id: str):
  unavailable = _terrain_unavailable_response()
  if unavailable is not None:
    return unavailable

  demand_client = request.args.get("demandClient") or "legacy"
  demand_generation = _register_texture_demand(demand_client, request.args.get("demand"))

  log_tex.debug(f"[/api/texture] tile_id={tile_id}")

  parsed = _parse_tile_id(tile_id)
  if parsed is None:
    log_tex.warning(f"[/api/texture] {tile_id}: invalid tile_id format")
    return Response(b"", status=400)
  d, c, r = parsed
  texture_bbox = _tile_bbox(d, c, r)
  road_debug = request.args.get("roadDebug") == "1"

  db = _get_db()
  row = db.execute(
    "SELECT texture, source FROM textures WHERE tile_id = ?",
    (tile_id,),
  ).fetchone()

  cached_crop = None
  # Sources that are temporary placeholders — serve them but let client re-fetch
  _TEX_TEMPORARY = {
    "sentinel2_crop",
    "ancestor_crop",
    "ancestor_crop_ratelimit",
    "dataforsyningen",  # legacy independent fetch; upgrade to aligned metatile
    "dataforsyningen_metatile",  # legacy 2x2 group; upgrade to aligned 4x4
    "dataforsyningen_metatile4",  # legacy 4x4 group without harmonization
    "dataforsyningen_metatile4h",  # legacy conservative harmonization
  }
  if row is not None:
    cached, source = row[0], row[1]
    log_tex.debug(f"[/api/texture] {tile_id}: cache HIT source={source} size={len(cached)} bytes")
    if source not in _TEX_TEMPORARY:
      is_crop = source == "ancestor_crop_nodata"
      return _painted_texture_response(
        cached,
        texture_bbox,
        road_debug=road_debug,
        headers={
          "Cache-Control": "public, max-age=86400" if not is_crop else "public, max-age=3600",
          "X-Tex-Source": source,
          "X-Tex-Status": "ready",
          "X-Tex-Quality": "ancestor_crop" if is_crop else "full",
          "X-Tex-Temporary": "0",
        },
      )
    cached_crop = cached

  if row is None:
    log_tex.debug(f"[/api/texture] {tile_id}: cache MISS, queuing fetch (depth={d} col={c} row={r})")

  # Queue a fetch for cache misses and re-fetchable sources.
  # Skip for ancestor_crop_ratelimit — the retry queue already handles those.
  source = row[1] if row else None
  if source != "ancestor_crop_ratelimit":
    _queue_texture_fetch(tile_id, _tile_bbox(d, c, r), demand_generation, demand_client)

  if cached_crop is not None:
    return _painted_texture_response(
      _repair_white_ocean_jpeg(db, tile_id, cached_crop),
      texture_bbox,
      road_debug=road_debug,
      headers={
        "Cache-Control": "no-store",
        "X-Tex-Ancestor": "precomputed_crop",
        "X-Tex-Status": "ancestor_fallback",
        "X-Tex-Quality": "ancestor_crop",
        "X-Tex-Temporary": "1",
        "X-Tex-Source": source or "",
      },
    )

  from texture import is_white_fill_jpeg
  child_d, child_c, child_r = d, c, r
  ancestor_found = None
  while d > 0:
    d -= 1
    c //= 2
    r //= 2
    ancestor_id = f"{d}-{c}-{r}"
    ancestor_tex = _read_texture(db, ancestor_id)
    if ancestor_tex is not None:
      # Skip poisoned white-fill ancestors (pre-filter WMS no-data frames) —
      # a 202 and the blue vertex fallback beat serving a white square.
      if is_white_fill_jpeg(ancestor_tex):
        continue
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

  return _painted_texture_response(
    _repair_white_ocean_jpeg(db, tile_id, buf.getvalue()),
    texture_bbox,
    road_debug=road_debug,
    headers={
      "Cache-Control": "no-store",
      "X-Tex-Ancestor": ancestor_id,
      "X-Tex-Status": "ancestor_fallback",
      "X-Tex-Quality": "ancestor_crop",
      "X-Tex-Temporary": "1",
    },
  )


def _heightmap_ancestor_crop(db, d: int, c: int, r: int, max_up: int = 4):
  """Tile heightmap, cropped out of the nearest ancestor's when the tile
  itself was never seeded/flown (pipeline.html can ask for any tile id; tile
  rows only exist where the frontend heatmap demanded them). Same philosophy
  as ancestor-crop textures. Returns (hm, source, depth_found) or
  (None, None, None); hm is (GRID_N, GRID_N), row 0 = south.
  """
  import numpy as np
  from PIL import Image as _Image

  from database import GRID_N, _decompress_float32

  bits = []
  dd, cc, rr = d, c, r
  for _ in range(max_up + 1):
    row = db.execute(
      "SELECT heightmap, source FROM tiles WHERE tile_id = ?",
      (f"{dd}-{cc}-{rr}",)).fetchone()
    if row is not None and row[0] is not None:
      hm = _decompress_float32(row[0], (GRID_N, GRID_N))
      half = (GRID_N - 1) // 2
      for cb, rb in reversed(bits):
        # row 0 = south: north child (rb=1) is the upper index half
        sub = hm[rb * half:rb * half + half + 1, cb * half:cb * half + half + 1]
        hm = np.array(_Image.fromarray(sub, mode="F")
                      .resize((GRID_N, GRID_N), _Image.Resampling.BILINEAR))
      return hm, row[1], dd
    if dd == 0:
      break
    bits.append((cc & 1, rr & 1))
    dd, cc, rr = dd - 1, cc >> 1, rr >> 1
  return None, None, None


@app.get("/api/channel/<tile_id>/<chan>.png")
def api_terrain_channel(tile_id: str, chan: str):
  """DEM-derived conditioning channel (elev/slope/southness/sun) as a debug
  PNG, computed on the fly from the tile heightmap and pixel-aligned with
  /api/texture. Southness renders diverging blue (north-
  facing) / red (south-facing). Query params: res (default 512).
  """
  if chan not in ("elev", "slope", "southness", "sun"):
    return Response(b"", status=400)
  parsed = _parse_tile_id(tile_id)
  if parsed is None:
    return Response(b"", status=400)
  d, c, r = parsed

  try:
    res = max(64, min(2048, int(request.args.get("res", "512"))))
  except ValueError:
    return Response(b"", status=400)

  import io as _io

  import numpy as np
  from PIL import Image as _Image

  from classifier.terrain_channels import render_channel, terrain_channels

  db = _get_db()
  hm, hm_source, hm_depth = _heightmap_ancestor_crop(db, d, c, r)
  if hm is None:
    return Response(b"", status=404, headers={"X-Tex-Status": "no_heightmap"})
  bbox = _tile_bbox(d, c, r)
  chans = terrain_channels(hm, bbox[2] - bbox[0])
  img = render_channel(chans, chan)
  # DB heightmaps are row 0 = south; flip to image orientation
  img = np.ascontiguousarray(img[::-1])
  img = np.array(_Image.fromarray(img).resize((res, res), _Image.Resampling.BILINEAR))
  buf = _io.BytesIO()
  _Image.fromarray(img).save(buf, format="PNG")
  return Response(
    buf.getvalue(),
    mimetype="image/png",
    headers={"Cache-Control": "no-store", "X-Tex-Source": f"channel_{chan}",
             "X-DEM-Depth": str(hm_depth), "X-DEM-Source": str(hm_source)},
  )


@app.get("/api/classifier/<tile_id>.png")
def api_classifier_tile(tile_id: str):
  """Colorized semantic labels for a terrain tile.

  The database stores raw uint8 labels. Exact rows are preferred; descendants
  can reuse the nearest classified ancestor through a nearest-neighbor crop so
  class boundaries and label identities are never blended.
  """
  unavailable = _terrain_unavailable_response()
  if unavailable is not None:
    return unavailable
  parsed = _parse_tile_id(tile_id)
  if parsed is None:
    return Response(b"", status=400)
  try:
    resolution = max(16, min(2048, int(request.args.get("res", "512"))))
  except ValueError:
    return Response(b"", status=400)

  import io as _io

  from PIL import Image as _Image
  from classifier.rendering import paint_navy_water_shadows, smooth_effective_water_mask
  from classifier.storage import colorize_class_map, decode_class_map
  from coastline import read_water_mask
  from texture import read_texture

  child_depth, child_col, child_row = parsed
  depth, col, row = parsed
  found = None
  db = _get_db()
  effective_water = read_water_mask(db, tile_id)
  water_source_row = db.execute(
    "SELECT source FROM coastline_masks WHERE tile_id = ?", (tile_id,)
  ).fetchone() if effective_water is not None else None
  while found is None:
    candidate_id = f"{depth}-{col}-{row}"
    found = db.execute(
      "SELECT class_schema, width, height, class_map, source "
      "FROM classifier_tiles WHERE tile_id = ?",
      (candidate_id,),
    ).fetchone()
    if found is None:
      if depth == 0:
        if effective_water is not None:
          break
        return Response(
          b"", status=404,
          headers={"Cache-Control": "no-store", "X-Classifier-Status": "missing"},
        )
      depth -= 1
      col //= 2
      row //= 2

  try:
    if found is None:
      class_schema, source = "effective_water_only", "coastline_masks"
      rgb = _np.full((resolution, resolution, 3), 42, dtype=_np.uint8)
    else:
      class_schema, width, height, class_blob, source = found
      labels = decode_class_map(class_blob, width, height)
      label_image = _Image.fromarray(labels, mode="L")
      if depth != child_depth:
        levels = child_depth - depth
        divisions = 1 << levels
        sub_col = child_col % divisions
        sub_row = child_row % divisions
        x0 = sub_col * width // divisions
        x1 = (sub_col + 1) * width // divisions
        # Class maps are image-oriented: row zero is north.
        y0 = (divisions - 1 - sub_row) * height // divisions
        y1 = (divisions - sub_row) * height // divisions
        label_image = label_image.crop((x0, y0, x1, y1))
      label_image = label_image.resize(
        (resolution, resolution), _Image.Resampling.NEAREST,
      )
      rgb = colorize_class_map(_np.asarray(label_image), class_schema)
    if effective_water is not None:
      # Reconstruct the terrain-grid boundary at the output resolution before
      # painting it. The midpoint threshold preserves a binary authoritative
      # mask while avoiding visibly enlarged 65x65 grid steps.
      render_water = smooth_effective_water_mask(
        effective_water, resolution, resolution,
      )
      rgb[render_water] = (255, 42, 161)
    satellite_jpeg = read_texture(db, tile_id)
    if satellite_jpeg is not None:
      satellite_rgb = _np.asarray(
        _Image.open(_io.BytesIO(satellite_jpeg)).convert("RGB").resize(
          (resolution, resolution), _Image.Resampling.BILINEAR,
        )
      )
      rgb, _ = paint_navy_water_shadows(rgb, satellite_rgb)
  except (TypeError, ValueError, zlib.error):
    return Response(
      b"", status=500,
      headers={"Cache-Control": "no-store", "X-Classifier-Status": "invalid"},
    )
  buf = _io.BytesIO()
  _Image.fromarray(rgb, mode="RGB").save(buf, format="PNG")
  headers = {
    "Cache-Control": "no-store",
    "X-Classifier-Status": "ready",
    "X-Classifier-Schema": str(class_schema),
    "X-Classifier-Source": str(source),
  }
  if effective_water is not None and water_source_row is not None:
    headers["X-Water-Mask-Source"] = str(water_source_row[0])
  if found is not None and depth != child_depth:
    headers["X-Classifier-Ancestor"] = f"{depth}-{col}-{row}"
  return Response(buf.getvalue(), mimetype="image/png", headers=headers)


@app.get("/api/heatmap")
def api_heatmap():
  """Quadtree grid and cached terrain diagnostics for the last /api/tiles
  camera. hasTexture marks tiles whose own texture is already cached (safe to
  pull /api/texture without triggering an upstream fetch)."""
  import numpy as np
  from database import CONFIDENCE, GRID_N, _decompress_uint8
  from tiles import build_lod_tree, get_leaves
  from serve import bbox_in_view_circle

  cam = _last_camera
  if cam is None:
    return jsonify(None)

  qx = _arg_float("qx", cam["qx"])
  qy = _arg_float("qy", cam["qy"])
  alt = _arg_float("alt", cam["alt"])
  heading = _arg_float("heading", cam["heading"])
  max_range = _arg_float("range", cam.get("range", 20000.0))
  # This is a diagnostic view of the terrain traversal, not a speculative
  # quadtree. Never advertise leaves deeper than the renderer can request.
  max_depth = min(
    _arg_int("maxDepth", int(cam["maxDepth"])),
    MAX_TILE_DEPTH,
  )
  lod_factor = _arg_float("lod", 2.0)

  root = build_lod_tree(qx, qy, max_depth=max_depth, lod_factor=lod_factor)
  # The heatmap visualizes the same local demand region as /api/tiles. Do not
  # expose the coarse leaves covering the rest of Greenland's root quadtree.
  leaves = [
    leaf for leaf in get_leaves(root)
    if bbox_in_view_circle(
      qx, qy,
      [leaf.center[0], leaf.center[1], leaf.center[0], leaf.center[1]],
      max_range,
    )
  ]

  fwd_x = -math.sin(heading) if heading else 0.0
  fwd_y = math.cos(heading) if heading else 1.0

  # Only count permanently cached textures — temporary placeholder sources
  # would make /api/texture queue an upstream re-fetch when the map page
  # pulls them (mirror of api_texture's _TEX_TEMPORARY).
  leaf_ids = [leaf.id for leaf in leaves]
  placeholders = ",".join("?" for _ in leaf_ids)
  texture_ids = {r[0] for r in _get_db().execute(
    f"SELECT tile_id FROM textures WHERE tile_id IN ({placeholders}) "
    "AND source NOT IN ('sentinel2_crop', 'ancestor_crop', 'ancestor_crop_ratelimit')",
    leaf_ids).fetchall()} if leaf_ids else set()
  terrain_rows = {r[0]: r[1:] for r in _get_db().execute(
    f"SELECT tile_id, source, geometric_error, heightmap IS NOT NULL, confidence_map "
    f"FROM tiles WHERE tile_id IN ({placeholders})",
    leaf_ids).fetchall()} if leaf_ids else {}
  confidence_names = {value: name for name, value in reversed(CONFIDENCE.items())}
  tiles = []
  for leaf in leaves:
    bbox = list(leaf.bbox)
    priority = _tile_priority(bbox, qx, qy, fwd_x, fwd_y)
    tile = {
      "id": leaf.id,
      "bbox": bbox,
      "depth": leaf.depth,
      "priority": math.log(max(priority, 1.0)),
      "hasTexture": leaf.id in texture_ids,
    }
    terrain_row = terrain_rows.get(leaf.id)
    if terrain_row is not None:
      source, geometric_error, has_heightmap, confidence_blob = terrain_row
      tile.update({
        "source": source,
        "geometricError": geometric_error,
        "hasHeightmap": bool(has_heightmap),
      })
      if confidence_blob:
        confidence_map = _decompress_uint8(confidence_blob, (GRID_N, GRID_N))
        values, counts = np.unique(confidence_map, return_counts=True)
        tile["confidence"] = {
          "min": int(values[0]),
          "max": int(values[-1]),
          "mean": round(float(confidence_map.mean()), 2),
          "levels": {
            confidence_names.get(int(value), str(int(value))): int(count)
            for value, count in zip(values, counts)
          },
        }
    tiles.append(tile)

  # Sort by priority (lowest = closest/hottest) and add render order index
  tiles.sort(key=lambda t: t["priority"])
  for i, t in enumerate(tiles):
    t["order"] = i

  return jsonify({
    "timestamp": time.time(),
    "camera": {
      "qx": qx, "qy": qy, "alt": alt, "heading": heading,
      "range": max_range,
    },
    "tiles": tiles,
  })


@app.get("/api/pipeline/at.json")
def api_pipeline_at():
  """Resolve lat/lon (e.g. the 3D camera position) to the deepest tile that
  has real progress (a texture), falling back to the deepest seeded tile —
  so the HUD's pipeline link lands on the tile under the camera."""
  try:
    lat = float(request.args["lat"])
    lon = float(request.args["lon"])
  except (KeyError, ValueError):
    return jsonify({"error": "lat and lon required"}), 400
  from coords import to_stereo
  x, y = to_stereo(lat, lon)
  db = _get_db()
  base = ("FROM tiles t {join} WHERE t.x_min <= ? AND t.x_max > ? "
          "AND t.y_min <= ? AND t.y_max > ? ORDER BY t.depth DESC LIMIT 1")
  args = (x, x, y, y)
  row = db.execute(
    "SELECT t.tile_id " + base.format(
      join="JOIN textures xt ON xt.tile_id = t.tile_id"), args).fetchone()
  if row is None:
    row = db.execute("SELECT t.tile_id " + base.format(join=""), args).fetchone()
  if row is None:
    return jsonify({"error": "no tile at this location"}), 404
  return jsonify({"tile": row[0]})


@app.get("/api/pipeline/<tile_id>.json")
def api_pipeline(tile_id: str):
  """Per-stage pipeline status for one tile — drives pipeline.html. Says what
  each stage has (and where it came from) without rendering anything."""
  if _parse_tile_id(tile_id) is None:
    return jsonify({"error": f"bad tile id: {tile_id!r}"}), 400
  db = _get_db()
  t = db.execute(
    "SELECT depth, x_min, y_min, x_max, y_max, heightmap IS NOT NULL, source, "
    "updated_at FROM tiles WHERE tile_id = ?", (tile_id,)).fetchone()
  if t is None:
    return jsonify({"error": "tile not in grid — never seeded"}), 404
  x = db.execute(
    "SELECT source, LENGTH(texture), updated_at FROM textures WHERE tile_id = ?",
    (tile_id,)).fetchone()
  return jsonify({
    "tile": tile_id,
    "depth": t[0],
    "bbox": list(t[1:5]),
    "size_m": round(t[3] - t[1], 1),
    "heightmap": {"ok": bool(t[5]), "source": t[6], "updated": t[7]},
    "texture": ({"ok": True, "source": x[0], "bytes": x[1], "updated": x[2]}
                if x else {"ok": False}),
  })


@app.get("/api/coverage/index.json")
def api_coverage_index():
  """Every tile with a REAL cached texture (placeholder crops excluded) —
  ?maxdepth caps the depth (default 12, the contract level); deeper tiles are
  detail, not coverage."""
  try:
    maxdepth = int(request.args.get("maxdepth", "12"))
  except ValueError:
    return jsonify({"error": "bad maxdepth"}), 400
  db = _get_db()
  tiles = [
    {"tile": tid, "bbox": [x0, y0, x1, y1], "depth": d}
    for tid, d, x0, y0, x1, y1 in db.execute(
      "SELECT t.tile_id, t.depth, t.x_min, t.y_min, t.x_max, t.y_max "
      "FROM textures x JOIN tiles t ON t.tile_id = x.tile_id "
      "WHERE t.depth <= ? AND x.source NOT IN "
      "('sentinel2_crop', 'ancestor_crop', 'ancestor_crop_ratelimit', "
      "'ancestor_crop_nodata') ORDER BY t.depth", (maxdepth,))
  ]
  return jsonify({"tiles": tiles})



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

  # --- auto-fix: reset terminal ancestor_crop states and re-queue ---
  if row and row[0] in ("ancestor_crop_nodata", "ancestor_crop_ratelimit", "ancestor_crop"):
    state = row[0]
    db.execute("DELETE FROM textures WHERE tile_id = ?", (tid,))
    db.commit()
    log_tex.warning(f"  AUTO-FIX: deleted {state}, re-queuing fetch")
    if parsed:
      d, c, r = parsed
      _queue_texture_fetch(tid, _tile_bbox(d, c, r))

  # --- texture ancestry ---
  if parsed and not row:
    ancestor = _nearest_ancestor_texture(tid, _texture_ids_in(db, [tid]))
    if ancestor:
      log_tex.info(f"  tex fallback: using ancestor {ancestor}")

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
    _client_log_ring.append(payload)
    if len(_client_log_ring) > _CLIENT_LOG_RING_MAX:
      del _client_log_ring[:len(_client_log_ring) - _CLIENT_LOG_RING_MAX]
    _broadcast_client_log(payload)
    written += 1

  return jsonify(
    {
      "ok": True,
      "written": written,
      "dropped": dropped,
      "logPath": str(CLIENT_LOG_PATH),
    }
  )


@app.get("/api/client_log/ring")
def api_client_log_ring():
  """Raw JSON dump of the ring buffer for debugging."""
  return jsonify({"count": len(_client_log_ring), "entries": _client_log_ring[-50:]})


def _broadcast_client_log(payload: dict) -> None:
  """Push a log entry to all connected websocket viewers (thread-safe)."""
  if _ws_loop is None or _ws_queue is None:
    return
  msg = json.dumps(payload, ensure_ascii=False, default=str)
  _ws_loop.call_soon_threadsafe(_ws_queue.put_nowait, msg)


async def _ws_broadcaster() -> None:
  """Async task that pulls from the queue and sends to all ws clients."""
  import websockets
  queue = _ws_queue
  if queue is None:
    return
  while True:
    msg = await queue.get()
    dead = set()
    for ws in list(_ws_clients):
      try:
        await ws.send(msg)
      except Exception:
        dead.add(ws)
    for ws in dead:
      _ws_clients.discard(ws)


async def _ws_handler(websocket) -> None:
  log.info(f"[WS] client connected, total={len(_ws_clients) + 1}")
  _ws_clients.add(websocket)
  try:
    await websocket.wait_closed()
  except Exception:
    pass
  finally:
    _ws_clients.discard(websocket)
    log.info(f"[WS] client disconnected, total={len(_ws_clients)}")


def _start_ws_server(host: str, port: int) -> None:
  """Run the async websocket server in a background thread."""
  import websockets

  global _ws_loop, _ws_queue

  async def _serve():
    global _ws_loop, _ws_queue
    _ws_loop = asyncio.get_running_loop()
    _ws_queue = asyncio.Queue()
    asyncio.create_task(_ws_broadcaster())
    async with websockets.serve(_ws_handler, host, port, compression=None):
      log.info(f"WebSocket server listening on ws://{host}:{port}")
      await asyncio.Future()  # run forever

  asyncio.run(_serve())


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


@app.get("/client_log.html")
def client_log_page():
  if CLIENT_LOG_HTML_PATH.is_file():
    response = send_from_directory(str(CLIENT_LOG_HTML_PATH.parent), CLIENT_LOG_HTML_PATH.name)
    response.headers["Cache-Control"] = "no-store"
    return response
  dist_candidate = DIST_DIR / "client_log.html"
  if dist_candidate.is_file():
    response = send_from_directory(STATIC_DIR, "client_log.html")
    response.headers["Cache-Control"] = "no-store"
    return response
  return Response("client_log.html not found", status=404, mimetype="text/plain")


@app.get("/")
def index():
  return send_from_directory(STATIC_DIR, "index.html")


@app.get("/coverage.html")
def retired_coverage_page():
  return Response(
    "Not found",
    status=404,
    mimetype="text/plain",
    headers={"Cache-Control": "no-store"},
  )


@app.get("/<path:path>")
def static_files(path: str):
  if path.startswith("api/"):
    return Response(b"", status=404)
  candidate = DIST_DIR / path
  if candidate.is_file():
    return send_from_directory(STATIC_DIR, path)
  return send_from_directory(STATIC_DIR, "index.html")


if __name__ == "__main__":
  logging.getLogger("werkzeug").setLevel(logging.WARNING)
  host = os.environ.get("FLASK_HOST", "127.0.0.1")
  port = int(os.environ.get("FLASK_PORT", "5180"))
  _require_available_port(host, port)
  if DIST_DIR.exists():
    log.info(f"Serving static dist from: {DIST_DIR}")
  else:
    log.info("No dist/ found — running API-only (use Vite dev server for frontend)")
  log.info(f"Terrain DB path: {DB_PATH}")
  log.info(f"Client debug log path: {CLIENT_LOG_PATH}")
  _bootstrap_backend()
  if not _backend_ready:
    raise SystemExit(f"Backend init failed: {_backend_error}")
  ws_port = int(os.environ.get("WS_PORT", "5181"))
  ws_thread = threading.Thread(target=_start_ws_server, args=(host, ws_port), daemon=True)
  ws_thread.start()
  app.run(host=host, port=port, debug=False)
