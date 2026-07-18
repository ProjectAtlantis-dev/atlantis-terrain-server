import io
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

from coastline import (
    _OVERSAMPLE,
    apply_official_coastline,
    fetch_official_water_mask,
)


def _png_bytes(rgb):
    output = io.BytesIO()
    Image.fromarray(rgb.astype(np.uint8), "RGB").save(output, format="PNG")
    return output.getvalue()


class OfficialCoastlineTest(unittest.TestCase):
    def test_oversampling_rejects_cartographic_lines_and_label_holes(self):
        resolution = 3
        size = resolution * _OVERSAMPLE
        land = np.array([215, 224, 216], dtype=np.uint8)
        water = np.array([165, 220, 252], dtype=np.uint8)
        rgb = np.full((size, size, 3), land, dtype=np.uint8)
        # North two image cells are sea; south image cell is land.
        rgb[: 2 * _OVERSAMPLE] = water
        # A dark label stroke through the sea and a thin blue contour on land
        # must not change the aggregate classification.
        rgb[3:5, :] = (60, 60, 60)
        rgb[-2:, :] = (60, 160, 220)

        with patch("coastline._fetch_url", return_value=_png_bytes(rgb)):
            mask = fetch_official_water_mask((0, 0, 1, 1), resolution)

        self.assertIsNotNone(mask)
        np.testing.assert_array_equal(
            mask,
            np.array(
                [[False, False, False], [True, True, True], [True, True, True]]
            ),
        )

    def test_applies_sea_level_only_to_water(self):
        heightmap = np.array([[100.0, 20.0], [50.0, np.nan]], dtype=np.float32)
        water = np.array([[True, False], [False, True]])
        with patch("coastline.fetch_official_water_mask", return_value=water):
            result, applied = apply_official_coastline(
                heightmap, (0, 0, 1, 1), 2
            )
        self.assertTrue(applied)
        np.testing.assert_array_equal(
            result, np.array([[0.0, 20.0], [50.0, 0.0]], dtype=np.float32)
        )

    def test_only_all_water_can_resolve_a_missing_dem(self):
        with patch(
            "coastline.fetch_official_water_mask",
            return_value=np.ones((2, 2), dtype=bool),
        ):
            result, applied = apply_official_coastline(None, (0, 0, 1, 1), 2)
        self.assertTrue(applied)
        np.testing.assert_array_equal(result, np.zeros((2, 2), dtype=np.float32))

        partial = np.array([[True, False], [True, True]])
        with patch("coastline.fetch_official_water_mask", return_value=partial):
            result, applied = apply_official_coastline(None, (0, 0, 1, 1), 2)
        self.assertIsNone(result)
        self.assertFalse(applied)

    def test_network_failure_is_fail_open(self):
        original = np.ones((2, 2), dtype=np.float32)
        with patch("coastline.fetch_official_water_mask", return_value=None):
            result, applied = apply_official_coastline(
                original, (0, 0, 1, 1), 2
            )
        self.assertFalse(applied)
        np.testing.assert_array_equal(result, original)


if __name__ == "__main__":
    unittest.main()
