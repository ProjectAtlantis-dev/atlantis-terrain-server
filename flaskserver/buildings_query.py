"""Scene buildings for the terrain-tile response.

Footprints come from two sources that have to be reconciled before they can be
drawn: Asiaq's surveyed Teknisk Grundkort polygons inside settlements, and the
coarser GTK50 vector structures everywhere else. This module resolves both
against the terrain, suppresses the overlap, and packs the result for the wire.

It lives outside ``serve_flask`` because none of it is HTTP: every entry point
takes explicit database handles, so it can be exercised without a request
context.
"""
from __future__ import annotations

import json
import math
import threading
import time
import zlib
from typing import Any

import numpy as np

# How far from the camera building footprints are sent to the viewer. The
# client draws them as one merged mesh with no distance fade, so this alone
# is the building view distance.
BUILDING_QUERY_RANGE_M = 9000.0

# Distance LOD. A 13m house (the median footprint) is a couple of pixels at
# 4km and costs the same to build and draw as the landmark next to it, so the
# far band carries only what is actually legible at that range: everything
# inside FULL_DETAIL, then large footprints only out to the query range.
# Measured at Nuuk: p50 = 73 m2, p90 = 377 m2, p99 = 1500 m2, so a 300 m2
# floor keeps roughly the largest 15% — schools, blocks, industrial sheds.
BUILDING_FULL_DETAIL_RANGE_M = 2500.0
BUILDING_FAR_MIN_AREA_M2 = 300.0


def _ring_area_and_center(ring):
  """Shoelace area and centroid-ish center of a footprint ring."""
  count = len(ring)
  if count < 3:
    return 0.0, (0.0, 0.0)
  twice_area = 0.0
  sum_x = 0.0
  sum_y = 0.0
  previous = ring[-1]
  for point in ring:
    twice_area += previous[0] * point[1] - point[0] * previous[1]
    sum_x += point[0]
    sum_y += point[1]
    previous = point
  return abs(twice_area) / 2.0, (sum_x / count, sum_y / count)


def apply_distance_lod(buildings, qx, qy, ox, oy):
  """Drop small footprints beyond the full-detail radius.

  Rings arrive relative to the response origin, so the camera offset has to be
  added back before measuring the distance to one.
  """
  kept = []
  for building in buildings:
    ring = building.get("ring") or []
    area, (cx, cy) = _ring_area_and_center(ring)
    distance = math.hypot((cx + ox) - qx, (cy + oy) - qy)
    if distance <= BUILDING_FULL_DETAIL_RANGE_M or area >= BUILDING_FAR_MIN_AREA_M2:
      kept.append(building)
  return kept

# Loading the sampler's tile table dominated /api/tiles once the per-building
# scan was addressed. The camera barely moves between one-second polls, so the
# same tile set is reloaded over and over. Cache it, padded so small movements
# still fall inside the loaded region.
_GROUND_SAMPLER_PAD_M = 2000.0
# data_version catches writes from the DEM/COG worker connections; the TTL is
# the backstop, since a fresh per-request connection is not a reliable observer
# of it. A tile that gains a heightmap is reflected within this window.
_GROUND_SAMPLER_TTL_S = 15.0
_ground_sampler_lock = threading.Lock()
_ground_sampler_state: dict[str, Any] = {
  "bbox": None, "version": None, "at": 0.0, "db": None,
  "index": None, "heightmaps": None,
}


