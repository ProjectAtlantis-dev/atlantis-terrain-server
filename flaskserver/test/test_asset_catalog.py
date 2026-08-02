import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

import asset_catalog
from asset_catalog import (
    _roof_color,
    _local_segments,
    _rgb_pixel,
    _sample_underlying_color,
    _trail_color,
    color_buildings_from_textures,
    paint_roads,
    query_buildings,
    query_roads,
    road_corridor_mask,
)


SCHEMA = """
CREATE TABLE assets (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, enabled INTEGER NOT NULL,
  lat REAL NOT NULL, lon REAL NOT NULL, heading_deg REAL NOT NULL,
  z REAL, properties TEXT NOT NULL, saved_at REAL, updated_at TEXT,
  cx REAL, cy REAL, min_x REAL, min_y REAL, max_x REAL, max_y REAL
);
"""


def _gray_pixel(image: Image.Image, x: int, y: int) -> int:
    pixel = image.getpixel((x, y))
    if isinstance(pixel, tuple):
        return int(pixel[0])
    if pixel is None:
        return 0
    return int(pixel)


class AssetCatalogTest(unittest.TestCase):
    def test_parallel_asset_instances_module_stays_retired(self):
        module_path = Path(__file__).resolve().parents[1] / "asset_instances.py"
        self.assertFalse(module_path.exists())

    def test_road_painter_has_no_retired_fixed_color_palette(self):
        self.assertFalse(hasattr(asset_catalog, "ROAD_COLORS"))
        self.assertFalse(hasattr(asset_catalog, "DEFAULT_ROAD_COLOR"))
        self.assertIn("road:Lokalvej", asset_catalog.ROAD_WIDTH_SCALE)

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
            base_image = Image.open(io.BytesIO(source.getvalue())).convert("RGB")
            base = _rgb_pixel(base_image, 50, 50)
            vertical = [_rgb_pixel(image, 50, y) for y in range(100)]
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
            debug_image = Image.open(io.BytesIO(debug)).convert("RGB")
            debug_pixel = _rgb_pixel(debug_image, 50, 50)
            self.assertGreater(debug_pixel[0], debug_pixel[1] * 2)

            corridor, count = road_corridor_mask(
                (0, 0, 100, 100), 100, 100, path
            )
            self.assertEqual(count, 1)
            self.assertGreater(_gray_pixel(corridor, 50, 50), 200)
            self.assertLess(_gray_pixel(corridor, 50, 10), 5)

    def test_route_color_sampling_stays_local_to_each_painted_segment(self):
        image = Image.new("RGB", (100, 100), (40, 80, 180))
        for y in range(100):
            for x in range(50, 100):
                image.putpixel((x, y), (190, 70, 40))
        segments = list(_local_segments([(0, 200), (400, 200)], 4))
        self.assertGreater(len(segments), 2)
        first = _sample_underlying_color(image, list(segments[0]), 4)
        last = _sample_underlying_color(image, list(segments[-1]), 4)
        assert first is not None
        assert last is not None
        self.assertGreater(first[2], first[0])
        self.assertGreater(last[0], last[2])

    def test_route_sampling_covers_the_full_painted_width(self):
        image = Image.new("RGB", (30, 30), (190, 60, 40))
        ImageDraw.Draw(image).line((0, 15, 29, 15), fill=(40, 80, 190), width=1)
        sampled = _sample_underlying_color(
            image,
            [(0, 60), (116, 60)],
            4,
            sample_half_width=8,
        )
        assert sampled is not None
        # The one-pixel blue centerline must not outweigh the red pixels under
        # the rest of the proposed four-pixel-wide stroke.
        self.assertGreater(sampled[0], sampled[2])

    def test_roof_color_biases_non_earth_pixels(self):
        brown = (120, 88, 54)
        blue = (40, 90, 190)
        color = _roof_color([brown, brown, brown, blue])
        assert color is not None
        self.assertGreater(color[2], color[0])

    def test_trail_color_preserves_sampled_hue_but_darkens_terrain(self):
        sampled = (130, 145, 105)
        constructed = _trail_color(sampled, natural=False)
        natural = _trail_color(sampled, natural=True)
        self.assertLess(sum(constructed), sum(sampled))
        self.assertLess(sum(natural), sum(sampled))
        self.assertLess(sum(natural), sum(constructed))
        self.assertGreater(
            sum(abs(actual - base) for actual, base in zip(natural, sampled)),
            sum(abs(actual - base) for actual, base in zip(constructed, sampled)),
        )
        self.assertEqual(natural.index(max(natural)), sampled.index(max(sampled)))
        self.assertGreater(
            natural[1] * sampled[2],
            sampled[1] * natural[2],
        )

    def test_natural_trail_remains_visible_over_olive_terrain(self):
        sampled = (105, 92, 57)
        natural = _trail_color(sampled, natural=True)
        # With the normal path alpha (180/255), this leaves roughly 20% net
        # value contrast instead of the former single-digit grey-line change.
        composited = tuple(
            round(base * (1 - 180 / 255) + trail * (180 / 255))
            for base, trail in zip(sampled, natural)
        )
        self.assertGreater(
            max(base - painted for base, painted in zip(sampled, composited)),
            15,
        )
        self.assertGreater(composited[0], composited[1])
        self.assertGreater(composited[1], composited[2])

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
        texture = Image.new("RGB", (32, 32), (105, 125, 65))
        # Footprint [40,60] maps to roughly pixels [13,19] in both axes.
        ImageDraw.Draw(texture).rectangle((12, 12, 20, 20), fill=(45, 95, 185))
        texture.save(source, "JPEG", quality=95)
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
