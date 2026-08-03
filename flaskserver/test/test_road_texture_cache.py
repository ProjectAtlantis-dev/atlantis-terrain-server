import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from asset_catalog import connect
from road_texture_cache import (
    ROAD_TEXTURE_BAKE_VERSION,
    get_or_create_road_texture,
    init_road_texture_bakes,
)


class RoadTextureCacheTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.assets_path = Path(self.directory.name) / "assets.db"
        assets = connect(self.assets_path)
        road = {
            "sourceLayer": "STIMIDTE",
            "sourceProperties": {"revision": "one"},
            "path": [[0, 50, 0], [100, 50, 0]],
        }
        assets.execute(
            "INSERT INTO assets "
            "(id,type,enabled,lat,lon,heading_deg,z,properties,saved_at,"
            "updated_at,cx,cy,min_x,min_y,max_x,max_y) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                "trail-1", "STIMIDTE", 1, 0, 0, 0, None,
                json.dumps(road), None, "roads-v1",
                50, 50, 0, 50, 100, 50,
            ),
        )
        assets.commit()
        assets.close()

        self.db = sqlite3.connect(":memory:")
        self.db.executescript("""
            CREATE TABLE tiles (tile_id TEXT PRIMARY KEY);
            CREATE TABLE textures (
              tile_id TEXT PRIMARY KEY, source TEXT, texture BLOB,
              updated_at TEXT
            );
        """)
        self.db.execute("INSERT INTO tiles VALUES ('12-1-1')")
        source = io.BytesIO()
        Image.new("RGB", (64, 64), (90, 130, 80)).save(
            source, format="JPEG", quality=95,
        )
        self.canonical = source.getvalue()
        self.db.execute(
            "INSERT INTO textures VALUES (?,?,?,?)",
            ("12-1-1", "orthophoto", self.canonical, "texture-v1"),
        )
        self.db.commit()
        init_road_texture_bakes(self.db)

    def tearDown(self):
        self.db.close()
        self.directory.cleanup()

    def test_bake_is_persisted_and_dependency_versioned(self):
        bbox = (0.0, 0.0, 100.0, 100.0)
        first = get_or_create_road_texture(
            self.db, "12-1-1", bbox, self.assets_path,
        )
        second = get_or_create_road_texture(
            self.db, "12-1-1", bbox, self.assets_path,
        )

        assert first is not None
        assert second is not None
        self.assertTrue(first["generated"])
        self.assertFalse(second["generated"])
        self.assertEqual(first["texture"], second["texture"])
        self.assertNotEqual(first["texture"], self.canonical)
        self.assertEqual(first["road_count"], 1)
        self.assertEqual(first["recipe_version"], ROAD_TEXTURE_BAKE_VERSION)

        stored = self.db.execute(
            "SELECT recipe_version, source_fingerprint, road_count "
            "FROM road_texture_bakes WHERE tile_id = ?",
            ("12-1-1",),
        ).fetchone()
        self.assertEqual(stored[0], ROAD_TEXTURE_BAKE_VERSION)
        self.assertEqual(stored[1], first["fingerprint"])
        self.assertEqual(stored[2], 1)

        assets = connect(self.assets_path)
        changed = {
            "sourceLayer": "STIMIDTE",
            "sourceProperties": {"revision": "two"},
            "path": [[0, 50, 0], [100, 50, 0]],
        }
        assets.execute(
            "UPDATE assets SET properties = ?, updated_at = ? WHERE id = ?",
            (json.dumps(changed), "roads-v2", "trail-1"),
        )
        assets.commit()
        assets.close()
        road_refresh = get_or_create_road_texture(
            self.db, "12-1-1", bbox, self.assets_path,
        )
        assert road_refresh is not None
        self.assertTrue(road_refresh["generated"])
        self.assertNotEqual(road_refresh["fingerprint"], first["fingerprint"])

        self.db.execute(
            "UPDATE textures SET updated_at = ? WHERE tile_id = ?",
            ("texture-v2", "12-1-1"),
        )
        self.db.commit()
        texture_refresh = get_or_create_road_texture(
            self.db, "12-1-1", bbox, self.assets_path,
        )
        assert texture_refresh is not None
        self.assertTrue(texture_refresh["generated"])
        self.assertNotEqual(
            texture_refresh["fingerprint"], road_refresh["fingerprint"],
        )


if __name__ == "__main__":
    unittest.main()
