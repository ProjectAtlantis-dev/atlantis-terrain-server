import unittest
import sqlite3
import tempfile
import os
from pathlib import Path

import numpy as np

os.environ.setdefault("DATAFORSYNINGEN_TOKEN", "test-token")

from database import GRID_N, open_db, seed_tiles, write_tile
from terrain_seams import (
    SqliteSeamCache,
    init_seam_cache,
    invalidate_tile_seams,
    repair_lod_seams,
)


def _tile(tile_id, bbox, fill):
    return {
        "id": tile_id,
        "bbox": list(bbox),
        "heightmap": np.full((GRID_N, GRID_N), fill, dtype=np.float32),
    }


class TerrainSeamRepairTest(unittest.TestCase):
    def test_depth_12_neighbors_receive_identical_average_edge(self):
        west = _tile("12-100-200", (0, 0, 1, 1), 10)
        east = _tile("12-101-200", (1, 0, 2, 1), 20)

        repairs = repair_lod_seams([west, east])

        np.testing.assert_array_equal(west["heightmap"][:, -1], 15)
        np.testing.assert_array_equal(east["heightmap"][:, 0], 15)
        self.assertEqual(repairs["same_depth"], 1)
        self.assertEqual(repairs["cross_lod"], 0)

    def test_depth_12_edge_follows_rendered_depth_11_neighbor(self):
        fine = _tile("12-1-0", (1, 0, 2, 1), -100)
        coarse = _tile("11-1-0", (2, 0, 4, 2), 0)
        coarse_y = np.linspace(0, 20, GRID_N, dtype=np.float32)
        coarse["heightmap"][:] = coarse_y[:, None]

        repairs = repair_lod_seams([fine, coarse])

        np.testing.assert_allclose(
            fine["heightmap"][:, -1],
            np.linspace(0, 10, GRID_N),
            atol=1e-5,
        )
        self.assertEqual(repairs["same_depth"], 0)
        self.assertEqual(repairs["cross_lod"], 1)

    def test_edge_is_unchanged_without_a_rendered_neighbor(self):
        tile = _tile("12-100-200", (0, 0, 1, 1), 7)

        repairs = repair_lod_seams([tile])

        np.testing.assert_array_equal(tile["heightmap"], 7)
        self.assertEqual(repairs["same_depth"], 0)
        self.assertEqual(repairs["cross_lod"], 0)

    def test_exact_lookup_reuses_and_invalidation_blasts_a_tile(self):
        db = sqlite3.connect(":memory:")
        init_seam_cache(db)
        cache = SqliteSeamCache(db)
        west = _tile("12-100-200", (0, 0, 1, 1), 10)
        east = _tile("12-101-200", (1, 0, 2, 1), 20)

        first = repair_lod_seams([west, east], cache=cache)
        self.assertEqual(first["cache_misses"], 1)
        self.assertEqual(first["cache_writes"], 1)

        west["heightmap"].fill(-100)
        east["heightmap"].fill(100)
        second = repair_lod_seams([west, east], cache=cache)
        self.assertEqual(second["cache_hits"], 1)
        np.testing.assert_array_equal(west["heightmap"][:, -1], 15)
        np.testing.assert_array_equal(east["heightmap"][:, 0], 15)

        self.assertEqual(invalidate_tile_seams(db, east["id"]), 1)
        self.assertEqual(
            db.execute("SELECT COUNT(*) FROM terrain_seam_cache").fetchone()[0],
            0,
        )
        db.close()

    def test_new_tile_data_blasts_cache_entries_through_write_path(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            seed_tiles(db, max_depth=1)
            cache = SqliteSeamCache(db)
            cache.put(
                ("1-0-0", "east", "1-1-0"),
                np.full(GRID_N, 12, dtype=np.float32),
            )
            db.commit()

            heightmap = np.full((GRID_N, GRID_N), 50, dtype=np.float32)
            confidence = np.full((GRID_N, GRID_N), 6, dtype=np.uint8)
            write_tile(
                db,
                "1-1-0",
                heightmap,
                confidence,
                "arcticdem_10m",
                reconcile=False,
            )

            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM terrain_seam_cache").fetchone()[0],
                0,
            )
            db.close()


if __name__ == "__main__":
    unittest.main()
