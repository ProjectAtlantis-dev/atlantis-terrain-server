import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from buildings_query import pack_buildings


def _building(**overrides):
  building = {
    "id": "b1",
    "groundZ": 4.5,
    "sourceLayer": "BYGNING",
    "sourceProperties": {"lokal_id": "22BYGN_2428", "bygningsty": "Bygning"},
    "ring": [[0.0, 0.0, 10.0], [10.0, 0.0, 10.0], [10.0, 10.0, 10.0]],
  }
  building.update(overrides)
  return building


class PackBuildingsTest(unittest.TestCase):
  def test_no_buildings_packs_to_nothing(self):
    self.assertEqual(pack_buildings(None, True), (None, [], None))

  def test_binary_drops_rings_and_source_metadata_from_the_header(self):
    entries, blobs, digest = pack_buildings([_building()], True)
    self.assertEqual(len(entries), 1)
    entry = entries[0]
    self.assertEqual(entry["id"], "b1")
    self.assertEqual(entry["groundZ"], 4.5)
    # The renderer reads none of these, so they must not reach the wire.
    self.assertNotIn("ring", entry)
    self.assertNotIn("sourceLayer", entry)
    self.assertNotIn("sourceProperties", entry)
    # 3 points x 3 floats x 4 bytes.
    self.assertEqual(entry["ringBytes"], 36)
    self.assertEqual(len(blobs), 1)
    self.assertEqual(len(blobs[0]), 36)
    self.assertIsNotNone(digest)

  def test_binary_block_round_trips_the_coordinates(self):
    building = _building()
    _, blobs, _ = pack_buildings([building], True)
    restored = np.frombuffer(blobs[0], dtype=np.float32).reshape(-1, 3)
    np.testing.assert_allclose(restored, np.array(building["ring"], dtype=np.float32))

  def test_json_transport_keeps_rings_inline_and_emits_no_blocks(self):
    entries, blobs, _ = pack_buildings([_building()], False)
    self.assertEqual(entries[0]["ring"], _building()["ring"])
    self.assertEqual(blobs, [])

  def test_colour_fields_pass_through_when_present(self):
    entries, _, _ = pack_buildings(
      [_building(color=[0.1, 0.2, 0.3], colorVersion="12-1-1:v1")], True,
    )
    self.assertEqual(entries[0]["color"], [0.1, 0.2, 0.3])
    self.assertEqual(entries[0]["colorVersion"], "12-1-1:v1")

  def test_digest_is_stable_for_identical_input(self):
    first = pack_buildings([_building()], True)[2]
    second = pack_buildings([_building()], True)[2]
    self.assertEqual(first, second)

  def test_digest_covers_ring_geometry_not_just_metadata(self):
    moved = _building(ring=[[0.0, 0.0, 10.0], [10.0, 0.0, 10.0], [10.0, 99.0, 10.0]])
    # Metadata is identical; only the coordinates moved. A digest that missed
    # the ring block would let a changed footprint be reported unchanged.
    self.assertNotEqual(
      pack_buildings([_building()], True)[2],
      pack_buildings([moved], True)[2],
    )

  def test_digest_covers_ground_height(self):
    self.assertNotEqual(
      pack_buildings([_building()], True)[2],
      pack_buildings([_building(groundZ=99.0)], True)[2],
    )


