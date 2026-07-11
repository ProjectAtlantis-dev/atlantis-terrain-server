import unittest

import numpy as np

from bathymetry import (
    CLIFF_TOL_M,
    OCEAN_LEVEL_M,
    _erode_cliffs,
    _safe_propagation_mask,
    flatten_fake_bathymetry,
)

WATER_RGB = (10, 22, 20)  # shadowed fjord water/rock — passes water_mask


def _boundary_step_increase(old, new, captured):
    """Largest increase of a capture-boundary step introduced by the flatten."""
    worst = 0.0
    n = old.shape[0]
    for r, c in zip(*np.nonzero(captured)):
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            rr, cc = r + dr, c + dc
            if 0 <= rr < n and 0 <= cc < n and not captured[rr, cc]:
                before = old[rr, cc] - old[r, c]
                after = new[rr, cc] - new[r, c]
                worst = max(worst, after - before)
    return worst


class NoNewCliffInvariantTests(unittest.TestCase):
    def test_erodes_high_overcapture_back_to_low_ground(self):
        # cols 1-2 low fake water, col 3 low berm toe, col 4 high shoulder
        # merging into real terrain (cols 5+). The high shoulder must be
        # peeled (flattening it would create a step the DEM never had); the
        # low samples stay flattenable.
        hm = np.zeros((7, 7), dtype=np.float32)
        hm[:, 3] = 6.0
        hm[:, 4] = 18.0
        hm[:, 5:] = 40.0
        captured = np.zeros_like(hm, dtype=bool)
        captured[:, 1:5] = True

        safe = _erode_cliffs(hm, captured)

        self.assertTrue(safe[:, 1:4].all())
        self.assertFalse(safe[:, 4:].any())

    def test_low_capture_survives_at_wall_foot(self):
        # Fjord water directly against a 200 m wall: the step pre-exists in
        # the DEM, flattening the water must NOT be rejected (this was the
        # total-miss failure on 12-1408-770).
        hm = np.zeros((7, 7), dtype=np.float32)
        hm[:, 2] = 3.0
        hm[:, 3:] = 200.0
        captured = np.zeros_like(hm, dtype=bool)
        captured[:, 0:3] = True

        np.testing.assert_array_equal(_erode_cliffs(hm, captured), captured)

    def test_valley_moat_stops_peel_and_berm_flattens(self):
        # Classic fake profile: sea | berm crest (40 m) | valley (2 m) |
        # real wall (200 m). The peel from the wall must stop at the low
        # valley so the whole berm still flattens.
        hm = np.zeros((7, 7), dtype=np.float32)
        hm[:, 2:4] = 40.0   # berm crest
        hm[:, 4] = 2.0      # valley moat
        hm[:, 5:] = 200.0   # real terrain
        captured = np.zeros_like(hm, dtype=bool)
        captured[:, 0:5] = True

        np.testing.assert_array_equal(_erode_cliffs(hm, captured), captured)

    def test_elevated_moat_stops_peel_and_apron_flattens(self):
        # 12-1408-770 signature: the fake apron's moat floor sits ABOVE
        # CLIFF_TOL (here 10 m) and the berm rises gradually seaward. The
        # downhill peel restores the real flank (cols 1-3) but its rise
        # budget cannot climb the berm — the apron (cols 4-6) still
        # flattens, however high.
        hm = np.tile(np.array(
            [200.0, 14.0, 10.0, 12.0, 14.0, 20.0, 25.0, 0.0],
            dtype=np.float32), (7, 1))
        captured = np.zeros((7, 8), dtype=bool)
        captured[:, 1:7] = True

        safe = _erode_cliffs(hm, captured)

        self.assertFalse(safe[:, 1:4].any())  # real flank restored
        self.assertTrue(safe[:, 4:7].all())   # apron past the moat flattens

    def test_monotone_slope_is_restored_through_seam_edges(self):
        # A shadowed real slope rising to the tile edge, higher terrain
        # beyond the seam (the 11-703-385 carve): with neighbor edges the
        # peel starts at the seam and eats the whole high capture back to
        # low ground.
        hm = np.tile(np.array([0, 0, 4, 20, 40, 70, 95], dtype=np.float32), (7, 1))
        captured = np.zeros_like(hm, dtype=bool)
        captured[:, 2:] = True
        edges = {'E': np.full(7, 110.0, dtype=np.float32),
                 'N': None, 'S': None, 'W': None}

        safe = _erode_cliffs(hm, captured, edges=edges)

        self.assertTrue(safe[:, 2].all())     # low toe may flatten
        self.assertFalse(safe[:, 3:].any())   # high slope restored
        # without the seam edges the old blind spot would keep everything
        np.testing.assert_array_equal(_erode_cliffs(hm, captured), captured)

    def test_large_textured_water_region_is_not_peeled(self):
        # Apron leaning directly against a fjord wall (no moat): geometry
        # alone would restore it as a "flank", but the imagery says textured
        # water (visible seabed = the very texture that faked the DEM). A
        # large coherent textured region in the peel is cancelled, so the
        # apron flattens.
        hm = np.tile(np.array(
            [200.0, 60.0, 40.0, 25.0, 15.0, 0.0], dtype=np.float32), (12, 1))
        captured = np.zeros((12, 6), dtype=bool)
        captured[:, 1:5] = True  # 48 px > HOLE_MAX_PX
        peelable = np.zeros_like(captured)  # all textured water

        safe = _erode_cliffs(hm, captured, peelable=peelable)

        np.testing.assert_array_equal(safe, captured)
        # sanity: with everything peelable the same profile is a real flank
        self.assertFalse(_erode_cliffs(hm, captured).any())

    def test_small_textured_pocket_absorbs_into_restored_flank(self):
        # A few textured pixels inside a smooth shadow flank (semi-lit rock)
        # must not survive as sea-level craters in restored terrain.
        hm = np.tile(np.array(
            [200.0, 60.0, 40.0, 25.0, 15.0, 0.0], dtype=np.float32), (6, 1))
        captured = np.zeros((6, 6), dtype=bool)
        captured[:, 1:5] = True
        peelable = np.ones_like(captured)
        peelable[2:4, 2:4] = False  # 4-px textured pocket

        self.assertFalse(_erode_cliffs(hm, captured, peelable=peelable).any())

    def test_full_flattener_cannot_carve_high_real_terrain(self):
        hm = np.zeros((9, 9), dtype=np.float32)
        hm[:, 2] = 5.0
        hm[:, 3] = 15.0
        hm[:, 4:] = 200.0
        px = np.zeros((9, 9, 3), dtype=np.uint8)
        px[:, :4] = WATER_RGB  # dark water color over-captures the real slope

        new, captured = flatten_fake_bathymetry(hm, px)

        self.assertFalse(captured[:, 3:].any())
        self.assertTrue(np.all(new[captured] == OCEAN_LEVEL_M))
        # the flatten may stand beside pre-existing steps but must not
        # manufacture new ones beyond tolerance
        self.assertLessEqual(
            _boundary_step_increase(hm, new, captured), CLIFF_TOL_M)

    def test_full_flattener_output_preserves_uncaptured_samples(self):
        hm = np.zeros((9, 9), dtype=np.float32)
        hm[:, 4:] = 200.0
        hm[:, 2] = 30.0  # berm in open water, bright crest
        px = np.full((9, 9, 3), WATER_RGB, dtype=np.uint8)
        px[:, 4:] = (120, 110, 90)  # lit rock

        new, captured = flatten_fake_bathymetry(hm, px)

        self.assertTrue(captured[:, 2].all())  # ocean seeds aren't "captured"
        self.assertTrue(np.all(new[:, 2] == OCEAN_LEVEL_M))
        np.testing.assert_array_equal(new[~captured], hm[~captured])


class PropagationGuardTests(unittest.TestCase):
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
