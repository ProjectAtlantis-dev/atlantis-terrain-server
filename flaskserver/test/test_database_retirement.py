import os
import sqlite3
import tempfile
import unittest
import zlib
from pathlib import Path

import numpy as np

os.environ.setdefault("DATAFORSYNINGEN_TOKEN", "test-token")

from database import GRID_N, _compress_array, open_db


def _seed_legacy_db(path):
    db = sqlite3.connect(path)
    db.executescript(
        """
        CREATE TABLE tiles (
            tile_id TEXT PRIMARY KEY,
            depth INTEGER NOT NULL,
            col INTEGER NOT NULL,
            row INTEGER NOT NULL,
            x_min REAL NOT NULL,
            y_min REAL NOT NULL,
            x_max REAL NOT NULL,
            y_max REAL NOT NULL,
            parent_id TEXT,
            geometric_error REAL NOT NULL DEFAULT 0.0,
            source TEXT NOT NULL DEFAULT 'empty',
            updated_at TEXT NOT NULL,
            heightmap BLOB,
            confidence_map BLOB,
            has_sealevel_water INTEGER,
            has_flattened_water INTEGER
        );
        CREATE TABLE bathy_originals (
            tile_id TEXT PRIMARY KEY,
            heightmap BLOB NOT NULL,
            confidence_map BLOB,
            source TEXT,
            algo_version INTEGER,
            updated_at TEXT
        );
        CREATE TABLE google_refs (tile_id TEXT PRIMARY KEY, texture BLOB);
        CREATE TABLE seam_jobs (tile_id TEXT PRIMARY KEY);
        CREATE TABLE water_masks (tile_id TEXT PRIMARY KEY);
        """
    )
    heightmap = np.ones((GRID_N, GRID_N), dtype=np.float32)
    normal_confidence = np.full((GRID_N, GRID_N), 6, dtype=np.uint8)
    modified_confidence = normal_confidence.copy()
    modified_confidence[0, 0] = 7
    for tile_id, source, confidence in (
        ("11-1-1", "arcticdem_10m", normal_confidence),
        ("11-1-2", "arcticdem_10m", modified_confidence),
        ("11-1-3", "arcticdem_10m", normal_confidence),
    ):
        db.execute(
            "INSERT INTO tiles (tile_id, depth, col, row, x_min, y_min, x_max, "
            "y_max, parent_id, geometric_error, source, updated_at, heightmap, "
            "confidence_map) VALUES (?, 11, ?, ?, ?, ?, ?, ?, ?, 12, ?, ?, ?, ?)",
            (
                tile_id,
                int(tile_id.split("-")[1]),
                int(tile_id.split("-")[2]),
                0,
                0,
                1,
                1,
                None,
                source,
                "now",
                _compress_array(heightmap),
                _compress_array(confidence),
            ),
        )
    db.execute(
        "INSERT INTO bathy_originals VALUES (?, ?, ?, ?, ?, ?)",
        (
            "11-1-1",
            _compress_array(heightmap),
            _compress_array(normal_confidence),
            "arcticdem_10m",
            7,
            "now",
        ),
    )
    db.execute("INSERT INTO google_refs VALUES ('11-1-1', X'00')")
    db.commit()
    db.close()


class RetiredTerrainMigrationTest(unittest.TestCase):
    def test_open_db_discards_retired_terrain_and_storage(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "terrain.db"
            _seed_legacy_db(path)

            db = open_db(str(path))

            tables = {
                row[0]
                for row in db.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
            self.assertNotIn("bathy_originals", tables)
            self.assertNotIn("google_refs", tables)
            self.assertNotIn("seam_jobs", tables)
            self.assertNotIn("water_masks", tables)
            self.assertEqual(
                db.execute(
                    "SELECT value FROM metadata WHERE key = 'schema_version'"
                ).fetchone(),
                ("5",),
            )
            columns = {row[1] for row in db.execute("PRAGMA table_info(tiles)")}
            self.assertNotIn("has_sealevel_water", columns)
            self.assertNotIn("has_flattened_water", columns)
            self.assertIn("dem_demanded_at", columns)
            self.assertIn("dem_requested_at", columns)
            self.assertIn("cog_requested_at", columns)

            rows = {
                row[0]: row[1:]
                for row in db.execute(
                    "SELECT tile_id, source, geometric_error, heightmap, confidence_map "
                    "FROM tiles ORDER BY tile_id"
                )
            }
            self.assertEqual(rows["11-1-1"], ("empty", 0.0, None, None))
            self.assertEqual(rows["11-1-2"], ("empty", 0.0, None, None))
            self.assertEqual(
                rows["11-1-3"][0:2], ("unmasked_arcticdem_10m", 12.0)
            )
            self.assertIsNotNone(rows["11-1-3"][2])
            self.assertIsNotNone(rows["11-1-3"][3])
            db.close()

            # Reopening is a no-op: retired data cannot be restored from a backup.
            db = open_db(str(path))
            self.assertEqual(
                db.execute(
                    "SELECT source, heightmap FROM tiles WHERE tile_id = '11-1-1'"
                ).fetchone(),
                ("empty", None),
            )
            db.close()

    def test_v3_preserves_but_queues_coastline_modified_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "terrain.db"
            db = open_db(str(path))
            heightmap = np.full((GRID_N, GRID_N), 42.0, dtype=np.float32)
            confidence = np.full((GRID_N, GRID_N), 6, dtype=np.uint8)
            db.execute(
                "INSERT INTO tiles "
                "(tile_id, depth, col, row, x_min, y_min, x_max, y_max, "
                "parent_id, geometric_error, source, updated_at, heightmap, "
                "confidence_map) VALUES "
                "('12-1-2', 12, 1, 2, 0, 0, 1, 1, NULL, 1, "
                "'arcticdem_10m', 'now', ?, ?)",
                (_compress_array(heightmap), _compress_array(confidence)),
            )
            db.execute(
                "UPDATE metadata SET value = '2' WHERE key = 'schema_version'"
            )
            db.commit()
            db.close()

            db = open_db(str(path))
            source, blob = db.execute(
                "SELECT source, heightmap FROM tiles WHERE tile_id = '12-1-2'"
            ).fetchone()
            self.assertEqual(source, "clobbered_arcticdem_10m")
            np.testing.assert_array_equal(
                np.frombuffer(zlib.decompress(blob), dtype=np.float32).reshape(
                    GRID_N, GRID_N
                ),
                heightmap,
            )
            db.close()

if __name__ == "__main__":
    unittest.main()
