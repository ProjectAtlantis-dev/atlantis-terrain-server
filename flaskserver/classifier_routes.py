from __future__ import annotations

import io
import os
import re
import sqlite3
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from flask import Blueprint, Response, jsonify, request, send_from_directory

from classifier_job_control import classifier_inventory
from terrain_config import WMS_CONTRACT_DEPTH
from tile_address import parse_tile_id as _parse_tile_id


@dataclass(frozen=True)
class ClassifierRouteDependencies:
  get_db: Callable[[], sqlite3.Connection]
  terrain_unavailable_response: Callable[..., Any]
  numpy: Callable[[], Any]
  classifier_job_control: Callable[[], Any]
  classifier_training_control: Callable[[], Any]
  regression_case_summaries: Callable[[], list[dict]]
  assets_db_path: Callable[[], Path]
  texture_temporary_sources: set[str]
  ensure_d12_class_map: Callable[[sqlite3.Connection, str], None]
  logger: Any


classifier_bp = Blueprint("classifier", __name__)
_deps: ClassifierRouteDependencies | None = None
_TEX_TEMPORARY: set[str] = set()
log: Any = None


def configure_classifier_routes(deps: ClassifierRouteDependencies) -> None:
  global _deps, _TEX_TEMPORARY, log
  _deps = deps
  _TEX_TEMPORARY = deps.texture_temporary_sources
  log = deps.logger


def _deps_value() -> ClassifierRouteDependencies:
  if _deps is None:
    raise RuntimeError("classifier routes have not been configured")
  return _deps


def _get_db() -> sqlite3.Connection:
  return _deps_value().get_db()


def _terrain_unavailable_response(status: int = 503):
  return _deps_value().terrain_unavailable_response(status=status)


def regression_case_summaries():
  return _deps_value().regression_case_summaries()


class _DynamicProxy:
  def __init__(self, getter: Callable[[], Any]):
    self._getter = getter

  def __getattr__(self, name: str) -> Any:
    return getattr(self._getter(), name)


_np = _DynamicProxy(lambda: _deps_value().numpy())
_classifier_job_control = _DynamicProxy(
  lambda: _deps_value().classifier_job_control()
)
_classifier_training_control = _DynamicProxy(
  lambda: _deps_value().classifier_training_control()
)


# Presentation-only switch. Water labels and coastline masks remain stored and
# queryable; flip this back on when the pink diagnostic overlay is useful.
CLASSIFIER_PINK_WATER_ENABLED = False


def ensure_d12_class_map(db, tile_id: str) -> None:
  """Run trained-model D12 inference when a versioned artifact is available.

  Legacy ladder rows may still be read while the first dataset is labeled,
  but this path never creates or refreshes heuristic classifications.
  """
  parsed = _parse_tile_id(tile_id)
  if parsed is None or parsed[0] != WMS_CONTRACT_DEPTH:
    return
  from classifier.training import MODEL_PATH, predict_tile

  existing = db.execute(
    "SELECT source FROM classifier_tiles WHERE tile_id = ?", (tile_id,)
  ).fetchone()
  if existing:
    from classifier.vote_ladder import LADDER_SOURCE
    if str(existing[0]).startswith("model:") or str(existing[0]) == LADDER_SOURCE:
      return
  texture_row = db.execute(
    "SELECT texture, source FROM textures WHERE tile_id = ?", (tile_id,)
  ).fetchone()
  if (
    texture_row is None or texture_row[0] is None
    or texture_row[1] in _TEX_TEMPORARY
  ):
    return
  if not MODEL_PATH.exists():
    return
  try:
    result = predict_tile(db, tile_id)
    log.info(
      f"[classifier] {tile_id}: trained model classification stored "
      f"({result['regions']} regions, confidence "
      f"{result['meanConfidence']:.1%})"
    )
  except Exception as exc:
    log.warning(
      f"[classifier] {tile_id}: trained model inference failed "
      f"({type(exc).__name__}: {exc})"
    )


