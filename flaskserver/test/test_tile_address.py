import unittest

from tile_address import format_tile_id, parse_tile_id, require_tile_id


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


if __name__ == "__main__":
    unittest.main()
