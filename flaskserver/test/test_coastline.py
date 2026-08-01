import io
import os
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

import coastline
from coastline import (
    _OVERSAMPLE,
    SHORELINE_SEAFLOOR_DROP_M,
    WATER_FLOOR_DROP_M,
    apply_water_mask,
    cache_official_water_mask,
    fetch_official_water_mask,
    read_hydrography_mask,
    read_water_mask,
    write_water_mask,
    write_hydrography_mask,
)
os.environ.setdefault("DATAFORSYNINGEN_TOKEN", "test-token")
from database import GRID_N, open_db, read_tile, seed_tiles, write_tile
from serve import _mark_official_ocean


def _png_bytes(rgb):
    output = io.BytesIO()
    Image.fromarray(rgb.astype(np.uint8), "RGB").save(output, format="PNG")
    return output.getvalue()


class OfficialCoastlineTest(unittest.TestCase):
    def test_connectivity_signature_is_reused_until_database_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            seed_tiles(db, max_depth=0)
            coastline._connectivity_signature_cache.clear()
            with patch(
                "coastline._connectivity_signature",
                wraps=coastline._connectivity_signature,
            ) as signature:
                coastline._cached_connectivity_signature(db, 0)
                coastline._cached_connectivity_signature(db, 0)
                self.assertEqual(signature.call_count, 1)

                db.execute(
                    "INSERT OR REPLACE INTO metadata (key, value) "
                    "VALUES ('signature-test', 'changed')"
                )
                coastline._cached_connectivity_signature(db, 0)
                self.assertEqual(signature.call_count, 2)
            db.close()

    def test_hydrography_source_has_no_retired_coastline_alias(self):
        self.assertEqual(
            coastline.HYDROGRAPHY_SOURCE,
            "govmin_gl_aabent_land",
        )
        self.assertFalse(hasattr(coastline, "OFFICIAL_COASTLINE_SOURCE"))

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

    def test_drops_water_floor_only_on_water(self):
        heightmap = np.array([[100.0, 20.0], [-10.0, np.nan]], dtype=np.float32)
        water = np.array([[True, False], [False, True]])
        original = heightmap.copy()
        result = apply_water_mask(heightmap, water)
        floor = -WATER_FLOOR_DROP_M
        np.testing.assert_array_equal(
            result, np.array([[floor, 20.0], [-10.0, floor]], dtype=np.float32)
        )
        np.testing.assert_array_equal(heightmap, original)

    def test_water_floor_replaces_retired_deeper_synthetic_values(self):
        heightmap = np.array([[-10.0, -3.0]], dtype=np.float32)
        result = apply_water_mask(
            heightmap, np.array([[True, True]], dtype=bool),
        )
        np.testing.assert_array_equal(
            result,
            np.full(heightmap.shape, -WATER_FLOOR_DROP_M, dtype=np.float32),
        )

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

            tile = read_tile(db, "0-0-0")
            assert tile is not None
            effective = tile["heightmap"]
            np.testing.assert_array_equal(
                effective[:, :10],
                -WATER_FLOOR_DROP_M - SHORELINE_SEAFLOOR_DROP_M,
            )
            np.testing.assert_array_equal(effective[:, 10:], 120.0)
            db.close()

    def test_network_failure_does_not_create_a_mask(self):
        with patch("coastline._fetch_url", side_effect=OSError("offline")):
            self.assertIsNone(fetch_official_water_mask((0, 0, 1, 1), 2))

    def test_hydrography_is_stored_separately_from_tidal_sea(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            seed_tiles(db, max_depth=0)
            hydro = np.array([[True, False], [True, True]], dtype=bool)
            write_hydrography_mask(db, "0-0-0", hydro)

            self.assertIsNone(read_water_mask(db, "0-0-0"))
            np.testing.assert_array_equal(
                read_hydrography_mask(db, "0-0-0"), hydro,
            )
            db.close()

    def test_wms_fallback_is_retained_but_not_returned_as_sea(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            seed_tiles(db, max_depth=0)
            hydro = np.array([[True, False], [True, True]], dtype=bool)
            with (
                patch("gtk50_vector.vector_water_mask", return_value=None),
                patch("coastline.fetch_official_water_mask", return_value=hydro),
            ):
                result = cache_official_water_mask(
                    db, "0-0-0", bbox=(0, 0, 1, 1), resolution=2,
                )

            self.assertIsNone(result)
            self.assertIsNone(read_water_mask(db, "0-0-0"))
            np.testing.assert_array_equal(
                read_hydrography_mask(db, "0-0-0"), hydro,
            )
            db.close()

    def test_schema_v4_moves_existing_wms_masks_out_of_sea_authority(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "terrain.db")
            db = open_db(path)
            seed_tiles(db, max_depth=0)
            hydro = np.array([[True, True], [False, True]], dtype=np.uint8)
            db.execute(
                "INSERT INTO coastline_masks "
                "(tile_id, width, height, mask, source, version, updated_at) "
                "VALUES ('0-0-0', 2, 2, ?, 'govmin_gl_aabent_land', 1, 'now')",
                (zlib.compress(hydro.tobytes()),),
            )
            db.execute(
                "UPDATE metadata SET value = '3' WHERE key = 'schema_version'"
            )
            db.commit()
            db.close()

            db = open_db(path)
            self.assertIsNone(read_water_mask(db, "0-0-0"))
            np.testing.assert_array_equal(
                read_hydrography_mask(db, "0-0-0"), hydro.astype(bool),
            )
            self.assertEqual(
                db.execute(
                    "SELECT value FROM metadata WHERE key = 'schema_version'"
                ).fetchone()[0],
                "18",
            )
            db.close()

    def test_only_hydrography_connected_to_tidal_mask_becomes_effective_sea(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            seed_tiles(db, max_depth=1)
            coast = np.zeros((5, 5), dtype=bool)
            coast[:, -1] = True
            hydro = np.zeros((5, 5), dtype=bool)
            hydro[2, :3] = True  # touches the trusted sea across the tile edge
            hydro[4, 4] = True   # isolated lake/creek dash
            write_water_mask(db, "1-0-0", coast)
            write_hydrography_mask(db, "1-1-0", hydro)

            expected = np.zeros_like(hydro)
            expected[2, :3] = True
            np.testing.assert_array_equal(
                read_water_mask(db, "1-1-0"), expected,
            )
            np.testing.assert_array_equal(
                read_hydrography_mask(db, "1-1-0"), hydro,
            )
            db.close()

    def test_sea_level_tile_seeds_its_hydrography_flood_component(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            seed_tiles(db, max_depth=0)
            raw = np.full((GRID_N, GRID_N), -0.25, dtype=np.float32)
            confidence = np.full(raw.shape, 6, dtype=np.uint8)
            hydro = np.ones(raw.shape, dtype=bool)
            hydro[20:25, 20:25] = False
            write_tile(db, "0-0-0", raw, confidence, "arcticdem_10m")
            write_hydrography_mask(db, "0-0-0", hydro)

            np.testing.assert_array_equal(
                read_water_mask(db, "0-0-0"), hydro,
            )
            tile = read_tile(db, "0-0-0")
            assert tile is not None
            effective = tile["heightmap"]
            np.testing.assert_array_equal(
                effective[hydro],
                -WATER_FLOOR_DROP_M - SHORELINE_SEAFLOOR_DROP_M,
            )
            np.testing.assert_array_equal(effective[~hydro], raw[~hydro])
            db.close()

    def test_coarse_hydrography_overlay_is_assembled_from_stored_children(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            seed_tiles(db, max_depth=1)
            southwest = np.zeros((5, 5), dtype=bool)
            southwest[0, 0] = True
            southeast = np.zeros((5, 5), dtype=bool)
            southeast[0, 0] = True
            southeast[-1, -1] = True
            write_hydrography_mask(db, "1-0-0", southwest)
            write_hydrography_mask(db, "1-1-0", southeast)

            parent = read_hydrography_mask(db, "0-0-0")

            self.assertIsNotNone(parent)
            assert parent is not None
            self.assertTrue(parent[0, 0])
            self.assertTrue(parent[0, 2])
            self.assertTrue(parent[2, 4])
            self.assertEqual(int(parent.sum()), 3)
            db.close()

    def test_marking_official_ocean_preserves_stored_elevation_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            seed_tiles(db, max_depth=0)
            raw = np.full((GRID_N, GRID_N), 37.0, dtype=np.float32)
            confidence = np.full(raw.shape, 6, dtype=np.uint8)
            write_tile(db, "0-0-0", raw, confidence, "arcticdem_10m")
            before = db.execute(
                "SELECT heightmap, confidence_map, geometric_error "
                "FROM tiles WHERE tile_id = '0-0-0'"
            ).fetchone()

            _mark_official_ocean(db, "0-0-0")

            after = db.execute(
                "SELECT heightmap, confidence_map, geometric_error "
                "FROM tiles WHERE tile_id = '0-0-0'"
            ).fetchone()
            self.assertEqual(after, before)
            self.assertEqual(
                db.execute(
                    "SELECT source FROM tiles WHERE tile_id = '0-0-0'"
                ).fetchone()[0],
                "official_coastline",
            )
            db.close()


if __name__ == "__main__":
    unittest.main()