@classifier_bp.get("/api/classifier/<tile_id>.png")
def api_classifier_tile(tile_id: str):
  """Colorized semantic labels for a terrain tile.

  The database stores raw uint8 labels. Exact rows are preferred; descendants
  can reuse the nearest classified ancestor through a nearest-neighbor crop so
  class boundaries and label identities are never blended.

  With ``?raw=1`` the response is a surface-channel mask for the renderer's
  detail materials instead of the colorized debug view: uint8 channels
  R=rock (grey=255, dark=128, sand=64, shore-rock=192), G=vegetation,
  B=snow; water/lake are exact black and shadow uses the invisible marker
  R=1. These values let the client recover exact CPU fields while the GPU
  still filters meaningful surface weights linearly across boundaries.
  """
  unavailable = _terrain_unavailable_response()
  if unavailable is not None:
    return unavailable
  parsed = _parse_tile_id(tile_id)
  if parsed is None:
    return Response(b"", status=400)
  raw_mask = request.args.get("raw") == "1"
  try:
    resolution = max(16, min(2048, int(request.args.get("res", "512"))))
  except ValueError:
    return Response(b"", status=400)

  import io as _io

  from PIL import Image as _Image
  from classifier.rendering import smooth_effective_water_mask
  from classifier.storage import colorize_class_map, decode_class_map
  from coastline import read_water_mask
  from database import _tile_bbox as terrain_tile_bbox

  child_depth, child_col, child_row = parsed
  child_bbox_values = terrain_tile_bbox(child_depth, child_col, child_row)
  child_bbox = (
    float(child_bbox_values[0]),
    float(child_bbox_values[1]),
    float(child_bbox_values[2]),
    float(child_bbox_values[3]),
  )
  depth, col, row = parsed
  found = None
  db = _get_db()
  if child_depth >= WMS_CONTRACT_DEPTH:
    # Contract-depth ground classifies itself on first demand, so surface
    # masks exist everywhere walkable without waiting for deep cooks.
    shift = child_depth - WMS_CONTRACT_DEPTH
    _deps_value().ensure_d12_class_map(
      db,
      f"{WMS_CONTRACT_DEPTH}-{child_col >> shift}-{child_row >> shift}",
    )
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
        # 204, not 404: never-classified ground is a normal state, not an
        # error, and the browser writes a console line for every 404 it sees.
        # One per newly visible tile floods the console while flying, and
        # that logging is itself a main-thread stall.
        return Response(
          b"", status=204,
          headers={"Cache-Control": "no-store", "X-Classifier-Status": "missing"},
        )
      depth -= 1
      col //= 2
      row //= 2

  try:
    label_array = None
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
      label_array = _np.asarray(label_image)
      rgb = colorize_class_map(
        label_array, class_schema,
        highlight_water=CLASSIFIER_PINK_WATER_ENABLED,
      )
    if raw_mask:
      # coarse_v1 indices: grey 0, green 1, dark 2, white 3, water 4.
      # RGB only — NOT RGBA. An alpha channel here previously carried DARK,
      # but the client decodes via a 2D canvas drawImage/getImageData round
      # trip, which premultiplies alpha by default: wherever alpha (dark)
      # was 0, the browser zeroed R/G/B too, corrupting rock/veg/snow
      # everywhere except on dark patches ("only rocks on black patches").
      # DARK now lives inside R itself as a distinct value: grey (light
      # rock) = 255, dark = 128, neither = 0. Consumers that only care
      # "is this rock at all" (R > 0, e.g. the ground-detail shader) are
      # unaffected; consumers that need light-vs-dark test the exact value.
      # coarse_v2 adds SHADOW (5). It gets the near-black RGB marker
      # (1, 0, 0), visually and materially indistinguishable from black,
      # but enough for CPU consumers to distinguish unknown shadow from
      # exact black WATER/LAKE. (Previously shadow-dark pixels were DARK,
      # which scatter reads as "something grows here" — bushes in terrain
      # shadows.)
      mask = _np.zeros((resolution, resolution, 3), dtype=_np.uint8)
      if label_array is not None and class_schema in (
        "coarse_v1", "coarse_v2", "coarse_v3", "coarse_v4",
      ):
        mask[..., 0] = _np.select(
          [label_array == 0, label_array == 2], [255, 128], default=0,
        )
        mask[..., 1] = _np.where(label_array == 1, 255, 0)
        mask[..., 2] = _np.where(label_array == 3, 255, 0)
        if class_schema in ("coarse_v2", "coarse_v3", "coarse_v4"):
          mask[..., 0] = _np.where(label_array == 5, 1, mask[..., 0])
        if class_schema == "coarse_v3":
          # BEACH (7): a distinct CPU marker and a subtle 25% rock-detail
          # weight in the shared RGB texture. It is never vegetation.
          mask[..., 0] = _np.where(label_array == 7, 64, mask[..., 0])
        elif class_schema == "coarse_v4":
          # SAND (7) and SHORE_ROCK (8) are both no-growth shoreline.
          # Their distinct weights let the GPU alternate weak sand grain
          # with strong exposed-rock grain without another texture fetch.
          mask[..., 0] = _np.where(label_array == 7, 64, mask[..., 0])
          mask[..., 0] = _np.where(label_array == 8, 192, mask[..., 0])
      # Roads and paths are a derived land-use overlay, not a replacement
      # semantic class. Reserve (2,0,0) as the road corridor marker: it is
      # materially blank to the detail shaders and separately decoded by
      # scatter so no vegetation or rocks can cover the baked surface.
      from asset_catalog import road_corridor_mask
      road_coverage, road_count = road_corridor_mask(
        child_bbox, resolution, resolution, _deps_value().assets_db_path(),
      )
      road_pixels = _np.asarray(road_coverage) > 8
      mask[road_pixels] = (2, 0, 0)
      if effective_water is not None:
        mask[
          smooth_effective_water_mask(effective_water, resolution, resolution)
        ] = 0
      buf = _io.BytesIO()
      _Image.fromarray(mask, mode="RGB").save(buf, format="PNG")
      # "pending" (no real classifier row anywhere in the ancestor chain,
      # this is the all-black water-only fallback) MUST be distinguished
      # from "ready" (a real classification, even an inherited coarse one):
      # the client's surface-field store caches every 200 permanently, and
      # a d12 tile is routinely still mid-fetch/mid-cook on its first
      # request. Caching that transient blank as if it were final left
      # most of the map permanently grass-less — the client now treats
      # "pending" as retryable instead of caching it.
      classifier_status = "ready" if found is not None else "pending"
      # "pending" must stay no-store (it's a transient blank, retried on
      # purpose). "ready" is safe to actually cache in the browser: with
      # per-depth classifier rows removed (deep tiles now walk the
      # ancestor chain every request — several sequential DB queries
      # instead of one direct lookup), repeat requests for the same tile
      # got measurably more expensive right as every response was also
      # marked no-store, forcing that walk to redo on every single
      # request. A real classification changing is rare and already event-
      # driven elsewhere; a few minutes of staleness is a fine trade for
      # not repeating a multi-level DB walk + PNG encode every frame.
      cache_control = (
        "no-cache" if road_count
        else ("public, max-age=300" if classifier_status == "ready" else "no-store")
      )
      return Response(
        buf.getvalue(), mimetype="image/png",
        headers={
          "Cache-Control": cache_control,
          "X-Classifier-Status": classifier_status,
          "X-Classifier-Schema": str(class_schema),
          "X-Classifier-Source": str(source),
          "X-Classifier-Mask": "surface_rgb_v5",
          "X-Road-Overlay-Count": str(road_count),
        },
      )
    if effective_water is not None:
      # Reconstruct the terrain-grid boundary at the output resolution before
      # painting it. The midpoint threshold preserves a binary authoritative
      # mask while avoiding visibly enlarged 65x65 grid steps.
      render_water = smooth_effective_water_mask(
        effective_water, resolution, resolution,
      )
      # Keep the authoritative water mask and the original pink highlight
      # available, but present water neutrally while the highlight is disabled.
      rgb[render_water] = (
        (255, 42, 161) if CLASSIFIER_PINK_WATER_ENABLED else (42, 42, 42)
      )
    # Make the same corridor visible in the classifier debug view. This uses
    # the classifier color below each segment as its local tint, while the raw
    # response above carries the authoritative no-scatter marker.
    from asset_catalog import paint_roads_image
    road_image, road_count = paint_roads_image(
      _Image.fromarray(rgb, mode="RGB"),
      child_bbox,
      _deps_value().assets_db_path(),
    )
    rgb = _np.asarray(road_image).copy()
  except (TypeError, ValueError, zlib.error):
    return Response(
      b"", status=500,
      headers={"Cache-Control": "no-store", "X-Classifier-Status": "invalid"},
    )
  buf = _io.BytesIO()
  _Image.fromarray(rgb, mode="RGB").save(buf, format="PNG")
  debug_status = "ready" if found is not None else "pending"
  headers = {
    "Cache-Control": (
      "no-cache" if road_count
      else ("public, max-age=300" if debug_status == "ready" else "no-store")
    ),
    "X-Classifier-Status": debug_status,
    "X-Classifier-Schema": str(class_schema),
    "X-Classifier-Source": str(source),
    "X-Classifier-Pink-Water": (
      "enabled" if CLASSIFIER_PINK_WATER_ENABLED else "disabled"
    ),
    "X-Road-Overlay-Count": str(road_count),
  }
  if effective_water is not None and water_source_row is not None:
    headers["X-Water-Mask-Source"] = str(water_source_row[0])
  if found is not None and depth != child_depth:
    headers["X-Classifier-Ancestor"] = f"{depth}-{col}-{row}"
  return Response(buf.getvalue(), mimetype="image/png", headers=headers)


