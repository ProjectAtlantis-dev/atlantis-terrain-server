import io
import os
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

from coastline import (
    _OVERSAMPLE,
    apply_water_mask,
    fetch_official_water_mask,
    read_water_mask,
    write_water_mask,
)
os.environ.setdefault("DATAFORSYNINGEN_TOKEN", "test-token")
from database import GRID_N, open_db, read_tile, seed_tiles, write_tile


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
        original = heightmap.copy()
        result = apply_water_mask(heightmap, water)
        np.testing.assert_array_equal(
            result, np.array([[0.0, 20.0], [50.0, 0.0]], dtype=np.float32)
        )
        np.testing.assert_array_equal(heightmap, original)

    def test_database_preserves_raw_dem_and_masks_only_the_read_view(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            seed_tiles(db, max_depth=0)
            raw = np.full((GRID_N, GRID_N), 120.0, dtype=np.float32)
            confidence = np.full(raw.shape, 6, dtype=np.uint8)
            water = np.zeros(raw.shape, dtype=bool)
            water[:, :10] = True
            write_tile(db, "0-0-0", raw, confidence, "arcticdem_10m")
            db.execute(
                "INSERT INTO terrain_seam_cache "
                "(tile_a, direction, tile_b, edge, updated_at) "
                "VALUES ('0-0-0', 'east', '0-1-0', ?, 'now')",
                (np.zeros(GRID_N, dtype=np.float32).tobytes(),),
            )
            write_water_mask(db, "0-0-0", water)

            self.assertEqual(
                db.execute("SELECT count(*) FROM terrain_seam_cache").fetchone()[0],
                0,
            )

            blob = db.execute(
                "SELECT heightmap FROM tiles WHERE tile_id = '0-0-0'"
            ).fetchone()[0]
            stored_raw = np.frombuffer(
                zlib.decompress(blob), dtype=np.float32
            ).reshape(raw.shape)
            np.testing.assert_array_equal(stored_raw, raw)
            np.testing.assert_array_equal(read_water_mask(db, "0-0-0"), water)

            effective = read_tile(db, "0-0-0")["heightmap"]
            np.testing.assert_array_equal(effective[:, :10], 0.0)
            np.testing.assert_array_equal(effective[:, 10:], 120.0)
            db.close()

    def test_network_failure_does_not_create_a_mask(self):
        with patch("coastline._fetch_url", side_effect=OSError("offline")):
            self.assertIsNone(fetch_official_water_mask((0, 0, 1, 1), 2))


if __name__ == "__main__":
    unittest.main()
