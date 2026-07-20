import unittest

import numpy as np

from classifier.rendering import paint_navy_water_shadows, smooth_effective_water_mask


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

    def test_navy_shadow_is_green_but_equally_dark_teal_stays_pink(self):
        pink = (255, 42, 161)
        classifier = np.asarray(
            [[pink, pink, (150, 225, 60)]], dtype=np.uint8
        )
        satellite = np.asarray(
            [[(10, 30, 37), (10, 37, 40), (0, 0, 20)]], dtype=np.uint8
        )

        painted, shadow = paint_navy_water_shadows(classifier, satellite)

        np.testing.assert_array_equal(
            shadow, np.asarray([[True, False, False]])
        )
        np.testing.assert_array_equal(painted[0, 0], (0, 255, 0))
        np.testing.assert_array_equal(painted[0, 1], pink)
        np.testing.assert_array_equal(painted[0, 2], (150, 225, 60))


if __name__ == "__main__":
    unittest.main()
