import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from asset_catalog import (
    _roof_color,
    _trail_color,
    color_buildings_from_textures,
    paint_roads,
    query_buildings,
    query_roads,
)


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
            Image.new("RGB", (100, 100), (80, 120, 160)).save(source, "JPEG", quality=95)
            painted, count = paint_roads(source.getvalue(), (0, 0, 100, 100), path)
            self.assertEqual(count, 1)
            image = Image.open(io.BytesIO(painted)).convert("RGB")
            base = Image.open(io.BytesIO(source.getvalue())).convert("RGB").getpixel((50, 50))
            vertical = [image.getpixel((50, y)) for y in range(100)]
            differences = [sum(abs(a - b) for a, b in zip(pixel, base)) for pixel in vertical]
            self.assertGreater(differences[50], 15)
            self.assertGreaterEqual(sum(value > 10 for value in differences), 8)
            self.assertTrue(any(1 < value < 15 for value in differences))
            self.assertLess(differences[10], 5)
            self.assertGreater(vertical[50][2], vertical[50][1])
            self.assertGreater(vertical[50][1], vertical[50][0])

            debug, count = paint_roads(
                source.getvalue(), (0, 0, 100, 100), path, debug=True
            )
            self.assertEqual(count, 1)
            debug_pixel = Image.open(io.BytesIO(debug)).convert("RGB").getpixel((50, 50))
            self.assertGreater(debug_pixel[0], debug_pixel[1] * 2)

    def test_roof_color_biases_non_earth_pixels(self):
        brown = (120, 88, 54)
        blue = (40, 90, 190)
        color = _roof_color([brown, brown, brown, blue])
        self.assertIsNotNone(color)
        self.assertGreater(color[2], color[0])

    def test_trail_color_stays_earthy_but_darkens_terrain(self):
        sampled = (130, 145, 105)
        constructed = _trail_color(sampled, natural=False)
        natural = _trail_color(sampled, natural=True)
        self.assertLess(sum(constructed), sum(sampled))
        self.assertLess(sum(natural), sum(constructed))
        self.assertGreater(natural[0], natural[2])

    def test_building_color_comes_from_deepest_cached_texture(self):
        db = sqlite3.connect(":memory:")
        db.executescript("""
        CREATE TABLE tiles (
          tile_id TEXT PRIMARY KEY, depth INTEGER,
          x_min REAL, y_min REAL, x_max REAL, y_max REAL
        );
        CREATE TABLE textures (
          tile_id TEXT PRIMARY KEY, texture BLOB, updated_at TEXT
        );
        """)
        source = io.BytesIO()
        Image.new("RGB", (32, 32), (45, 95, 185)).save(source, "JPEG", quality=95)
        db.execute("INSERT INTO tiles VALUES ('12-1-1',12,0,0,100,100)")
        db.execute("INSERT INTO textures VALUES ('12-1-1',?,'v1')", (source.getvalue(),))
        building = {
            "id": "b", "groundZ": 0,
            "ring": [[40, 40, 10], [60, 40, 10], [60, 60, 10], [40, 60, 10]],
        }
        color_buildings_from_textures(db, [building], 0, 0)
        self.assertEqual(building["colorVersion"], "12-1-1:v1")
        self.assertGreater(building["color"][2], building["color"][1])
        self.assertGreater(building["color"][1], building["color"][0])
        db.close()


if __name__ == "__main__":
    unittest.main()
