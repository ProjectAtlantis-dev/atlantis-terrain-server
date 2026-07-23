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
from classifier.storage import COARSE_SCHEMA


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


if __name__ == "__main__":
    unittest.main()
