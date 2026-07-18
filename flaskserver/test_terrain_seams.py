import unittest

import numpy as np

from database import GRID_N
from terrain_seams import repair_lod_seams


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
        self.assertEqual(repairs, {"same_depth": 1, "cross_lod": 0})

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
        self.assertEqual(repairs, {"same_depth": 0, "cross_lod": 1})

    def test_edge_is_unchanged_without_a_rendered_neighbor(self):
        tile = _tile("12-100-200", (0, 0, 1, 1), 7)

        repairs = repair_lod_seams([tile])

        np.testing.assert_array_equal(tile["heightmap"], 7)
        self.assertEqual(repairs, {"same_depth": 0, "cross_lod": 0})


if __name__ == "__main__":
    unittest.main()
