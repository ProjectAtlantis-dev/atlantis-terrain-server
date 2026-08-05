import io
import sqlite3
import unittest
import zlib

import numpy as np
from PIL import Image

from classifier.storage import COARSE_V2_SCHEMA
from cliff_graft_cache import (
    CLIFF_GRAFT_ASSET_VERSION,
    _mask_dependency_rows,
    get_or_create_cliff_graft_asset,
    init_cliff_graft_assets,
)


def _png(values):
    output = io.BytesIO()
    Image.fromarray(np.asarray(values, dtype=np.uint8), mode="RGBA").save(
        output, format="PNG",
    )
    return output.getvalue()


class CliffGraftCacheTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript("""
            CREATE TABLE textures (
              tile_id TEXT PRIMARY KEY, source TEXT, texture BLOB, updated_at TEXT
            );
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
        init_cliff_graft_assets(self.db)

    def tearDown(self):
        self.db.close()

    def test_prepared_donor_is_persisted_and_dependency_versioned(self):
        pixels = np.asarray([
            [[10, 20, 30, 255], [1, 2, 3, 255], [4, 5, 6, 255]],
            [[40, 50, 60, 255], [7, 8, 9, 255], [11, 12, 13, 255]],
        ], dtype=np.uint8)
        labels = np.asarray([[0, 4, 4], [0, 4, 4]], dtype=np.uint8)
        self.db.execute(
            "INSERT INTO textures VALUES (?, ?, ?, ?)",
            ("12-1-1", "final", _png(pixels), "texture-v1"),
        )
        self.db.execute(
            "INSERT INTO classifier_tiles VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "12-1-1", COARSE_V2_SCHEMA, 3, 2,
                zlib.compress(labels.tobytes()), None, "ladder", "classes-v1",
            ),
        )
        self.db.commit()

        first = get_or_create_cliff_graft_asset(self.db, "12-1-1")
        second = get_or_create_cliff_graft_asset(self.db, "12-1-1")

        assert first is not None
        assert second is not None
        self.assertTrue(first["generated"])
        self.assertFalse(second["generated"])
        self.assertEqual(first["texture"], second["texture"])
        self.assertEqual(first["water_pixels"], 4)
        actual = np.asarray(Image.open(io.BytesIO(first["texture"])))
        np.testing.assert_array_equal(actual, np.asarray([
            [[10, 20, 30, 255], [10, 20, 30, 255], [10, 20, 30, 255]],
            [[40, 50, 60, 255], [40, 50, 60, 255], [40, 50, 60, 255]],
        ], dtype=np.uint8))
        stored = self.db.execute(
            "SELECT recipe_version, source_fingerprint "
            "FROM cliff_graft_assets WHERE donor_tile_id = ?",
            ("12-1-1",),
        ).fetchone()
        assert stored is not None
        self.assertEqual(stored[0], CLIFF_GRAFT_ASSET_VERSION)
        self.assertEqual(stored[1], first["fingerprint"])

        dry_labels = np.zeros((2, 3), dtype=np.uint8)
        self.db.execute(
            "UPDATE classifier_tiles SET class_map = ?, updated_at = ? "
            "WHERE tile_id = ?",
            (zlib.compress(dry_labels.tobytes()), "classes-v2", "12-1-1"),
        )
        self.db.commit()
        refreshed = get_or_create_cliff_graft_asset(self.db, "12-1-1")

        assert refreshed is not None
        self.assertTrue(refreshed["generated"])
        self.assertNotEqual(refreshed["fingerprint"], first["fingerprint"])
        self.assertEqual(refreshed["water_pixels"], 0)

    def test_missing_inputs_remain_retryable_without_a_cache_row(self):
        self.assertIsNone(
            get_or_create_cliff_graft_asset(self.db, "12-1-1"),
        )
        count = self.db.execute(
            "SELECT COUNT(*) FROM cliff_graft_assets",
        ).fetchone()[0]
        self.assertEqual(count, 0)

    def test_mask_dependency_query_does_not_bury_database_failures(self):
        class BrokenDatabase:
            def execute(self, *_args, **_kwargs):
                raise sqlite3.OperationalError("database is locked")

        with self.assertRaisesRegex(sqlite3.OperationalError, "locked"):
            _mask_dependency_rows(BrokenDatabase(), "12-1-1")


if __name__ == "__main__":
    unittest.main()
