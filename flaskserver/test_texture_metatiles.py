import io
import os
import sqlite3
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

os.environ.setdefault("DATAFORSYNINGEN_TOKEN", "test-token")

from texture import (
    init_textures,
    is_no_coverage_fill_jpeg,
    split_texture_metatile,
    write_texture,
)
import serve_flask


def _encoded_image(array, image_format="PNG"):
    buf = io.BytesIO()
    Image.fromarray(array.astype(np.uint8), "RGB").save(buf, format=image_format)
    return buf.getvalue()


class TextureMetatileTest(unittest.TestCase):
    def test_split_uses_quadtree_row_orientation(self):
        image = np.zeros((512, 512, 3), dtype=np.uint8)
        colors = {
            (0, 0): (220, 20, 20),
            (1, 0): (20, 220, 20),
            (0, 1): (20, 20, 220),
            (1, 1): (220, 220, 20),
        }
        for (column_bit, row_bit), color in colors.items():
            x0 = column_bit * 256
            y0 = (1 - row_bit) * 256
            image[y0:y0 + 256, x0:x0 + 256] = color

        children = split_texture_metatile(_encoded_image(image))

        self.assertEqual(set(children), set(colors))
        for offset, expected in colors.items():
            child = np.asarray(Image.open(io.BytesIO(children[offset])).convert("RGB"))
            self.assertEqual(child.shape, (256, 256, 3))
            np.testing.assert_allclose(child[128, 128], expected, atol=3)

    def test_split_rejects_unexpected_dimensions(self):
        image = np.zeros((256, 512, 3), dtype=np.uint8)
        with self.assertRaisesRegex(ValueError, "expected 512x512"):
            split_texture_metatile(_encoded_image(image))

    def test_child_no_coverage_detection_handles_white_and_warp_void(self):
        white = np.full((256, 256, 3), 255, dtype=np.uint8)
        black = np.zeros((256, 256, 3), dtype=np.uint8)
        textured = np.indices((256, 256)).sum(axis=0) % 2
        textured = np.repeat((textured * 180)[..., None], 3, axis=2).astype(np.uint8)

        self.assertTrue(is_no_coverage_fill_jpeg(_encoded_image(white)))
        self.assertTrue(is_no_coverage_fill_jpeg(_encoded_image(black)))
        self.assertFalse(is_no_coverage_fill_jpeg(_encoded_image(textured)))


class TextureMetatileFetchTest(unittest.TestCase):
    def setUp(self):
        self.old_tile_bbox = serve_flask._tile_bbox
        self.old_fetch = serve_flask._fetch_dataforsyningen_texture
        self.old_split = serve_flask._split_texture_metatile
        serve_flask._tile_bbox = lambda depth, column, row: (
            depth, column, row, depth + column + row
        )

    def tearDown(self):
        serve_flask._tile_bbox = self.old_tile_bbox
        serve_flask._fetch_dataforsyningen_texture = self.old_fetch
        serve_flask._split_texture_metatile = self.old_split

    def test_spec_groups_four_quadtree_siblings_under_parent(self):
        metatile_id, bbox, resolution, children = serve_flask._texture_metatile_spec(
            "12-1407-765"
        )

        self.assertEqual(metatile_id, "11-703-382")
        self.assertEqual(bbox, (11, 703, 382, 1096))
        self.assertEqual(resolution, 512)
        self.assertEqual(children, {
            "12-1406-764": (0, 0),
            "12-1406-765": (0, 1),
            "12-1407-764": (1, 0),
            "12-1407-765": (1, 1),
        })

    def test_fetch_requests_parent_once_and_maps_split_quadrants(self):
        calls = []
        serve_flask._fetch_dataforsyningen_texture = (
            lambda bbox, resolution, lossless=False:
                calls.append((bbox, resolution, lossless)) or (b"meta", None)
        )
        serve_flask._split_texture_metatile = lambda jpeg, child_resolution: {
            (0, 0): b"sw",
            (0, 1): b"nw",
            (1, 0): b"se",
            (1, 1): b"ne",
        }

        children, error = serve_flask._fetch_texture_metatile("12-1407-765")

        self.assertIsNone(error)
        self.assertEqual(calls, [([11, 703, 382, 1096], 512, True)])
        self.assertEqual(children, {
            "12-1406-764": b"sw",
            "12-1406-765": b"nw",
            "12-1407-764": b"se",
            "12-1407-765": b"ne",
        })

    def test_store_upgrades_legacy_children_without_clobbering_terminal_rows(self):
        db = sqlite3.connect(":memory:")
        init_textures(db)
        red = _encoded_image(np.full((256, 256, 3), (180, 30, 20)), "JPEG")
        blue = _encoded_image(np.full((256, 256, 3), (20, 30, 180)), "JPEG")
        white = _encoded_image(np.full((256, 256, 3), 255), "JPEG")
        write_texture(db, "2-0-0", red, "dataforsyningen")
        write_texture(db, "2-1-0", blue, "ocean_nodata")

        with (
            patch.object(serve_flask, "_write_texture", write_texture),
            patch.object(serve_flask, "_repair_white_ocean_jpeg", lambda db, tid, jpeg: jpeg),
        ):
            written, no_coverage = serve_flask._store_texture_metatile(db, {
                "2-0-0": blue,
                "2-0-1": red,
                "2-1-0": red,
                "2-1-1": white,
            })

        self.assertEqual(written, {"2-0-0", "2-0-1"})
        self.assertEqual(no_coverage, {"2-1-1"})
        sources = dict(db.execute("SELECT tile_id, source FROM textures"))
        self.assertEqual(sources["2-0-0"], "dataforsyningen_metatile")
        self.assertEqual(sources["2-0-1"], "dataforsyningen_metatile")
        self.assertEqual(sources["2-1-0"], "ocean_nodata")


if __name__ == "__main__":
    unittest.main()
