"""HTTP-level contract for /api/classifier/<id>.png?raw=1.

Regression coverage for two real bugs found live in this session:
  - the endpoint must mark a fallback (no classifier row anywhere in the
    ancestor chain yet) as X-Classifier-Status: pending, not ready — the
    client's surface-field store caches every "ready" response permanently,
    and caching a transient blank as final left most of the map frozen
    grass-less (see terrain-surface-fields.js get()).
  - the raw mask must stay a plain RGB (3-channel) PNG, never RGBA. An
    earlier version packed DARK into the alpha channel; the client decodes
    via a 2D canvas drawImage/getImageData round trip, which premultiplies
    alpha by default and zeroed R/G/B wherever alpha was 0 (visible live as
    "everything vanished except rocks on the dark streaks").
"""

import sqlite3
import unittest
import zlib
from unittest.mock import patch

import numpy as np
from PIL import Image

import serve_flask
from classifier.storage import (
    COARSE_SCHEMA, COARSE_V2_SCHEMA, COARSE_V3_SCHEMA, COARSE_V4_SCHEMA,
    colorize_class_map,
)


def _make_db():
    db = sqlite3.connect(":memory:")
    db.executescript("""
        CREATE TABLE classifier_tiles (
          tile_id TEXT PRIMARY KEY, class_schema TEXT, width INTEGER,
          height INTEGER, class_map BLOB, confidence_map BLOB,
          source TEXT, updated_at TEXT
        );
        CREATE TABLE coastline_masks (
          tile_id TEXT PRIMARY KEY, width INTEGER, height INTEGER, mask BLOB,
          source TEXT, version INTEGER, updated_at TEXT
        );
        CREATE TABLE hydrography_masks (
          tile_id TEXT PRIMARY KEY, width INTEGER, height INTEGER, mask BLOB,
          source TEXT, version INTEGER, updated_at TEXT
        );
    """)
    return db