def _classifier_ready_tile_ids(db: sqlite3.Connection) -> list[str]:
  return [
    str(row[0]) for row in db.execute(
      "SELECT x.tile_id FROM textures x "
      "JOIN tiles t ON t.tile_id=x.tile_id "
      "WHERE x.tile_id LIKE '12-%' "
      "AND x.source NOT LIKE '%procedural%' "
      "AND x.source NOT IN ('ancestor_crop', 'placeholder') "
      "AND t.heightmap IS NOT NULL "
      "ORDER BY x.tile_id"
    )
  ]


def _classifier_requested_tiles(
  db: sqlite3.Connection,
  payload: dict[str, Any],
) -> tuple[str, list[str]]:
  scope = str(payload.get("scope", "selected"))
  if scope == "ready":
    return scope, _classifier_ready_tile_ids(db)
  if scope == "regressions":
    import regression_cases

    return scope, [
      str(case.get("tile", "")) for case in regression_cases.load_cases()
      if _parse_tile_id(str(case.get("tile", ""))) is not None
    ]
  if scope != "selected":
    raise ValueError("scope must be selected, regressions, or ready")

  raw_tiles = payload.get("tiles", [])
  if isinstance(raw_tiles, str):
    candidates = re.split(r"[\s,]+", raw_tiles.strip())
  elif isinstance(raw_tiles, list):
    candidates = [str(value).strip() for value in raw_tiles]
  else:
    raise ValueError("tiles must be a list or whitespace-separated string")
  tiles = [tile for tile in candidates if tile]
  invalid = [
    tile for tile in tiles
    if (parsed := _parse_tile_id(tile)) is None
    or not 8 <= parsed[0] <= WMS_CONTRACT_DEPTH
  ]
  if invalid:
    raise ValueError(
      f"selected jobs require D8-D{WMS_CONTRACT_DEPTH} tile ids; invalid: "
      + ", ".join(invalid[:5])
    )
  return scope, list(dict.fromkeys(tiles))