class SampleFootprintColorTest(unittest.TestCase):
  """The vectorised sampler must agree with the scalar one it replaced."""

  @staticmethod
  def _scalar_reference(image, ring, bbox):
    import colorsys
    import math

    def point_in_polygon(x, y, polygon):
      inside = False
      previous = polygon[-1]
      for current in polygon:
        if (current[1] > y) != (previous[1] > y):
          crossing = (
            (previous[0] - current[0]) * (y - current[1])
            / (previous[1] - current[1]) + current[0]
          )
          if x < crossing:
            inside = not inside
        previous = current
      return inside

    height, width = image.shape[0], image.shape[1]
    x_min, y_min, x_max, y_max = bbox
    span_x, span_y = x_max - x_min, y_max - y_min
    polygon = [
      ((p[0] - x_min) / span_x * width, (y_max - p[1]) / span_y * height)
      for p in ring
    ]
    left = max(0, int(math.floor(min(p[0] for p in polygon))))
    right = min(width - 1, int(math.ceil(max(p[0] for p in polygon))))
    top = max(0, int(math.floor(min(p[1] for p in polygon))))
    bottom = min(height - 1, int(math.ceil(max(p[1] for p in polygon))))
    pixels = [
      tuple(int(v) for v in image[y, x])
      for y in range(top, bottom + 1)
      for x in range(left, right + 1)
      if point_in_polygon(x + 0.5, y + 0.5, polygon)
    ]
    if not pixels:
      cx = max(0, min(width - 1, int(round(sum(p[0] for p in polygon) / len(polygon)))))
      cy = max(0, min(height - 1, int(round(sum(p[1] for p in polygon) / len(polygon)))))
      pixels = [tuple(int(v) for v in image[cy, cx])]
    weighted = []
    for pixel in pixels:
      red, green, blue = pixel
      brightness = (red + green + blue) / 3
      if brightness < 20 or brightness > 248:
        continue
      hue, sat, _ = colorsys.rgb_to_hsv(red / 255, green / 255, blue / 255)
      earth = 0.055 <= hue <= 0.46 and sat >= 0.12
      weighted.append((pixel, 1.0 if earth else (2.0 if sat < 0.12 else 4.0)))
    if not weighted:
      return None
    total = sum(w for _, w in weighted)
    return tuple(
      int(round(sum(p[i] * w for p, w in weighted) / total)) for i in range(3)
    )

  def test_matches_the_scalar_implementation_on_random_footprints(self):
    from asset_catalog import _sample_footprint_color

    rng = np.random.default_rng(3)
    image = rng.integers(0, 256, size=(64, 64, 3), dtype=np.uint8)
    bbox = (0.0, 0.0, 640.0, 640.0)
    for _ in range(60):
      cx, cy = rng.uniform(80, 560, size=2)
      w, h = rng.uniform(15, 120, size=2)
      ring = [
        [cx - w, cy - h, 0.0], [cx + w, cy - h, 0.0],
        [cx + w * rng.uniform(0.3, 1.0), cy + h, 0.0], [cx - w, cy + h, 0.0],
      ]
      self.assertEqual(
        _sample_footprint_color(image, ring, bbox),
        self._scalar_reference(image, ring, bbox),
      )

  def test_a_footprint_off_the_tile_falls_back_to_its_centre(self):
    from asset_catalog import _sample_footprint_color

    image = np.full((16, 16, 3), 130, dtype=np.uint8)
    bbox = (0.0, 0.0, 160.0, 160.0)
    # Entirely to the left of the raster: no pixel is ever inside.
    ring = [[-90.0, 40.0, 0.0], [-70.0, 40.0, 0.0], [-70.0, 60.0, 0.0]]
    self.assertEqual(_sample_footprint_color(image, ring, bbox), (130, 130, 130))

  def test_a_fully_dark_footprint_has_no_usable_colour(self):
    from asset_catalog import _sample_footprint_color

    image = np.zeros((16, 16, 3), dtype=np.uint8)
    bbox = (0.0, 0.0, 160.0, 160.0)
    ring = [[40.0, 40.0, 0.0], [120.0, 40.0, 0.0], [120.0, 120.0, 0.0], [40.0, 120.0, 0.0]]
    self.assertIsNone(_sample_footprint_color(image, ring, bbox))


class GroundSamplerCacheTest(unittest.TestCase):
  """The cached sampler data must not outlive a request's connection."""

  def setUp(self):
    import buildings_query
    self.bq = buildings_query
    buildings_query._ground_sampler_state.update(
      bbox=None, version=None, at=0.0, db=None, index=None, heightmaps=None,
    )
    self.paths = []

  def _db(self):
    import sqlite3
    import tempfile
    if not self.paths:
      handle = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
      handle.close()
      self.paths.append(handle.name)
      seed = sqlite3.connect(handle.name)
      seed.execute(
        "CREATE TABLE tiles (tile_id TEXT PRIMARY KEY, depth INT, col INT,"
        " row INT, x_min REAL, y_min REAL, x_max REAL, y_max REAL,"
        " heightmap BLOB)"
      )
      import zlib
      import numpy as np
      grid = np.full((3, 3), 7.0, dtype=np.float32)
      bbox = _tile_bbox_for(0, 0, 0)
      seed.execute(
        "INSERT INTO tiles VALUES ('0-0-0',0,0,0,?,?,?,?,?)",
        (*bbox, zlib.compress(grid.tobytes())),
      )
      seed.commit()
      seed.close()
    conn = sqlite3.connect(self.paths[0], check_same_thread=False)
    return conn

  def tearDown(self):
    for path in self.paths:
      os.unlink(path)

  def test_a_closed_connection_cannot_be_handed_to_another_request(self):
    from terrain_config import GREENLAND_BBOX
    inside = (
      (GREENLAND_BBOX[0] + GREENLAND_BBOX[2]) / 2,
      (GREENLAND_BBOX[1] + GREENLAND_BBOX[3]) / 2,
    )
    bbox = (inside[0] - 1, inside[1] - 1, inside[0] + 1, inside[1] + 1)

    first = self._db()
    sampler_a = self.bq.ground_sampler_for(first, bbox)
    second = self._db()
    sampler_b = self.bq.ground_sampler_for(second, bbox)

    # Separate objects, so neither can rebind the other's connection...
    self.assertIsNot(sampler_a, sampler_b)
    # ...but the expensive parts are still shared.
    self.assertIs(sampler_a.index[0], sampler_b.index[0])
    self.assertIs(sampler_a.cache, sampler_b.cache)

    # The second request ends and Flask closes its connection.
    second.close()
    sampler_a.cache.clear()
    # The first request must still be able to read through its own connection.
    self.assertEqual(sampler_a.sample(inside[0], inside[1]), 7.0)
    first.close()


def _tile_bbox_for(depth, col, row):
  from terrain_config import GREENLAND_BBOX
  rx_min, ry_min, rx_max, ry_max = GREENLAND_BBOX
  n = 1 << depth
  w = (rx_max - rx_min) / n
  h = (ry_max - ry_min) / n
  x0 = rx_min + col * w
  y0 = ry_min + row * h
  return (x0, y0, x0 + w, y0 + h)


if __name__ == "__main__":
  unittest.main()
