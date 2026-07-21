import io
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch

import numpy as np
from PIL import Image

os.environ.setdefault("DATAFORSYNINGEN_TOKEN", "test-token")

from texture import (
    init_textures,
    harmonize_texture_metatile,
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

    def test_split_supports_four_by_four_metatiles(self):
        image = np.zeros((1024, 1024, 3), dtype=np.uint8)
        for column in range(4):
            for row in range(4):
                x0 = column * 256
                y0 = (3 - row) * 256
                image[y0:y0 + 256, x0:x0 + 256] = (column * 50, row * 50, 80)

        children = split_texture_metatile(_encoded_image(image), grid_size=4)

        self.assertEqual(len(children), 16)
        northeast = np.asarray(Image.open(io.BytesIO(children[(3, 3)])).convert("RGB"))
        southwest = np.asarray(Image.open(io.BytesIO(children[(0, 0)])).convert("RGB"))
        np.testing.assert_allclose(northeast[128, 128], (150, 150, 80), atol=3)
        np.testing.assert_allclose(southwest[128, 128], (0, 0, 80), atol=3)

    def test_child_no_coverage_detection_handles_white_and_warp_void(self):
        white = np.full((256, 256, 3), 255, dtype=np.uint8)
        black = np.zeros((256, 256, 3), dtype=np.uint8)
        textured = np.indices((256, 256)).sum(axis=0) % 2
        textured = np.repeat((textured * 180)[..., None], 3, axis=2).astype(np.uint8)

        self.assertTrue(is_no_coverage_fill_jpeg(_encoded_image(white)))
        self.assertTrue(is_no_coverage_fill_jpeg(_encoded_image(black)))
        self.assertFalse(is_no_coverage_fill_jpeg(_encoded_image(textured)))

    def test_harmonizer_feathers_internal_color_jump_without_touching_far_interior(self):
        image = np.zeros((512, 512, 3), dtype=np.uint8)
        image[:, :256] = (80, 100, 120)
        image[:, 256:] = (120, 130, 150)

        result = np.asarray(Image.open(io.BytesIO(harmonize_texture_metatile(
            _encoded_image(image), grid_size=2, max_shift=40
        ))).convert("RGB"))

        before_jump = np.abs(image[:, 255].astype(float) - image[:, 256].astype(float)).mean()
        after_jump = np.abs(result[:, 255].astype(float) - result[:, 256].astype(float)).mean()
        self.assertLess(after_jump, before_jump * 0.15)
        np.testing.assert_allclose(result[128, 0], image[128, 0], atol=1)
        np.testing.assert_allclose(result[128, 511], image[128, 511], atol=1)


class TextureMetatileFetchTest(unittest.TestCase):
    def setUp(self):
        self.old_tile_bbox = serve_flask._tile_bbox
        self.old_fetch = serve_flask._fetch_dataforsyningen_texture
        self.old_split = serve_flask._split_texture_metatile
        self.old_harmonize = serve_flask._harmonize_texture_metatile
        serve_flask._tile_bbox = lambda depth, column, row: (
            depth, column, row, depth + column + row
        )

    def tearDown(self):
        serve_flask._tile_bbox = self.old_tile_bbox
        serve_flask._fetch_dataforsyningen_texture = self.old_fetch
        serve_flask._split_texture_metatile = self.old_split
        serve_flask._harmonize_texture_metatile = self.old_harmonize

    def test_spec_groups_sixteen_quadtree_tiles_under_grandparent(self):
        metatile_id, bbox, resolution, children = serve_flask._texture_metatile_spec(
            "12-1407-765"
        )

        self.assertEqual(metatile_id, "10-351-191")
        self.assertEqual(bbox, (10, 351, 191, 552))
        self.assertEqual(resolution, 1024)
        self.assertEqual(len(children), 16)
        self.assertEqual(children["12-1404-764"], (0, 0))
        self.assertEqual(children["12-1407-765"], (3, 1))
        self.assertEqual(children["12-1407-767"], (3, 3))

    def test_fetch_requests_parent_once_and_maps_split_quadrants(self):
        calls = []
        serve_flask._fetch_dataforsyningen_texture = (
            lambda bbox, resolution, lossless=False:
                calls.append((bbox, resolution, lossless)) or (b"meta", None)
        )
        serve_flask._split_texture_metatile = (
            lambda jpeg, child_resolution, grid_size: {
                (column, row): f"{column}-{row}".encode()
                for column in range(grid_size)
                for row in range(grid_size)
            }
        )
        serve_flask._harmonize_texture_metatile = (
            lambda jpeg, child_resolution, grid_size: jpeg
        )

        children, error = serve_flask._fetch_texture_metatile("12-1407-765")

        self.assertIsNone(error)
        self.assertIsNotNone(children)
        assert children is not None
        self.assertEqual(calls, [([10, 351, 191, 552], 1024, True)])
        self.assertEqual(len(children), 16)
        self.assertEqual(children["12-1404-764"], b"0-0")
        self.assertEqual(children["12-1407-765"], b"3-1")

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
        self.assertEqual(sources["2-0-0"], "dataforsyningen_metatile4h2")
        self.assertEqual(sources["2-0-1"], "dataforsyningen_metatile4h2")
        self.assertEqual(sources["2-1-0"], "ocean_nodata")

    def test_persistent_transient_stays_retryable_until_success(self):
        tile_id = "12-1525-779"
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "terrain.db"
            db = sqlite3.connect(db_path)
            init_textures(db)
            crop = _encoded_image(
                np.full((256, 256, 3), (80, 100, 120)), "JPEG"
            )
            write_texture(db, tile_id, crop, "ancestor_crop")
            write_texture(db, tile_id, crop, "ancestor_crop_ratelimit")
            db.close()

            fetch_results = iter([
                (None, "transient"),
                ({tile_id: b"provider-image"}, None),
            ])
            resolve_no_coverage = Mock()
            with (
                patch.object(serve_flask, "DB_PATH", db_path),
                patch.object(serve_flask, "_init_textures", init_textures),
                patch.object(serve_flask, "_TEX_RETRY_DELAYS", [0]),
                patch.object(
                    serve_flask, "_tex_retry_queue", [(tile_id, (0, 0, 1, 1), 0)]
                ),
                patch.object(serve_flask, "_tex_retry_tiles", {tile_id}),
                patch.object(
                    serve_flask, "_fetch_texture_metatile",
                    side_effect=lambda _tile_id: next(fetch_results),
                ),
                patch.object(
                    serve_flask, "_store_texture_metatile",
                    return_value=({tile_id}, set()),
                ),
                patch.object(
                    serve_flask, "_resolve_no_coverage", resolve_no_coverage
                ),
            ):
                serve_flask._tex_retry_worker()

                self.assertEqual(serve_flask._tex_retry_queue, [])
                self.assertEqual(serve_flask._tex_retry_tiles, set())
                resolve_no_coverage.assert_not_called()


if __name__ == "__main__":
    unittest.main()
