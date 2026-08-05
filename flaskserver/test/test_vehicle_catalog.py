import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from vehicle_catalog import load_vehicle_assets, save_vehicle_state


SCHEMA = """
CREATE TABLE assets (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, enabled INTEGER NOT NULL,
  lat REAL NOT NULL, lon REAL NOT NULL, heading_deg REAL NOT NULL,
  z REAL, properties TEXT NOT NULL, saved_at REAL, updated_at TEXT,
  cx REAL, cy REAL, min_x REAL, min_y REAL, max_x REAL, max_y REAL
);
"""


class VehicleCatalogTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript(SCHEMA)
        self.metadata = {
            "vehicle_asset_type": "vehicle",
            "vehicle_definition": {
                "url": "/vehicle.glb",
                "headlights": {"color": "#ffd080"},
            },
            "seed_vehicle_instances": [{
                "id": "amv-01", "lat": 64.1, "lon": -51.7,
                "headingDeg": 15, "z": 22, "headlightsOn": False,
                "terrainDepth": 12, "terrainTileId": "12-1-2",
            }],
        }

    def tearDown(self):
        self.db.close()

    def test_load_seeds_and_normalizes_vehicle_assets(self):
        seeded, definition, instances = load_vehicle_assets(self.db, self.metadata)
        self.assertTrue(seeded)
        self.assertEqual(definition["headlights"]["color"], 0xFFD080)
        self.assertEqual(instances[0]["id"], "amv-01")
        self.assertEqual(instances[0]["z"], 22)
        self.assertFalse(instances[0]["headlightsOn"])
        self.assertEqual(instances[0]["terrainTileId"], "12-1-2")

        seeded_again, _, _ = load_vehicle_assets(self.db, self.metadata)
        self.assertFalse(seeded_again)

    def test_save_updates_the_existing_vehicle_and_preserves_headlights(self):
        load_vehicle_assets(self.db, self.metadata)
        with tempfile.TemporaryDirectory() as directory:
            metadata_path = Path(directory) / "assets.json"
            metadata_path.write_text(json.dumps(self.metadata), encoding="utf-8")
            payload, status = save_vehicle_state(
                self.db,
                {
                    "lat": 65.0, "lon": -50.0, "headingDeg": 375,
                    "z": 30, "terrainDepth": 13, "terrainTileId": "13-2-4",
                },
                metadata_path,
            )

        self.assertEqual(status, 200)
        self.assertEqual(payload["vehicleId"], "amv-01")
        self.assertEqual(payload["state"]["headingDeg"], 15)
        row = self.db.execute(
            "SELECT lat,lon,heading_deg,z,properties FROM assets WHERE id='amv-01'"
        ).fetchone()
        self.assertEqual(row[:4], (65.0, -50.0, 15.0, 30.0))
        properties = json.loads(row[4])
        self.assertFalse(properties["headlightsOn"])
        self.assertEqual(properties["terrainTileId"], "13-2-4")

    def test_save_rejects_invalid_coordinates_without_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata_path = Path(directory) / "assets.json"
            metadata_path.write_text(json.dumps(self.metadata), encoding="utf-8")
            payload, status = save_vehicle_state(
                self.db, {"lat": "nan", "lon": 0, "headingDeg": 0},
                metadata_path,
            )
        self.assertEqual(status, 400)
        self.assertIn("coordinates", payload["error"])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM assets").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
