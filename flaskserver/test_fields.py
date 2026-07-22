import sqlite3
import unittest

import numpy as np

from fields import (
    FIELD_ALGORITHM_VERSION,
    compute_fields,
    init_fields_cache,
    read_fields_cache,
    write_fields_cache,
)


class FieldWaterTests(unittest.TestCase):
    def test_dark_flat_elevated_land_is_not_water(self):
        rgb = np.full((32, 32, 3), 55, np.uint8)
        height = np.full((65, 65), 28.0, np.float32)
        fields = compute_fields(rgb, height, 650.0, res=32)
        self.assertLess(float(fields["water"].mean()), 0.05)

    def test_dark_flat_sea_remains_water(self):
        rgb = np.full((32, 32, 3), 35, np.uint8)
        height = np.zeros((65, 65), np.float32)
        fields = compute_fields(rgb, height, 650.0, res=32)
        self.assertGreater(float(fields["water"].mean()), 0.5)

    def test_cached_mask_overrides_heuristic(self):
        rgb = np.full((32, 32, 3), 180, np.uint8)
        height = np.full((65, 65), 100.0, np.float32)
        mask = np.ones((16, 16), np.float32)
        fields = compute_fields(rgb, height, 650.0, res=32, water_mask=mask)
        self.assertGreater(float(fields["water"].mean()), 0.99)


class FieldCacheTests(unittest.TestCase):
    def test_cache_requires_current_sources_and_algorithm(self):
        db = sqlite3.connect(":memory:")
        init_fields_cache(db)
        write_fields_cache(db, "10-1-2", 64, b"new", "texture-a|dem-a")
        self.assertEqual(
            read_fields_cache(db, "10-1-2", 64, "texture-a|dem-a"), b"new"
        )
        self.assertIsNone(
            read_fields_cache(db, "10-1-2", 64, "texture-b|dem-a")
        )
        version = db.execute(
            "SELECT algorithm_version FROM fields WHERE tile_id='10-1-2'"
        ).fetchone()[0]
        self.assertEqual(version, FIELD_ALGORITHM_VERSION)


if __name__ == "__main__":
    unittest.main()
