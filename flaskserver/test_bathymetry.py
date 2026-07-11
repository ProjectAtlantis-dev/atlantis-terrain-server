import unittest

import numpy as np

from bathymetry import (
    CLIFF_TOL_M,
    OCEAN_LEVEL_M,
    _erode_cliffs,
    _safe_propagation_mask,
    flatten_fake_bathymetry,
)


class NoCliffInvariantTests(unittest.TestCase):
    def test_erodes_overcapture_back_to_low_ground(self):
        hm = np.zeros((7, 7), dtype=np.float32)
        hm[:, 3] = 6.0
        hm[:, 4] = 18.0
        hm[:, 5:] = 40.0
        captured = np.zeros_like(hm, dtype=bool)
        captured[:, 1:5] = True

        safe = _erode_cliffs(hm, captured)

        self.assertTrue(safe[:, 1:3].all())
        self.assertFalse(safe[:, 3:].any())

    def test_preserves_capture_with_safe_valley_boundary(self):
        hm = np.zeros((7, 7), dtype=np.float32)
        hm[:, 3] = OCEAN_LEVEL_M + CLIFF_TOL_M
        hm[:, 4:] = 80.0
        captured = np.zeros_like(hm, dtype=bool)
        captured[:, 1:3] = True

        np.testing.assert_array_equal(_erode_cliffs(hm, captured), captured)

    def test_full_flattener_cannot_cut_into_high_real_terrain(self):
        hm = np.zeros((9, 9), dtype=np.float32)
        hm[:, 2] = 5.0
        hm[:, 3] = 15.0
        hm[:, 4:] = 200.0
        px = np.zeros((9, 9, 3), dtype=np.uint8)
        px[:, :4, 2] = 20  # dark blue over-captures the lower real slope

        new, captured = flatten_fake_bathymetry(hm, px)

        self.assertFalse(captured[:, 2:].any())
        self.assertTrue(np.all(new[captured] == OCEAN_LEVEL_M))
        for r, c in zip(*np.nonzero(captured)):
            for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                rr, cc = r + dr, c + dc
                if 0 <= rr < 9 and 0 <= cc < 9 and not captured[rr, cc]:
                    self.assertLessEqual(
                        new[rr, cc] - new[r, c], CLIFF_TOL_M
                    )

    def test_sparse_parent_sample_is_rejected_beside_high_terrain(self):
        hm = np.full((9, 9), 80.0, dtype=np.float32)
        candidates = np.zeros_like(hm, dtype=bool)
        candidates[4, 4] = True

        safe = _safe_propagation_mask(hm, candidates)

        self.assertFalse(safe.any())

    def test_parent_water_samples_survive_on_low_ground(self):
        hm = np.zeros((9, 9), dtype=np.float32)
        candidates = np.zeros_like(hm, dtype=bool)
        candidates[4, 3:6] = True

        np.testing.assert_array_equal(
            _safe_propagation_mask(hm, candidates), candidates
        )


if __name__ == "__main__":
    unittest.main()
