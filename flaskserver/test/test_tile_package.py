import base64
import io
import json
import sqlite3
import unittest
import zipfile
import zlib
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

import serve_flask


class TilePackageTest(unittest.TestCase):
    def test_package_uses_exact_rendered_seam_heightmap(self):
        db = sqlite3.connect(":memory:")
        db.executescript("""
            CREATE TABLE tiles (
              tile_id TEXT PRIMARY KEY, depth INTEGER, col INTEGER, row INTEGER,
              x_min REAL, y_min REAL, x_max REAL, y_max REAL, source TEXT,
              updated_at TEXT, confidence_map BLOB, heightmap BLOB
            );
            CREATE TABLE textures (
              tile_id TEXT PRIMARY KEY, source TEXT, texture BLOB, updated_at TEXT
            );
            CREATE TABLE coastline_masks (
              tile_id TEXT PRIMARY KEY, width INTEGER, height INTEGER, mask BLOB,
              source TEXT, version INTEGER, updated_at TEXT
            );
            CREATE TABLE hydrography_masks (
              tile_id TEXT PRIMARY KEY, width INTEGER, height INTEGER, mask BLOB,
              source TEXT, version INTEGER, updated_at TEXT
            );
            CREATE TABLE classifier_tiles (
              tile_id TEXT PRIMARY KEY, class_schema TEXT, width INTEGER,
              height INTEGER, class_map BLOB, confidence_map BLOB,
              source TEXT, updated_at TEXT
            );
            CREATE TABLE terrain_seam_cache (
              tile_a TEXT, direction TEXT, tile_b TEXT, edge BLOB,
              updated_at TEXT
            );
        """)
        resolution = 3
        confidence = np.arange(9, dtype=np.uint8).reshape((3, 3))
        db.execute(
            "INSERT INTO tiles VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            ("2-1-2", 2, 1, 2, 10, 20, 30, 40, "arcticdem", "now",
             zlib.compress(confidence.tobytes()), None),
        )
        texture_buffer = io.BytesIO()
        Image.new("RGB", (4, 4), (30, 60, 90)).save(texture_buffer, format="JPEG")
        db.execute(
            "INSERT INTO textures VALUES (?,?,?,?)",
            ("2-1-2", "orthophoto", texture_buffer.getvalue(), "now"),
        )
        mask = np.eye(3, dtype=np.uint8)
        for table in ("coastline_masks", "hydrography_masks"):
            db.execute(
                f"INSERT INTO {table} VALUES (?,?,?,?,?,?,?)",
                ("2-1-2", 3, 3, zlib.compress(mask.tobytes()), "official", 1, "now"),
            )
        db.execute(
            "INSERT INTO classifier_tiles VALUES (?,?,?,?,?,?,?,?)",
            ("2-1-2", "coarse_v1", 3, 3, zlib.compress(mask.tobytes()),
             None, "segmenter", "now"),
        )
        edge = np.asarray([101, 102, 103], dtype=np.float32)
        db.execute(
            "INSERT INTO terrain_seam_cache VALUES (?,?,?,?,?)",
            ("2-1-2", "east", "2-2-2", edge.tobytes(), "now"),
        )
        db.commit()

        rendered = np.arange(9, dtype=np.float32).reshape((3, 3))
        rendered[:, -1] = edge
        request_json = {
            "resolution": resolution,
            "heightmap": base64.b64encode(rendered.tobytes()).decode("ascii"),
        }
        with (
            patch.object(serve_flask, "_terrain_unavailable_response", return_value=None),
            patch.object(serve_flask, "_get_db", return_value=db),
            patch.object(serve_flask, "_np", np),
            patch.object(serve_flask, "_Image", Image),
            patch.object(serve_flask, "ASSETS_DB_PATH", Path("/does/not/exist")),
        ):
            response = serve_flask.app.test_client().post(
                "/api/tile-package/2-1-2.zip", json=request_json,
            )

        self.assertEqual(response.status_code, 200)
        with zipfile.ZipFile(io.BytesIO(response.data)) as archive:
            names = set(archive.namelist())
            self.assertIn("heightmap-final.npy", names)
            self.assertIn("texture-source.jpg", names)
            self.assertIn("texture-final.jpg", names)
            self.assertIn("coastline-mask.png", names)
            self.assertIn("hydrography-mask.png", names)
            self.assertIn("effective-water-mask.png", names)
            self.assertIn("classifier-map.png", names)
            self.assertIn("roads.json", names)
            self.assertIn("seam-cache.json", names)
            np.testing.assert_array_equal(
                np.load(io.BytesIO(archive.read("heightmap-final.npy"))), rendered,
            )
            manifest = json.loads(archive.read("manifest.json"))
            self.assertTrue(manifest["heightmap"]["seamCacheApplied"])
            seams = json.loads(archive.read("seam-cache.json"))
            self.assertEqual(seams[0]["edge"], edge.tolist())


if __name__ == "__main__":
    unittest.main()