def ground_sampler_for(db, bbox):
  """A sampler on this request's connection, over a shared cached index.

  Only the tile index and decompressed heightmaps are cached; the sampler
  itself is per-request. Caching the sampler and rebinding its connection let
  one request hand another a connection that request teardown had already
  closed.
  """
  # Keyed to the database file: connections are per-request, so their identity
  # says nothing, and two databases must never share a sampler. In-memory
  # databases all report an empty path and so are never cached.
  try:
    row = db.execute("PRAGMA database_list").fetchone()
    db_key = row[2] if row else None
  except Exception:
    db_key = None
  try:
    version = db.execute("PRAGMA data_version").fetchone()[0]
  except Exception:
    version = None
  from ingest_buildings import GroundSampler

  now = time.monotonic()
  with _ground_sampler_lock:
    index = _ground_sampler_state["index"]
    loaded = _ground_sampler_state["bbox"]
    if (
      index is not None
      and loaded is not None
      and db_key
      and _ground_sampler_state.get("db") == db_key
      and _ground_sampler_state["version"] == version
      and now - _ground_sampler_state["at"] < _GROUND_SAMPLER_TTL_S
      and loaded[0] <= bbox[0] and loaded[1] <= bbox[1]
      and loaded[2] >= bbox[2] and loaded[3] >= bbox[3]
    ):
      # Cheap: no query, just a view onto the shared index and heightmaps,
      # bound to the connection that belongs to this request.
      return GroundSampler(
        db, index=index, cache=_ground_sampler_state["heightmaps"],
      )

  padded = (
    bbox[0] - _GROUND_SAMPLER_PAD_M, bbox[1] - _GROUND_SAMPLER_PAD_M,
    bbox[2] + _GROUND_SAMPLER_PAD_M, bbox[3] + _GROUND_SAMPLER_PAD_M,
  )
  sampler = GroundSampler(db, bbox=padded)
  with _ground_sampler_lock:
    _ground_sampler_state.update(
      bbox=padded, version=version, at=now, db=db_key,
      index=sampler.index, heightmaps=sampler.cache,
    )
  return sampler


# Resolving footprints costs 200-1700ms in a settlement, and the poll runs
# once a second while the camera drifts a few metres. The hash echo already
# suppresses the *transfer* of an unchanged set, but it is computed from the
# result, so it never saved any of the work. Cache the resolved list against a
# quantised camera position instead.
_RESULT_CELL_M = 250.0
_RESULT_TTL_S = 10.0
_result_lock = threading.Lock()
_result_state: dict[str, Any] = {"key": None, "at": 0.0, "buildings": None}


def _result_key(qx, qy, ox, oy):
  # ox/oy are subtracted from every ring, so they are part of the identity of
  # the cached coordinates, not just of the query.
  return (round(qx / _RESULT_CELL_M), round(qy / _RESULT_CELL_M), ox, oy)


def invalidate_buildings_cache() -> None:
  """Drop the resolved-footprint cache (tests, and asset edits)."""
  with _result_lock:
    _result_state.update(key=None, at=0.0, buildings=None)


class LazyGroundSampler:
  """Defers building the ground sampler until something actually samples.

  ``query_structures`` calls ``sample`` once per structure it finds, so empty
  terrain never calls it at all — and most of Greenland is empty terrain.
  Building the index eagerly cost 100-180ms of SQL on every request whose
  camera had moved outside the cached region, to sample nothing.
  """

  __slots__ = ("_db", "_bbox", "_sampler")

  def __init__(self, db, bbox):
    self._db = db
    self._bbox = bbox
    self._sampler = None

  @property
  def built(self) -> bool:
    return self._sampler is not None

  def sample(self, x, y):
    if self._sampler is None:
      self._sampler = ground_sampler_for(self._db, self._bbox)
    return self._sampler.sample(x, y)


