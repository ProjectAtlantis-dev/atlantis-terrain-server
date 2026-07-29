import sqlite3
import unittest

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
                tile_id TEXT PRIMARY KEY, source TEXT,
                version INTEGER, updated_at TEXT
            );
            CREATE TABLE soundings (
                source_url TEXT, record_id TEXT, latitude REAL,
                longitude REAL, depth_m REAL, depth_kind TEXT
            );
            """
        )
        qx, qy = to_stereo(64.175, -51.7388)
        db.execute(
            "INSERT INTO tiles VALUES "
            "('12-1-2', 12, ?, ?, ?, ?)",
            (qx - 100, qy - 100, qx + 100, qy + 100),
        )
        db.execute(
            "INSERT INTO bathymetry VALUES "
            "('12-1-2', 'carve_v1', 1, 'now')"
        )
        db.execute(
            "INSERT INTO tiles VALUES "
            "('12-1-3', 12, ?, ?, ?, ?)",
            (qx + 800, qy + 800, qx + 900, qy + 900),
        )
        db.execute(
            "INSERT INTO bathymetry VALUES "
            "('12-1-3', 'outside_circle', 1, 'now')"
        )
        db.execute(
            "INSERT INTO soundings VALUES "
            "('source', 'near', 64.175, -51.7388, 120, 'actual')"
        )
        db.execute(
            "INSERT INTO soundings VALUES "
            "('source', 'far', 70, -20, 300, 'at_least')"
        )

        payload = query_bathymetry_map(
            db, qx, qy, 1000, ox=qx - 10, oy=qy - 20,
        )

        self.assertEqual(payload["coverageCount"], 1)
        self.assertEqual(payload["soundingCount"], 1)
        self.assertEqual(payload["coverage"][0]["tileId"], "12-1-2")
        self.assertAlmostEqual(payload["soundings"][0]["x"], 10.0)
        self.assertAlmostEqual(payload["soundings"][0]["y"], 20.0)
        self.assertEqual(payload["soundings"][0]["depthM"], 120.0)
        self.assertEqual(payload["soundings"][0]["kind"], "actual")


if __name__ == "__main__":
    unittest.main()