@classifier_bp.get("/api/classifier/jobs")
def api_classifier_jobs_status():
  """Operations-page snapshot: job progress, coverage, regression cases."""
  unavailable = _terrain_unavailable_response()
  if unavailable is not None:
    return unavailable
  payload = {
    "job": _classifier_job_control.snapshot(),
    "inventory": classifier_inventory(_get_db()),
    "regressions": regression_case_summaries(),
    "links": {
      "verificationGallery": "/api/classifier/verification/",
      "regressionGallery": "/api/regression/",
    },
  }
  response = jsonify(payload)
  response.headers["Cache-Control"] = "no-store"
  return response


@classifier_bp.post("/api/classifier/jobs")
def api_classifier_jobs_start():
  """Launch one asynchronous classifier verification job."""
  unavailable = _terrain_unavailable_response()
  if unavailable is not None:
    return unavailable
  payload = request.get_json(silent=True)
  if not isinstance(payload, dict):
    return jsonify({"error": "JSON object required"}), 400
  try:
    scope, tiles = _classifier_requested_tiles(_get_db(), payload)
    if not tiles:
      raise ValueError(f"{scope} job has no tiles")
    job = _classifier_job_control.start(
      scope=scope,
      tiles=tiles,
      use_google=bool(payload.get("useGoogle", False)),
    )
  except ValueError as exc:
    return jsonify({"error": str(exc)}), 400
  except RuntimeError as exc:
    return jsonify({"error": str(exc)}), 409
  return jsonify(job), 202


@classifier_bp.get("/api/classifier/verification/")
@classifier_bp.get("/api/classifier/verification/<path:subpath>")
def api_classifier_verification_gallery(subpath="index.html"):
  """Serve the latest ad-hoc/all-tiles verification job gallery."""
  from classifier_verify import OUT_DIR, build_gallery

  if subpath == "index.html" and not os.path.exists(
    os.path.join(OUT_DIR, "index.html")
  ):
    build_gallery(OUT_DIR, [])
  return send_from_directory(OUT_DIR, subpath)