def buildings_for_tile_query(terrain_db, assets_db, qx, qy, ox, oy):
  """Resolve scene buildings as part of the terrain-tile transaction."""
  from asset_catalog import (
    color_buildings_from_textures, query_asset_bounds_by_type,
    query_asset_by_type,
  )
  from gtk50_vector import query_structures
  from ingest_buildings import SOURCE_LAYER

  key = _result_key(qx, qy, ox, oy)
  now = time.monotonic()
  with _result_lock:
    if (
      _result_state["key"] == key
      and now - _result_state["at"] < _RESULT_TTL_S
      and _result_state["buildings"] is not None
    ):
      return _result_state["buildings"]

  building_assets = query_asset_by_type(
    assets_db, SOURCE_LAYER, qx, qy, BUILDING_QUERY_RANGE_M,
    near_range=BUILDING_FULL_DETAIL_RANGE_M,
    far_min_bbox_area=BUILDING_FAR_MIN_AREA_M2,
  )
  buildings = []
  for asset in building_assets:
    props = asset["properties"]
    ring = props.get("ring")
    if not isinstance(ring, list) or len(ring) < 3:
      continue
    buildings.append({
      "id": asset["id"],
      "sourceLayer": props.get("sourceLayer"),
      "sourceProperties": props.get("sourceProperties"),
      "groundZ": props.get("groundZ", 0),
      "ring": [[point[0] - ox, point[1] - oy, point[2]] for point in ring],
    })
  bbox = (
    qx - BUILDING_QUERY_RANGE_M, qy - BUILDING_QUERY_RANGE_M,
    qx + BUILDING_QUERY_RANGE_M, qy + BUILDING_QUERY_RANGE_M,
  )
  gtk50 = query_structures(
    bbox, ground_sampler=LazyGroundSampler(terrain_db, bbox), ox=ox, oy=oy,
  )
  # Asiaq's surveyed PolygonZ is the higher-detail authority inside towns.
  # Suppress a coarse GTK50 footprint when its centre falls into an Asiaq
  # footprint's bounds, avoiding doubled walls and overlapping roofs.
  # Suppression must consider EVERY Asiaq footprint in range, not just the
  # ones the distance LOD kept: dropping a small far one and then letting its
  # coarse GTK50 twin through would put two overlapping buildings on the same
  # roof. These come from the stored bounds, so no properties are parsed.
  asiaq_bounds: dict[tuple[int, int], list[tuple[float, float, float, float]]] = {}
  index_cell_m = 100.0
  for x0, y0, x1, y1 in query_asset_bounds_by_type(
    assets_db, SOURCE_LAYER, qx, qy, BUILDING_QUERY_RANGE_M,
  ):
    bounds = (x0 - ox - 2, y0 - oy - 2, x1 - ox + 2, y1 - oy + 2)
    for ix in range(math.floor(bounds[0] / index_cell_m), math.floor(bounds[2] / index_cell_m) + 1):
      for iy in range(math.floor(bounds[1] / index_cell_m), math.floor(bounds[3] / index_cell_m) + 1):
        asiaq_bounds.setdefault((ix, iy), []).append(bounds)
  for structure in gtk50:
    cx, cy = structure.pop("_center")
    candidates = asiaq_bounds.get(
      (math.floor(cx / index_cell_m), math.floor(cy / index_cell_m)), []
    )
    if any(x0 <= cx <= x1 and y0 <= cy <= y1 for x0, y0, x1, y1 in candidates):
      continue
    buildings.append(structure)
  # Cull before colouring: a footprint nobody will see does not need its roof
  # sampled out of the imagery either.
  buildings = apply_distance_lod(buildings, qx, qy, ox, oy)
  color_buildings_from_textures(terrain_db, buildings, ox, oy)
  with _result_lock:
    _result_state.update(key=key, at=now, buildings=buildings)
  return buildings


def pack_buildings(buildings, binary: bool):
  """Split footprints into wire metadata, ring blocks, and a digest.

  Rings are float coordinates; as JSON they were 0.82MB of the 1.81MB the
  browser parsed on its main thread every poll. On the binary transport they
  become a float32 block the client views without copying, and the Asiaq
  source metadata the renderer never reads is dropped entirely.

  Returns ``(entries, ring_blobs, digest)``. ``entries`` is None when there
  were no buildings to send.
  """
  if buildings is None:
    return None, [], None

  entries: list[dict[str, Any]] = []
  blobs: list[bytes] = []
  for building in buildings:
    ring = building.get("ring") or []
    ring_bytes = np.asarray(ring, dtype=np.float32).tobytes()
    entry: dict[str, Any] = {
      "id": building["id"],
      "groundZ": building.get("groundZ", 0),
      "ringBytes": len(ring_bytes),
    }
    # Clients on the JSON transport have no block to view into.
    if not binary:
      entry["ring"] = ring
    if "color" in building:
      entry["color"] = building["color"]
    if "colorVersion" in building:
      entry["colorVersion"] = building["colorVersion"]
    entries.append(entry)
    blobs.append(ring_bytes)

  # The digest must cover the bytes actually sent, metadata and rings alike,
  # so an unchanged set is still recognised across either transport.
  digest = zlib.crc32(
    json.dumps(entries, separators=(",", ":"), sort_keys=True).encode("utf-8")
  )
  for ring_bytes in blobs:
    digest = zlib.crc32(ring_bytes, digest)
  return entries, (blobs if binary else []), f"{digest & 0xFFFFFFFF:08x}"
