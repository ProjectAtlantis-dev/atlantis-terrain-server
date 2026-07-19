import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from asset_catalog import paint_roads, query_buildings, query_roads


SCHEMA = """
CREATE TABLE assets (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, enabled INTEGER NOT NULL,
  lat REAL NOT NULL, lon REAL NOT NULL, heading_deg REAL NOT NULL,
  z REAL, properties TEXT NOT NULL, saved_at REAL, updated_at TEXT,
  cx REAL, cy REAL, min_x REAL, min_y REAL, max_x REAL, max_y REAL
);
"""


class AssetCatalogTest(unittest.TestCase):
    def make_db(self, path):
        db = sqlite3.connect(path)
        db.executescript(SCHEMA)
        return db

    def test_spatial_queries_use_catalog_geometry(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "assets.db"
            db = self.make_db(path)
            road = {
                "kind": "road", "category": "Lokalvej", "widthM": 6,
                "path": [[0, 50, 4], [100, 50, 5]],
            }
            building = {"groundZ": 3, "ring": [[10, 10, 8], [20, 10, 8], [20, 20, 8]]}
            db.execute(
                "INSERT INTO assets VALUES "
                "('r','road',1,0,0,0,NULL,?,NULL,'now',50,50,0,50,100,50)",
                (json.dumps(road),),
            )
            db.execute(
                "INSERT INTO assets VALUES "
                "('b','building',1,0,0,0,3,?,NULL,'now',15,15,10,10,20,20)",
                (json.dumps(building),),
            )
            db.commit()
            self.assertEqual([item["id"] for item in query_roads(db, (40, 40, 60, 60))], ["r"])
            result = query_buildings(db, 15, 15, 20, 10, 10)
            self.assertEqual(result[0]["ring"][0], [0, 0, 8])
            db.close()

    def test_road_is_painted_in_tile_pixel_coordinates(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "assets.db"
            db = self.make_db(path)
            props = json.dumps({
                "kind": "road", "category": "Lokalvej", "widthM": 8,
                "path": [[0, 50, 0], [100, 50, 0]],
            })
            db.execute(
                "INSERT INTO assets VALUES "
                "('r','road',1,0,0,0,NULL,?,NULL,'now',50,50,0,50,100,50)",
                (props,),
            )
            db.commit()
            db.close()

            source = io.BytesIO()
            Image.new("RGB", (100, 100), "white").save(source, "JPEG", quality=95)
            painted, count = paint_roads(source.getvalue(), (0, 0, 100, 100), path)
            self.assertEqual(count, 1)
            image = Image.open(io.BytesIO(painted)).convert("RGB")
            self.assertLess(sum(image.getpixel((50, 50))), 300)
            self.assertGreater(sum(image.getpixel((50, 10))), 700)


if __name__ == "__main__":
    unittest.main()
