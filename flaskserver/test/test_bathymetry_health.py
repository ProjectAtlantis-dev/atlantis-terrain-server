import sqlite3
import unittest
import zlib

import numpy as np

from bathymetry_health import (
    _point_tile_id,
    comparison_error,
    health_for_error,
    refresh_sounding_health,
)
from database import _tile_bbox


class BathymetryHealthTests(unittest.TestCase):
    def test_health_has_only_white_yellow_red_semantics(self):
        self.assertEqual(health_for_error(5, 100), "white")
        self.assertEqual(health_for_error(15, 100), "yellow")
        self.assertEqual(health_for_error(30, 100), "red")

    def test_lower_bound_only_penalizes_a_model_that_is_too_shallow(self):
        self.assertEqual(comparison_error(120, 100, "at_least"), (20, 0))
        self.assertEqual(comparison_error(80, 100, "at_least"), (-20, 20))
        self.assertEqual(comparison_error(120, 100, "actual"), (20, 20))

    def test_refresh_persists_model_comparison_with_sounding(self):
        db = sqlite3.connect(":memory:")
        db.executescript(
            """
            CREATE TABLE tiles (
                tile_id TEXT PRIMARY KEY, depth INTEGER, col INTEGER, row INTEGER,
                x_min REAL, y_min REAL, x_max REAL, y_max REAL
            );
            CREATE TABLE bathymetry (
                tile_id TEXT PRIMARY KEY, heightmap BLOB, source TEXT,
                version INTEGER, updated_at TEXT
            );
            CREATE TABLE soundings (
                source_url TEXT, record_id TEXT, stereo_x REAL, stereo_y REAL,
                depth_m REAL, depth_kind TEXT, modeled_depth_m REAL,
                model_delta_m REAL, model_error_m REAL, model_health TEXT,
                model_tile_id TEXT, model_source TEXT, model_version INTEGER,
                model_updated_at TEXT, modeled_sw_m REAL, modeled_se_m REAL,
                modeled_nw_m REAL, modeled_ne_m REAL,
                evidence_sw_m REAL, evidence_se_m REAL, evidence_nw_m REAL,
                evidence_ne_m REAL, comparison_method TEXT DEFAULT 'point',
                model_sample_count INTEGER, model_signature TEXT,
                comparison_revision INTEGER NOT NULL DEFAULT 0,
                compared_at TEXT,
                evidence_status TEXT NOT NULL DEFAULT 'accepted'
            );
            """
        )
        depth, column, row = 8, 87, 50
        tile_id = f"{depth}-{column}-{row}"
        x0, y0, x1, y1 = _tile_bbox(depth, column, row)
        x, y = (x0 + x1) / 2, (y0 + y1) / 2
        self.assertEqual(_point_tile_id(depth, x, y), tile_id)
        model = np.full((3, 3), -80.0, dtype=np.float32)
        db.execute(
            "INSERT INTO tiles VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (tile_id, depth, column, row, x0, y0, x1, y1),
        )
        db.execute(
            "INSERT INTO bathymetry VALUES (?, ?, 'carve', 2, 'model-v2')",
            (tile_id, zlib.compress(model.tobytes())),
        )
        db.execute(
            "INSERT INTO soundings "
            "(source_url, record_id, stereo_x, stereo_y, depth_m, depth_kind) "
            "VALUES ('evidence', 'actual', ?, ?, 100, 'actual')",
            (x, y),
        )

        self.assertEqual(refresh_sounding_health(db, tile_id=tile_id), 1)
        self.assertEqual(
            db.execute(
                "SELECT modeled_depth_m, model_delta_m, model_error_m, "
                "model_health, model_tile_id, model_source, model_version, "
                "model_updated_at, compared_at FROM soundings"
            ).fetchone()[:-1],
            (80.0, -20.0, 20.0, "yellow", tile_id, "carve", 2, "model-v2"),
        )
        self.assertIsNotNone(
            db.execute("SELECT compared_at FROM soundings").fetchone()[0]
        )
        self.assertEqual(
            db.execute(
                "SELECT comparison_method, model_sample_count FROM soundings"
            ).fetchone(),
            ("point", 1),
        )
        self.assertEqual(refresh_sounding_health(db, tile_id=tile_id), 0)

    def test_raster_health_is_rms_of_matched_tile_corners(self):
        db = sqlite3.connect(":memory:")
        db.executescript(
            """
            CREATE TABLE tiles (
                tile_id TEXT PRIMARY KEY, depth INTEGER, col INTEGER, row INTEGER,
                x_min REAL, y_min REAL, x_max REAL, y_max REAL
            );
            CREATE TABLE bathymetry (
                tile_id TEXT PRIMARY KEY, heightmap BLOB, source TEXT,
                version INTEGER, updated_at TEXT
            );
            CREATE TABLE soundings (
                source_url TEXT, record_id TEXT, stereo_x REAL, stereo_y REAL,
                depth_m REAL, depth_kind TEXT, modeled_depth_m REAL,
                model_delta_m REAL, model_error_m REAL, model_health TEXT,
                model_tile_id TEXT, model_source TEXT, model_version INTEGER,
                model_updated_at TEXT, modeled_sw_m REAL, modeled_se_m REAL,
                modeled_nw_m REAL, modeled_ne_m REAL,
                evidence_sw_m REAL, evidence_se_m REAL, evidence_nw_m REAL,
                evidence_ne_m REAL, comparison_method TEXT DEFAULT 'point',
                model_sample_count INTEGER, model_signature TEXT,
                comparison_revision INTEGER NOT NULL DEFAULT 0,
                compared_at TEXT,
                evidence_status TEXT NOT NULL DEFAULT 'accepted'
            );
            """
        )
        depth, column, row = 8, 87, 50
        tile_id = f"{depth}-{column}-{row}"
        x0, y0, x1, y1 = _tile_bbox(depth, column, row)
        model = -np.array(
            [
                [80.0, 85.0, 90.0],
                [90.0, 95.0, 100.0],
                [100.0, 105.0, 110.0],
            ],
            dtype=np.float32,
        )
        db.execute(
            "INSERT INTO tiles VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (tile_id, depth, column, row, x0, y0, x1, y1),
        )
        db.execute(
            "INSERT INTO bathymetry VALUES (?, ?, 'carve', 2, 'model-v2')",
            (tile_id, zlib.compress(model.tobytes())),
        )
        db.execute(
            "INSERT INTO soundings "
            "(source_url, record_id, stereo_x, stereo_y, depth_m, depth_kind, "
            "evidence_sw_m, evidence_se_m, evidence_nw_m, evidence_ne_m, "
            "comparison_method) VALUES "
            "('evidence', ?, ?, ?, 100, 'actual', 100, 100, 100, 100, "
            "'corner_rms')",
            (tile_id, (x0 + x1) / 2, (y0 + y1) / 2),
        )

        self.assertEqual(refresh_sounding_health(db, tile_id=tile_id), 1)
        row = db.execute(
            "SELECT modeled_depth_m, model_delta_m, model_error_m, "
            "model_health, modeled_sw_m, modeled_se_m, modeled_nw_m, "
            "modeled_ne_m, model_sample_count, model_tile_id FROM soundings"
        ).fetchone()
        self.assertAlmostEqual(row[0], 95.0, places=4)
        self.assertAlmostEqual(row[1], -5.0, places=4)
        self.assertAlmostEqual(row[2], np.sqrt(150.0), places=4)
        self.assertEqual(row[3], "yellow")
        np.testing.assert_allclose(row[4:8], [80, 90, 100, 110], atol=1e-4)
        self.assertEqual(row[8:], (4, tile_id))


if __name__ == "__main__":
    unittest.main()
