import datetime
import tempfile
import unittest
import zlib
from pathlib import Path

import numpy as np
from scipy.ndimage import binary_dilation

from bathymetry import (
    MAX_SHORE_SLOPE,
    complete_bathymetry_for_water,
    read_bathymetry,
    write_bathymetry,
)
from coastline import (
    SHORELINE_SEAFLOOR_DROP_M,
    WATER_FLOOR_DROP_M,
    write_water_mask,
)
from database import (
    GRID_N,
    _tile_bbox,
    open_db,
    read_tile,
    write_tile,
)
from tile_address import format_tile_id, require_tile_id


def _insert_raw_tile(db, tile_id: str, elevation=100.0) -> np.ndarray:
    depth, column, row = require_tile_id(tile_id)
    bbox = _tile_bbox(depth, column, row)
    parent_id = (
        format_tile_id(depth - 1, column // 2, row // 2)
        if depth > 0
        else None
    )
    db.execute(
        "INSERT INTO tiles "
        "(tile_id, depth, col, row, x_min, y_min, x_max, y_max, "
        "parent_id, geometric_error, source, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'empty', ?)",
        (
            tile_id,
            depth,
            column,
            row,
            *bbox,
            parent_id,
            datetime.datetime.now(datetime.timezone.utc).isoformat(),
        ),
    )
    raw = np.full((GRID_N, GRID_N), elevation, dtype=np.float32)
    confidence = np.full(raw.shape, 6, dtype=np.uint8)
    write_tile(
        db, tile_id, raw, confidence, "arcticdem_10m", reconcile=False,
    )
    return raw


class BathymetryTest(unittest.TestCase):
    def test_valid_bathymetry_overrides_water_floor_but_never_land_or_raw_dem(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            tile_id = "8-10-20"
            raw = _insert_raw_tile(db, tile_id)
            water = np.zeros(raw.shape, dtype=bool)
            water[:, : GRID_N // 2] = True
            raw[10, GRID_N // 2 + 2] = -5.0
            write_tile(
                db, tile_id, raw, np.full(raw.shape, 6, dtype=np.uint8),
                "arcticdem_10m", reconcile=False, allow_overwrite=True,
            )
            write_water_mask(db, tile_id, water)

            db.execute(
                "INSERT INTO terrain_seam_cache "
                "(tile_a, direction, tile_b, edge, updated_at) "
                "VALUES (?, 'east', '8-11-20', ?, 'now')",
                (tile_id, np.zeros(GRID_N, dtype=np.float32).tobytes()),
            )
            db.commit()

            depths = np.full(raw.shape, -120.0, dtype=np.float32)
            depths[5, 5] = np.nan
            depths[6, 6] = 12.0
            depths[7, 7] = 0.0
            write_bathymetry(
                db, tile_id, depths, source="underwater_team", version=1,
            )

            self.assertEqual(
                db.execute(
                    "SELECT COUNT(*) FROM terrain_seam_cache"
                ).fetchone()[0],
                0,
            )
            tile = read_tile(db, tile_id)
            assert tile is not None
            effective = tile["heightmap"]
            self.assertEqual(
                float(effective[0, 0]),
                -120.0 - SHORELINE_SEAFLOOR_DROP_M,
            )
            self.assertEqual(
                float(effective[5, 5]),
                -WATER_FLOOR_DROP_M - SHORELINE_SEAFLOOR_DROP_M,
            )
            self.assertEqual(
                float(effective[6, 6]),
                -120.0 - SHORELINE_SEAFLOOR_DROP_M,
            )
            self.assertEqual(
                float(effective[7, 7]),
                -120.0 - SHORELINE_SEAFLOOR_DROP_M,
            )
            self.assertEqual(
                float(effective[7, GRID_N // 2 - 1]),
                -SHORELINE_SEAFLOOR_DROP_M,
            )
            self.assertEqual(float(effective[0, -1]), 100.0)
            self.assertEqual(float(effective[10, GRID_N // 2 + 2]), 0.0)

            blob = db.execute(
                "SELECT heightmap FROM tiles WHERE tile_id = ?", (tile_id,)
            ).fetchone()[0]
            stored = np.frombuffer(
                zlib.decompress(blob), dtype=np.float32,
            ).reshape(raw.shape)
            np.testing.assert_array_equal(stored, raw)
            db.close()

    def test_fine_water_gaps_are_filled_and_fine_shoreline_is_pinned(self):
        values = np.full((9, 9), -40.0, dtype=np.float32)
        values[:, 6:] = 12.0
        values[4, 4] = 0.0
        values[3, 3] = np.nan
        water = np.zeros(values.shape, dtype=bool)
        water[:, :8] = True

        completed = complete_bathymetry_for_water(
            values, water, cell_size_m=10.0,
        )

        shore = water & binary_dilation(
            ~water, structure=np.ones((3, 3), dtype=bool),
        )
        self.assertTrue(np.all(completed[shore] == 0.0))
        finite_interior = water & ~shore & np.isfinite(completed)
        self.assertTrue(np.all(completed[finite_interior] < 0.0))
        self.assertTrue(np.isnan(completed[3, 3]))
        self.assertTrue(np.all(completed[~water] == values[~water]))
        distance_steps = np.arange(7, 0, -1, dtype=np.float32)
        self.assertTrue(
            np.all(
                -completed[4, :7]
                <= MAX_SHORE_SLOPE * distance_steps * 10.0 + 1e-5
            )
        )

    def test_completion_does_not_cross_land_into_unsupported_water(self):
        values = np.full((9, 9), 20.0, dtype=np.float32)
        water = np.zeros(values.shape, dtype=bool)
        water[1:4, 1:4] = True
        water[5:8, 5:8] = True
        values[2, 2] = -30.0

        completed = complete_bathymetry_for_water(
            values, water, cell_size_m=10.0,
        )

        self.assertTrue(np.all(completed[5:8, 5:8] == 20.0))

    def test_depth_8_bathymetry_is_cropped_and_resampled_for_descendants(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            source_id = "8-10-20"
            target_id = "10-41-82"  # depth-8 quadrant offset (1, 2) of 4
            _insert_raw_tile(db, source_id)
            _insert_raw_tile(db, target_id)
            write_water_mask(
                db, target_id, np.ones((GRID_N, GRID_N), dtype=bool),
            )

            source_rows = np.arange(GRID_N, dtype=np.float32)[:, None]
            source_columns = np.arange(GRID_N, dtype=np.float32)[None, :]
            depths = -(source_rows * 10.0 + source_columns)
            write_bathymetry(
                db, source_id, depths, source="underwater_team", version=1,
            )

            sampled = read_bathymetry(db, target_id, (GRID_N, GRID_N))
            self.assertIsNotNone(sampled)
            assert sampled is not None
            expected_rows = np.linspace(32.0, 48.0, GRID_N)[:, None]
            expected_columns = np.linspace(16.0, 32.0, GRID_N)[None, :]
            expected = -(expected_rows * 10.0 + expected_columns)
            np.testing.assert_allclose(sampled, expected, atol=1e-5)

            tile = read_tile(db, target_id)
            assert tile is not None
            np.testing.assert_allclose(
                tile["heightmap"],
                expected - SHORELINE_SEAFLOOR_DROP_M,
                atol=1e-5,
            )
            db.close()

    def test_all_water_tile_without_a_raw_dem_still_uses_bathymetry(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            tile_id = "8-10-20"
            _insert_raw_tile(db, tile_id)
            db.execute(
                "UPDATE tiles SET heightmap = NULL, confidence_map = NULL "
                "WHERE tile_id = ?",
                (tile_id,),
            )
            db.commit()
            write_water_mask(
                db, tile_id, np.ones((GRID_N, GRID_N), dtype=bool),
            )
            write_bathymetry(
                db,
                tile_id,
                np.full((GRID_N, GRID_N), -40.0, dtype=np.float32),
                source="underwater_team",
                version=1,
            )

            tile = read_tile(db, tile_id)
            assert tile is not None
            np.testing.assert_array_equal(
                tile["heightmap"], -40.0 - SHORELINE_SEAFLOOR_DROP_M,
            )
            db.close()

    def test_coarse_tile_uses_available_descendant_bathymetry_and_floor_elsewhere(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            target_id = "7-10-20"
            source_id = "8-20-40"  # southwest child of the target
            _insert_raw_tile(db, target_id)
            _insert_raw_tile(db, source_id)
            write_water_mask(
                db, target_id, np.ones((GRID_N, GRID_N), dtype=bool),
            )
            write_bathymetry(
                db,
                source_id,
                np.full((GRID_N, GRID_N), -80.0, dtype=np.float32),
                source="underwater_team",
                version=1,
            )

            tile = read_tile(db, target_id)
            assert tile is not None
            effective = tile["heightmap"]
            self.assertEqual(
                float(effective[0, 0]),
                -80.0 - SHORELINE_SEAFLOOR_DROP_M,
            )
            self.assertEqual(
                float(effective[-1, -1]),
                -WATER_FLOOR_DROP_M - SHORELINE_SEAFLOOR_DROP_M,
            )
            db.close()

    def test_schema_exposes_the_underwater_team_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            columns = {
                row[1] for row in db.execute("PRAGMA table_info(bathymetry)")
            }
            self.assertEqual(
                columns,
                {
                    "tile_id",
                    "heightmap",
                    "water_px",
                    "min_z",
                    "max_z",
                    "source",
                    "version",
                    "updated_at",
                },
            )
            self.assertEqual(
                db.execute(
                    "SELECT value FROM metadata WHERE key = 'schema_version'"
                ).fetchone(),
                ("18",),
            )
            db.close()


if __name__ == "__main__":
    unittest.main()
