import io
import os
import sqlite3
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

os.environ.setdefault("DATAFORSYNINGEN_TOKEN", "test-token")

import database
from classifier.hierarchy import d12_lake_prior
from texture import init_textures, write_texture


class ClassifierHierarchyTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript(database._SCHEMA)
        init_textures(self.db)
        heightmap = database._compress_array(
            np.zeros((65, 65), dtype=np.float32)
        )
        confidence = database._compress_array(
            np.full((65, 65), 6, dtype=np.uint8)
        )
        texture = io.BytesIO()
        Image.new("RGB", (256, 256), (80, 90, 100)).save(
            texture, format="JPEG"
        )
        for tile_id, depth, col, row, bbox in (
            ("10-1-2", 10, 1, 2, (0, 0, 4, 4)),
            ("11-3-4", 11, 3, 4, (2, 0, 4, 2)),
        ):
            self.db.execute(
                "INSERT INTO tiles (tile_id, depth, col, row, x_min, y_min, "
                "x_max, y_max, source, updated_at, heightmap, confidence_map) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'measured', 'now', ?, ?)",
                (tile_id, depth, col, row, *bbox, heightmap, confidence),
            )
            write_texture(
                self.db, tile_id, texture.getvalue(),
                "dataforsyningen_metatile4h2",
            )

    def tearDown(self):
        self.db.close()

    def test_d10_and_d11_support_are_cropped_into_the_d12_frame(self):
        # 12-6-9 is d10 offset (2,1), d11 offset (0,1). Fill exactly those
        # north-first source windows in both ancestor support rasters.
        d10 = np.zeros((256, 256), dtype=bool)
        d10[128:192, 128:192] = True
        d11 = np.zeros((256, 256), dtype=bool)
        d11[0:128, 0:128] = True

        with patch(
            "classifier.hierarchy.lake_support_mask",
            side_effect=(d10, d11),
        ):
            prior = d12_lake_prior(self.db, "12-6-9")

        self.assertIsNotNone(prior)
        assert prior is not None
        self.assertEqual(prior.shape, (256, 256))
        self.assertTrue(np.all(prior))

    def test_d10_absence_vetoes_d11_water_support(self):
        d10 = np.zeros((256, 256), dtype=bool)
        d11 = np.ones((256, 256), dtype=bool)

        with patch(
            "classifier.hierarchy.lake_support_mask",
            side_effect=(d10, d11),
        ):
            prior = d12_lake_prior(self.db, "12-6-9")

        self.assertIsNotNone(prior)
        self.assertFalse(np.any(prior))


if __name__ == "__main__":
    unittest.main()
