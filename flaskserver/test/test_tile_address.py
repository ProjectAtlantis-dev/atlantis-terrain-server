import unittest

from tile_address import (
    format_tile_id,
    inset_tile_corners,
    parse_tile_id,
    require_tile_id,
    tile_bounds,
)


class TileAddressTest(unittest.TestCase):
    def test_parse_accepts_canonical_address(self):
        self.assertEqual(parse_tile_id("12-1409-827"), (12, 1409, 827))

    def test_parse_rejects_malformed_or_negative_address(self):
        for value in (
            None,
            12,
            "",
            "12-1",
            "12-1-2-3",
            "depth-1-2",
            "-1-0-0",
            "1--2-0",
        ):
            with self.subTest(value=value):
                self.assertIsNone(parse_tile_id(value))

    def test_require_raises_consistent_error(self):
        with self.assertRaisesRegex(ValueError, "invalid terrain tile id"):
            require_tile_id("not-a-tile")

    def test_format_round_trips_and_rejects_negative_values(self):
        tile_id = format_tile_id(12, 1409, 827)
        self.assertEqual(tile_id, "12-1409-827")
        self.assertEqual(require_tile_id(tile_id), (12, 1409, 827))
        with self.assertRaisesRegex(ValueError, "must be non-negative"):
            format_tile_id(1, -1, 0)

    def test_bounds_and_inset_corners_share_the_canonical_address(self):
        root = (0.0, 0.0, 16.0, 16.0)
        self.assertEqual(tile_bounds("2-1-2", root), (4.0, 8.0, 8.0, 12.0))
        sw, se, nw, ne = inset_tile_corners("2-1-2", root)
        self.assertGreater(sw[0], 4.0)
        self.assertGreater(sw[1], 8.0)
        self.assertLess(se[0], 8.0)
        self.assertLess(nw[1], 12.0)
        self.assertLess(ne[0], 8.0)
        self.assertLess(ne[1], 12.0)

    def test_bounds_reject_an_address_outside_its_depth(self):
        with self.assertRaises(ValueError):
            tile_bounds("2-4-0", (0.0, 0.0, 16.0, 16.0))


if __name__ == "__main__":
    unittest.main()