def _training_regression_tiles() -> set[str]:
  import regression_cases

  return {
    str(case.get("tile", "")) for case in regression_cases.load_cases()
  }


@classifier_bp.get("/api/classifier/training/<tile_id>")
def api_classifier_training_tile(tile_id: str):
  """Annotation state and deterministic segment metadata for one D12 tile."""
  if _parse_tile_id(tile_id) is None:
    return jsonify({"error": "bad tile id"}), 400
  try:
    from classifier.segmentation import SEGMENTER_VERSION
    from classifier.training import (
      CLASSES, geographic_group, geographic_split,
      load_segmented_tile, read_annotations, read_classifier_suggestions,
    )

    _, segmented = load_segmented_tile(_get_db(), tile_id)
    annotations = read_annotations(_get_db(), tile_id)
    _, suggestion_source = read_classifier_suggestions(
      _get_db(), tile_id, segmented.labels.shape
    )
    regression_tiles = _training_regression_tiles()
    return jsonify({
      "tile": tile_id,
      "segmenterVersion": SEGMENTER_VERSION,
      "width": int(segmented.labels.shape[1]),
      "height": int(segmented.labels.shape[0]),
      "regionCount": len(segmented.regions),
      "classes": list(CLASSES),
      "annotations": {
        str(segment_id): class_name
        for segment_id, class_name in annotations.items()
      },
      "suggestionSource": suggestion_source,
      "group": geographic_group(tile_id),
      "split": geographic_split(tile_id, regression_tiles),
      "overlayUrl": f"/api/classifier/training/{tile_id}/overlay.png",
      "segmentIdsUrl": f"/api/classifier/training/{tile_id}/ids.png",
    })
  except ValueError as exc:
    return jsonify({"error": str(exc)}), 404


@classifier_bp.get("/api/classifier/training/<tile_id>/<kind>.png")
def api_classifier_training_image(tile_id: str, kind: str):
  if kind not in {"overlay", "ids"} or _parse_tile_id(tile_id) is None:
    return Response(b"", status=400)
  try:
    from classifier.training import (
      encode_segment_ids, load_segmented_tile,
      read_annotations, read_classifier_suggestions, render_annotation_overlay,
    )
    from PIL import Image as TrainingImage

    rgb, segmented = load_segmented_tile(_get_db(), tile_id)
    if kind == "ids":
      rendered = encode_segment_ids(segmented.labels)
    else:
      suggestions, _ = read_classifier_suggestions(
        _get_db(), tile_id, segmented.labels.shape
      )
      rendered = render_annotation_overlay(
        rgb, segmented, read_annotations(_get_db(), tile_id), suggestions
      )
    buffer = io.BytesIO()
    TrainingImage.fromarray(rendered, mode="RGB").save(buffer, format="PNG")
    return Response(
      buffer.getvalue(), mimetype="image/png",
      headers={"Cache-Control": "no-store"},
    )
  except ValueError as exc:
    return jsonify({"error": str(exc)}), 404


@classifier_bp.get("/api/classifier/training/<tile_id>/explain")
def api_classifier_training_explain(tile_id: str):
  """Provenance and measured inputs for one default assignment pixel."""
  parsed = _parse_tile_id(tile_id)
  if parsed is None or parsed[0] != WMS_CONTRACT_DEPTH:
    return jsonify({"error": "a D12 tile id is required"}), 400
  try:
    x = int(request.args["x"])
    y = int(request.args["y"])
  except (KeyError, ValueError):
    return jsonify({"error": "integer x and y pixel coordinates are required"}), 400
  try:
    from classifier.training import (
      explain_classifier_suggestion, load_segmented_tile,
    )

    rgb, segmented = load_segmented_tile(_get_db(), tile_id)
    response = jsonify(
      explain_classifier_suggestion(
        _get_db(), tile_id, segmented, x, y, rgb=rgb,
      )
    )
    response.headers["Cache-Control"] = "no-store"
    return response
  except ValueError as exc:
    return jsonify({"error": str(exc)}), 404


