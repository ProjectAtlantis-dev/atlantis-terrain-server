import sqlite3
import unittest
import zlib
from unittest import mock

import numpy as np

from bathymetry_health import _point_tile_id
from bathymetry_map import query_bathymetry_map
from coords import to_stereo


class BathymetryMapTests(unittest.TestCase):
    def test_payload_filters_and_offsets_coverage_and_soundings(self):
        db = sqlite3.connect(":memory:")
        db.executescript(
            """
            CREATE TABLE tiles (
                tile_id TEXT PRIMARY KEY, depth INTEGER,
                x_min REAL, y_min REAL, x_max REAL, y_max REAL
            );
            CREATE TABLE bathymetry (
                tile_id TEXT PRIMARY KEY, heightmap BLOB, water_px INTEGER,
                min_z REAL, max_z REAL, source TEXT,
                version INTEGER, updated_at TEXT
            );
            CREATE TABLE soundings (
                source_url TEXT, record_id TEXT, latitude REAL,
                longitude REAL, stereo_x REAL, stereo_y REAL,
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
                evidence_status TEXT NOT NULL DEFAULT 'accepted',
                evidence_format TEXT NOT NULL DEFAULT 'point',
                source_asset TEXT
            );
            """
        )
        qx, qy = to_stereo(64.175, -51.7388)
        near_tile_id = _point_tile_id(12, qx, qy)
        model = zlib.compress(
            np.full((3, 3), -100.0, dtype=np.float32).tobytes()
        )
        db.execute(
            "INSERT INTO tiles VALUES (?, 12, ?, ?, ?, ?)",
            (near_tile_id, qx - 100, qy - 100, qx + 100, qy + 100),
        )
        db.execute(
            "INSERT INTO bathymetry VALUES "
            "(?, ?, 9, -100, -100, 'carve_v1', 1, 'now')",
            (near_tile_id, model),
        )
        db.execute(
            "INSERT INTO tiles VALUES "
            "('12-0-0', 12, ?, ?, ?, ?)",
            (qx + 800, qy + 800, qx + 900, qy + 900),
        )
        db.execute(
            "INSERT INTO bathymetry VALUES "
            "('12-0-0', ?, 9, -100, -100, 'outside_circle', 1, 'now')",
            (model,),
        )
        db.execute(
            "INSERT INTO soundings "
            "(source_url, record_id, latitude, longitude, stereo_x, stereo_y, "
            "depth_m, depth_kind) VALUES "
            "('source', 'near', 64.175, -51.7388, ?, ?, 120, 'actual')",
            (qx, qy),
        )
        db.execute(
            "INSERT INTO soundings "
            "(source_url, record_id, latitude, longitude, stereo_x, stereo_y, "
            "depth_m, depth_kind) VALUES "
            "('source', 'far', 70, -20, 9999999, 9999999, 300, 'at_least')"
        )

        payload = query_bathymetry_map(
            db, qx, qy, 1000, ox=qx - 10, oy=qy - 20,
        )

        self.assertEqual(payload["coverageCount"], 1)
        self.assertEqual(payload["soundingCount"], 1)
        self.assertEqual(payload["coverage"][0]["tileId"], near_tile_id)
        self.assertAlmostEqual(payload["soundings"][0]["x"], 10.0)
        self.assertAlmostEqual(payload["soundings"][0]["y"], 20.0)
        self.assertEqual(payload["soundings"][0]["depthM"], 120.0)
        self.assertEqual(payload["soundings"][0]["sourceUrl"], "source")
        self.assertEqual(payload["soundings"][0]["recordId"], "near")
        self.assertEqual(payload["soundings"][0]["evidenceFormat"], "point")
        self.assertEqual(payload["soundings"][0]["kind"], "actual")
        self.assertEqual(payload["soundings"][0]["modeledDepthM"], 100.0)
        self.assertEqual(payload["soundings"][0]["modelDeltaM"], -20.0)
        self.assertEqual(payload["soundings"][0]["modelErrorM"], 20.0)
        self.assertEqual(payload["soundings"][0]["health"], "yellow")
        self.assertEqual(payload["soundings"][0]["comparisonMethod"], "point")
        self.assertEqual(payload["soundings"][0]["modelSampleCount"], 1)
        self.assertEqual(
            payload["soundings"][0]["evidenceCornersM"],
            [None, None, None, None],
        )

        with mock.patch("bathymetry_map.refresh_sounding_health") as refresh:
            query_bathymetry_map(
                db, qx, qy, 1000, ox=qx - 10, oy=qy - 20,
            )
        refresh.assert_not_called()


if __name__ == "__main__":
    unittest.main()