class ClassifierRawMaskEndpointTest(unittest.TestCase):
    def _get(self, url):
        with (
            patch.object(serve_flask, "_terrain_unavailable_response", return_value=None),
            patch.object(serve_flask, "_get_db", return_value=self.db),
            patch.object(serve_flask, "_np", np),
        ):
            return serve_flask.app.test_client().get(url)

    def setUp(self):
        self.db = _make_db()

    def test_ready_when_a_real_classification_exists(self):
        # depth < WMS_CONTRACT_DEPTH so _ensure_d12_class_map is a no-op —
        # this test is only about the ancestor-walk / status contract.
        labels = np.zeros((4, 4), dtype=np.uint8)  # all GREY
        self.db.execute(
            "INSERT INTO classifier_tiles VALUES (?,?,?,?,?,?,?,?)",
            ("5-1-1", COARSE_SCHEMA, 4, 4, zlib.compress(labels.tobytes()),
             None, "segmenter", "now"),
        )
        self.db.commit()

        response = self._get("/api/classifier/5-1-1.png?raw=1&res=8")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("X-Classifier-Status"), "ready")
        img = Image.open(__import__("io").BytesIO(response.data))
        self.assertEqual(img.mode, "RGB")

    def test_v2_mask_distinguishes_shadow_from_exact_black_water(self):
        labels = np.asarray([[5, 6], [4, 1]], dtype=np.uint8)
        self.db.execute(
            "INSERT INTO classifier_tiles VALUES (?,?,?,?,?,?,?,?)",
            ("5-1-1", COARSE_V2_SCHEMA, 2, 2, zlib.compress(labels.tobytes()),
             None, "ladder", "now"),
        )
        self.db.commit()

        response = self._get("/api/classifier/5-1-1.png?raw=1&res=16")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.headers.get("X-Classifier-Mask"), "surface_rgb_v2",
        )
        arr = np.asarray(Image.open(__import__("io").BytesIO(response.data)))
        np.testing.assert_array_equal(arr[0, 0], (1, 0, 0))  # shadow marker
        np.testing.assert_array_equal(arr[0, -1], (0, 0, 0))  # lake
        np.testing.assert_array_equal(arr[-1, 0], (0, 0, 0))  # water
        np.testing.assert_array_equal(arr[-1, -1], (0, 255, 0))  # vegetation

    def test_v3_mask_exposes_beach_as_a_distinct_surface_marker(self):
        labels = np.asarray([[7, 1], [6, 5]], dtype=np.uint8)
        self.db.execute(
            "INSERT INTO classifier_tiles VALUES (?,?,?,?,?,?,?,?)",
            ("5-1-1", COARSE_V3_SCHEMA, 2, 2, zlib.compress(labels.tobytes()),
             None, "ladder", "now"),
        )
        self.db.commit()

        response = self._get("/api/classifier/5-1-1.png?raw=1&res=16")

        self.assertEqual(
            response.headers.get("X-Classifier-Mask"), "surface_rgb_v3",
        )
        arr = np.asarray(Image.open(__import__("io").BytesIO(response.data)))
        np.testing.assert_array_equal(arr[0, 0], (64, 0, 0))  # beach
        np.testing.assert_array_equal(arr[0, -1], (0, 255, 0))  # vegetation
        np.testing.assert_array_equal(arr[-1, 0], (0, 0, 0))  # lake
        np.testing.assert_array_equal(arr[-1, -1], (1, 0, 0))  # shadow

    def test_v4_mask_distinguishes_sand_and_shore_rock(self):
        labels = np.asarray([[7, 8], [6, 5]], dtype=np.uint8)
        self.db.execute(
            "INSERT INTO classifier_tiles VALUES (?,?,?,?,?,?,?,?)",
            ("5-1-1", COARSE_V4_SCHEMA, 2, 2, zlib.compress(labels.tobytes()),
             None, "ladder", "now"),
        )
        self.db.commit()

        response = self._get("/api/classifier/5-1-1.png?raw=1&res=16")

        self.assertEqual(
            response.headers.get("X-Classifier-Mask"), "surface_rgb_v4",
        )
        arr = np.asarray(Image.open(__import__("io").BytesIO(response.data)))
        np.testing.assert_array_equal(arr[0, 0], (64, 0, 0))   # sand
        np.testing.assert_array_equal(arr[0, -1], (192, 0, 0)) # shore rock
        np.testing.assert_array_equal(arr[-1, 0], (0, 0, 0))   # lake
        np.testing.assert_array_equal(arr[-1, -1], (1, 0, 0))  # shadow

    def test_pending_when_no_classification_exists_anywhere(self):
        # No classifier_tiles row for this tile or any ancestor, but a
        # coastline_masks row exists so the ancestor walk breaks with a
        # fallback instead of 404ing outright — the exact "first request
        # lands mid-fetch/mid-cook" shape that caused live cache poisoning.
        water = np.zeros((4, 4), dtype=np.uint8)  # no water pixels
        self.db.execute(
            "INSERT INTO coastline_masks VALUES (?,?,?,?,?,?,?)",
            ("0-0-0", 4, 4, zlib.compress(water.tobytes()), "official", 1, "now"),
        )
        self.db.commit()

        response = self._get("/api/classifier/0-0-0.png?raw=1&res=16")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("X-Classifier-Status"), "pending")
        img = Image.open(__import__("io").BytesIO(response.data))
        self.assertEqual(img.mode, "RGB")
        arr = np.asarray(img)
        self.assertEqual(arr.shape, (16, 16, 3))
        np.testing.assert_array_equal(arr, 0)

    def test_missing_when_nothing_exists_at_all(self):
        response = self._get("/api/classifier/0-0-0.png?raw=1&res=8")

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.headers.get("X-Classifier-Status"), "missing")

    def test_d14_inherits_the_exact_geographic_crop_from_d12(self):
        # Four levels of child offsets would be sixteen tiles; d12 -> d14 is
        # a 4x4 division. Use every non-water v4 label so the comparison
        # catches a wrong quadrant, orientation, or interpolating resize.
        values = np.asarray([0, 1, 2, 3, 5, 6, 7, 8], dtype=np.uint8)
        labels = values[
            (
                np.arange(256, dtype=np.uint16)[:, None] * 3
                + np.arange(256, dtype=np.uint16)[None, :] * 5
            ) % values.size
        ]
        self.db.execute(
            "INSERT INTO classifier_tiles VALUES (?,?,?,?,?,?,?,?)",
            ("12-10-20", COARSE_V4_SCHEMA, 256, 256,
             zlib.compress(labels.tobytes()), None, "ladder_d12_v9", "now"),
        )
        self.db.commit()

        # Child offset (column=2, row=1). Class maps are north-first while
        # quadtree row indices increase northward, so row 1 selects source
        # rows 128:192.
        with patch.object(
            serve_flask, "_ensure_d12_class_map", return_value=None,
        ):
            response = self._get("/api/classifier/14-42-81.png?res=64")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.headers.get("X-Classifier-Ancestor"), "12-10-20",
        )
        actual = np.asarray(
            Image.open(__import__("io").BytesIO(response.data))
        )
        expected = colorize_class_map(
            labels[128:192, 128:192],
            COARSE_V4_SCHEMA,
            highlight_water=False,
        )
        np.testing.assert_array_equal(actual, expected)


if __name__ == "__main__":
    unittest.main()