@classifier_bp.put("/api/classifier/training/<tile_id>")
def api_classifier_training_annotate(tile_id: str):
  if _parse_tile_id(tile_id) is None:
    return jsonify({"error": "bad tile id"}), 400
  payload = request.get_json(silent=True)
  if not isinstance(payload, dict) or not isinstance(payload.get("assignments"), list):
    return jsonify({"error": "assignments list required"}), 400
  try:
    from classifier.training import load_segmented_tile, write_annotations

    _, segmented = load_segmented_tile(_get_db(), tile_id)
    annotations = write_annotations(
      _get_db(), tile_id, payload["assignments"],
      region_count=len(segmented.regions),
    )
    pair_updated = False
    try:
      from classifier.training_data import export_pairs

      export_pairs(
        _get_db(), [tile_id], regression_tiles=_training_regression_tiles(),
        allow_network=False,
      )
      pair_updated = True
    except (FileNotFoundError, ValueError) as exc:
      # The annotation is authoritative even when its reference pair has not
      # been cached yet; the next explicit export will materialize it.
      pair_error = f"{type(exc).__name__}: {exc}"
      log.info(
        f"[classifier-training] {tile_id}: annotation saved but pair export "
        f"deferred ({pair_error})"
      )
    else:
      pair_error = None
    return jsonify({
      "ok": True,
      "annotations": {str(key): value for key, value in annotations.items()},
      "annotated": len(annotations),
      "pairUpdated": pair_updated,
      "pairError": pair_error,
    })
  except (TypeError, ValueError) as exc:
    return jsonify({"error": str(exc)}), 400


@classifier_bp.get("/api/classifier/training/model")
def api_classifier_training_model():
  from classifier.neural import MODEL_CANDIDATE_PATH, MODEL_PATH, model_metadata

  if not MODEL_PATH.exists():
    return jsonify({
      "trained": False, "trainingJob": _classifier_training_control.status(),
      "candidate": model_metadata(MODEL_CANDIDATE_PATH),
    })
  try:
    model = model_metadata()
    if model is None:
      raise OSError("classifier model metadata is unavailable")
    return jsonify({
      "trained": True, "format": model["format"],
      "createdAt": model.get("createdAt"),
      "metrics": model.get("metrics", {}),
      "datasetDigest": model.get("datasetDigest"),
      "datasetEntries": model.get("datasetEntries", 0),
      "candidate": model_metadata(MODEL_CANDIDATE_PATH),
      "trainingJob": _classifier_training_control.status(),
    })
  except (OSError, ValueError) as exc:
    return jsonify({"trained": False, "error": str(exc)}), 500


@classifier_bp.get("/api/classifier/training/dataset.json")
def api_classifier_training_dataset():
  from classifier.training_data import load_manifest

  response = jsonify(load_manifest())
  response.headers["Content-Disposition"] = (
    'attachment; filename="atlantis-classifier-manifest.json"'
  )
  response.headers["Cache-Control"] = "no-store"
  return response


@classifier_bp.post("/api/classifier/training/train")
def api_classifier_training_train():
  try:
    from classifier.neural import MODEL_CANDIDATE_PATH
    from classifier.training_data import load_manifest

    manifest = load_manifest()
    if not any(entry.get("split") == "train" for entry in manifest["entries"]):
      raise ValueError(
        "no exported training pairs; run classifier_train.py export first"
      )
    payload = request.get_json(silent=True) or {}
    options = {
      "pretrain_steps": max(0, min(int(payload.get("pretrainSteps", 2000)), 100000)),
      "finetune_steps": max(0, min(int(payload.get("finetuneSteps", 2000)), 100000)),
      "batch_size": max(1, min(int(payload.get("batchSize", 4)), 64)),
      "patch_size": max(32, min(int(payload.get("patchSize", 128)), 256)),
      "seed": int(payload.get("seed", 20260803)),
      "model_path": MODEL_CANDIDATE_PATH,
    }
    state = _classifier_training_control.start(**options)
    return jsonify({"ok": True, "trainingJob": state}), 202
  except (TypeError, ValueError) as exc:
    return jsonify({"error": str(exc)}), 400


@classifier_bp.post("/api/classifier/training/predict/<tile_id>")
def api_classifier_training_predict(tile_id: str):
  if _parse_tile_id(tile_id) is None:
    return jsonify({"error": "bad tile id"}), 400
  try:
    from classifier.training import predict_tile

    return jsonify({"ok": True, **predict_tile(_get_db(), tile_id)})
  except ValueError as exc:
    return jsonify({"error": str(exc)}), 400


