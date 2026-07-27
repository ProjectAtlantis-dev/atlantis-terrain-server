import unittest

from database import _tile_bbox
from terrain_config import GREENLAND_BBOX


class TerrainConfigTest(unittest.TestCase):
    def test_root_bbox_is_the_canonical_tile_extent(self):
        self.assertEqual(
            GREENLAND_BBOX,
            (-1239041.5, -3346077.5, 1460958.5, -646077.5),
        )
        self.assertEqual(_tile_bbox(0, 0, 0), GREENLAND_BBOX)

    def test_tile_bbox_subdivides_the_configured_extent(self):
        x_min, y_min, x_max, y_max = GREENLAND_BBOX
        midpoint_x = (x_min + x_max) / 2
        midpoint_y = (y_min + y_max) / 2
        self.assertEqual(
            _tile_bbox(1, 0, 0),
            (x_min, y_min, midpoint_x, midpoint_y),
        )
        self.assertEqual(
            _tile_bbox(1, 1, 1),
            (midpoint_x, midpoint_y, x_max, y_max),
        )


if __name__ == "__main__":
    unittest.main()

