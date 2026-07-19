import unittest

import numpy as np

from classifier.rendering import smooth_effective_water_mask


class ClassifierRenderingTest(unittest.TestCase):
    def test_water_boundary_is_reconstructed_at_output_resolution(self):
        # South-first source with a one-cell diagonal coastline.
        water = np.asarray(
            [
                [True, True, True],
                [False, True, True],
                [False, False, True],
            ],
            dtype=bool,
        )

        rendered = smooth_effective_water_mask(water, 12, 12)

        self.assertEqual(rendered.dtype, np.bool_)
        self.assertEqual(rendered.shape, (12, 12))
        # Nearest-neighbor expansion changes only in four-pixel blocks. The
        # interpolated midpoint boundary must contain output-pixel transitions.
        transition_rows = np.flatnonzero(np.any(rendered[1:] != rendered[:-1], axis=1))
        self.assertTrue(np.any(transition_rows % 4 != 3))

    def test_water_mask_is_flipped_to_image_orientation(self):
        water = np.asarray([[True, True], [False, False]], dtype=bool)

        rendered = smooth_effective_water_mask(water, 8, 8)

        self.assertFalse(rendered[0].any())
        self.assertTrue(rendered[-1].all())


if __name__ == "__main__":
    unittest.main()
