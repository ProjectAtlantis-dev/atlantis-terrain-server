"""Physics-first classification inside the fractal cook."""

import unittest

import numpy as np

from cook_classifier import (
    DARK, GREEN, GREY, WATER, WHITE,
    SLOPE_ROCK_MIN,
    classify_cooked_quad,
)

N = 65
SIZE = 512
BBOX = (0.0, 0.0, 659.18, 659.18)
GREEN_RGB = (90, 150, 70)


def _flat_surface():
    return np.zeros((129, 129), dtype=np.float32)


def _north_rising_surface(rise_per_cell):
    """South-first rows rising northward → south-facing (southness > 0)."""
    cell = BBOX[2] / 128.0
    rows = np.arange(129, dtype=np.float32) * rise_per_cell * cell
    return np.repeat(rows[:, None], 129, axis=1)


def _uniform_rgb(color):
    return np.tile(np.asarray(color, np.uint8), (256, 256, 1))


class CookClassifierTest(unittest.TestCase):
    def test_green_survives_only_on_gentle_south_faces(self):
        rgb = _uniform_rgb(GREEN_RGB)

        south_gentle = _north_rising_surface(0.2)   # southness > 0, slope 0.2
        labels, _, _ = classify_cooked_quad(rgb, south_gentle, BBOX)
        self.assertEqual(labels[SIZE // 2, SIZE // 2], GREEN)

        south_steep = _north_rising_surface(0.6)    # south-facing but steep
        labels, _, _ = classify_cooked_quad(rgb, south_steep, BBOX)
        self.assertEqual(labels[SIZE // 2, SIZE // 2], GREY)

        north_gentle = _north_rising_surface(-0.2)  # gentle but north-facing
        labels, _, _ = classify_cooked_quad(rgb, north_gentle, BBOX)
        self.assertEqual(labels[SIZE // 2, SIZE // 2], GREY)

    def test_steep_ground_is_bare_rock_whatever_the_imagery_says(self):
        cliff = _north_rising_surface(SLOPE_ROCK_MIN + 0.3)
        for color in ((240, 240, 240), GREEN_RGB):
            labels, _, _ = classify_cooked_quad(_uniform_rgb(color), cliff, BBOX)
            self.assertEqual(labels[SIZE // 2, SIZE // 2], GREY)

    def test_color_proposals_hold_on_flat_ground(self):
        flat = _flat_surface()
        cases = (
            ((240, 240, 240), WHITE),
            ((30, 30, 30), DARK),
            ((128, 128, 128), GREY),
        )
        for color, expected in cases:
            labels, _, _ = classify_cooked_quad(_uniform_rgb(color), flat, BBOX)
            self.assertEqual(labels[SIZE // 2, SIZE // 2], expected)

    def test_water_mask_outranks_everything_and_carries_no_detail(self):
        mask = np.zeros((N, N), dtype=bool)
        mask[:, : N // 2] = True  # western half water (orientation-neutral)
        labels, amplitude, _ = classify_cooked_quad(
            _uniform_rgb(GREEN_RGB), _flat_surface(), BBOX, water_mask=mask
        )
        self.assertEqual(labels[SIZE // 2, SIZE // 4], WATER)
        self.assertEqual(amplitude[SIZE // 2, SIZE // 4], 0.0)
        self.assertEqual(labels[SIZE // 2, 3 * SIZE // 4], GREEN)

    def test_detail_energy_orders_rock_above_vegetation(self):
        steep_rock = _north_rising_surface(0.8)
        _, rock_amp, rock_char = classify_cooked_quad(
            _uniform_rgb((128, 128, 128)), steep_rock, BBOX
        )
        _, veg_amp, veg_char = classify_cooked_quad(
            _uniform_rgb(GREEN_RGB), _north_rising_surface(0.15), BBOX
        )
        center = (SIZE // 2, SIZE // 2)
        self.assertGreater(rock_amp[center], veg_amp[center])
        self.assertGreater(rock_char[center], veg_char[center])
        self.assertLessEqual(veg_char[center], 0.3)


if __name__ == "__main__":
    unittest.main()
