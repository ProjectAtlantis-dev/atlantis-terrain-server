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
    metatile_is_upsampled,
    split_texture_metatile,
    texture_sources_in,
    write_texture,
)
import serve_flask
from terrain_config import MAX_TILE_DEPTH, WMS_CONTRACT_DEPTH


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

    def test_upsample_detector_separates_blowups_from_genuine_detail(self):
        rng = np.random.default_rng(11)
        gradient = np.linspace(60, 200, 512, dtype=np.float32)[None, :]
        genuine = np.clip(
            gradient + rng.normal(0, 18, (512, 512)).astype(np.float32), 0, 255
        )
        genuine_rgb = np.repeat(genuine[..., None], 3, axis=2)

        full = Image.fromarray(genuine, mode="F")
        half = full.resize((256, 256), Image.Resampling.LANCZOS)
        blowup = np.asarray(half.resize((512, 512), Image.Resampling.LANCZOS))
        carve = np.asarray(half.resize((512, 512), Image.Resampling.NEAREST))

        cheated, recon, spectral = metatile_is_upsampled(_encoded_image(genuine_rgb))
        self.assertFalse(cheated, f"genuine flagged (recon={recon}, spectral={spectral})")

        for name, image in (("blowup", blowup), ("carve", carve)):
            rgb = np.repeat(np.clip(image, 0, 255)[..., None], 3, axis=2)
            cheated, recon, spectral = metatile_is_upsampled(_encoded_image(rgb))
            self.assertTrue(
                cheated, f"{name} not flagged (recon={recon}, spectral={spectral})"
            )

    def test_texture_sources_in_maps_cached_tiles_to_sources(self):
        db = sqlite3.connect(":memory:")
        init_textures(db)
        jpeg = _encoded_image(np.full((8, 8, 3), 128), "JPEG")
        write_texture(db, "13-8-8", jpeg, "fractal_upscale")
        write_texture(db, "12-0-0", jpeg, "dataforsyningen_metatile4h2")

        sources = texture_sources_in(db, ["13-8-8", "12-0-0", "13-9-9"])

        self.assertEqual(
            sources,
            {"13-8-8": "fractal_upscale", "12-0-0": "dataforsyningen_metatile4h2"},
        )

    @unittest.skipUnless(
        MAX_TILE_DEPTH > WMS_CONTRACT_DEPTH,
        "upscaling disabled: MAX_TILE_DEPTH held at the WMS contract depth",
    )
    def test_fractal_cook_writes_quad_with_provenance_without_clobbering(self):
        db = sqlite3.connect(":memory:")
        init_textures(db)
        rng = np.random.default_rng(3)
        parent_rgb = rng.integers(0, 255, (256, 256, 3)).astype(np.uint8)
        parent_jpeg = _encoded_image(parent_rgb, "JPEG")
        genuine = _encoded_image(np.full((256, 256, 3), 99), "JPEG")
        write_texture(db, "12-10-20", parent_jpeg, "dataforsyningen_metatile4h2")
        # One child already has genuine provider detail — must survive the cook.
        write_texture(db, "13-21-41", genuine, "dataforsyningen_metatile4h2")

        with (
            patch.object(
                serve_flask, "_tile_bbox",
                lambda depth, column, row: (0.0, 0.0, 659.0, 659.0),
            ),
            patch.object(serve_flask, "_write_texture", write_texture),
            patch.object(serve_flask, "_split_texture_metatile", split_texture_metatile),
            patch("database.read_tile", lambda _db, _tid: {"heightmap": None}),
            patch("coastline.read_water_mask", lambda _db, _tid: None),
        ):
            cooked = serve_flask._cook_fractal_quad(db, "13-20-40")

        self.assertTrue(cooked)
        sources = dict(db.execute("SELECT tile_id, source FROM textures"))
        for child in ("13-20-40", "13-21-40", "13-20-41"):
            self.assertEqual(sources[child], "fractal_upscale")
        self.assertEqual(sources["13-21-41"], "dataforsyningen_metatile4h2")

    def test_fractal_cook_defers_until_parent_texture_is_final(self):
        db = sqlite3.connect(":memory:")
        init_textures(db)
        write_texture(
            db, "12-10-20",
            _encoded_image(np.full((256, 256, 3), 128), "JPEG"),
            "ancestor_crop",
        )
        queued = []

        with (
            patch.object(
                serve_flask, "_tile_bbox",
                lambda depth, column, row: (0.0, 0.0, 659.0, 659.0),
            ),
            patch.object(
                serve_flask, "_queue_texture_fetch",
                lambda tile_id, bbox: queued.append(tile_id),
            ),
        ):
            cooked = serve_flask._cook_fractal_quad(db, "13-20-40")

        self.assertFalse(cooked)
        self.assertEqual(
            db.execute("SELECT COUNT(*) FROM textures").fetchone()[0], 1
        )

    def test_real_parent_change_drops_stale_fractal_children(self):
        db = sqlite3.connect(":memory:")
        init_textures(db)
        jpeg = _encoded_image(np.full((8, 8, 3), 128), "JPEG")
        jpeg2 = _encoded_image(np.full((8, 8, 3), 90), "JPEG")
        write_texture(db, "12-10-20", jpeg, "dataforsyningen_metatile4h2")
        for child in ("13-20-40", "13-21-40", "13-20-41"):
            write_texture(db, child, jpeg, "fractal_upscale")
        # A genuine provider child is not derived data — it must survive.
        write_texture(db, "13-21-41", jpeg, "dataforsyningen_metatile4h2")

        write_texture(db, "12-10-20", jpeg2, "dataforsyningen_metatile4h2")

        sources = dict(db.execute("SELECT tile_id, source FROM textures"))
        for child in ("13-20-40", "13-21-40", "13-20-41"):
            self.assertNotIn(child, sources)
        self.assertEqual(sources["13-21-41"], "dataforsyningen_metatile4h2")

    def test_placeholder_parent_write_keeps_cooked_children(self):
        db = sqlite3.connect(":memory:")
        init_textures(db)
        jpeg = _encoded_image(np.full((8, 8, 3), 128), "JPEG")
        write_texture(db, "13-20-40", jpeg, "fractal_upscale")

        write_texture(db, "12-10-20", jpeg, "ancestor_crop")

        sources = dict(db.execute("SELECT tile_id, source FROM textures"))
        self.assertEqual(sources["13-20-40"], "fractal_upscale")

    def test_clobbering_terminal_source_logs_error_not_warning(self):
        db = sqlite3.connect(":memory:")
        init_textures(db)
        jpeg = _encoded_image(np.full((8, 8, 3), 128), "JPEG")
        write_texture(db, "13-5-5", jpeg, "fractal_upscale")

        with self.assertLogs("terrain.tex", level="ERROR") as captured:
            write_texture(db, "13-5-5", jpeg, "ancestor_crop")
        self.assertTrue(
            any("TEX CLOBBER-TERMINAL" in line for line in captured.output)
        )

    def test_audit_flags_only_stale_unattended_temporary_rows(self):
        import datetime

        db = sqlite3.connect(":memory:")
        init_textures(db)
        jpeg = _encoded_image(np.full((8, 8, 3), 128), "JPEG")
        write_texture(db, "13-1-1", jpeg, "ancestor_crop")        # stale+unattended → stuck
        write_texture(db, "13-2-2", jpeg, "ancestor_crop")        # in fetching set → fine
        write_texture(db, "13-3-3", jpeg, "ancestor_crop")        # fresh → fine
        write_texture(db, "13-4-4", jpeg, "fractal_upscale")      # terminal → fine
        write_texture(db, "12-0-0", jpeg, "ancestor_crop")        # at contract depth → ignored
        stale = (
            datetime.datetime.now(datetime.timezone.utc)
            - datetime.timedelta(seconds=serve_flask._D13_STUCK_AFTER_S + 60)
        ).isoformat()
        for tile_id in ("13-1-1", "13-2-2"):
            db.execute(
                "UPDATE textures SET updated_at = ? WHERE tile_id = ?",
                (stale, tile_id),
            )

        serve_flask._tex_fetching.add("13-2-2")
        try:
            audit = serve_flask._d13_texture_audit(db)
        finally:
            serve_flask._tex_fetching.discard("13-2-2")

        self.assertEqual(audit["rows"], 4)
        self.assertEqual([tile_id for tile_id, _, _ in audit["stuck"]], ["13-1-1"])
        self.assertEqual(
            audit["distribution"],
            {"ancestor_crop": 3, "fractal_upscale": 1},
        )

    def test_watchdog_requeues_stuck_tiles_through_normal_pipeline(self):
        import datetime

        db = sqlite3.connect(":memory:")
        init_textures(db)
        jpeg = _encoded_image(np.full((8, 8, 3), 128), "JPEG")
        write_texture(db, "13-7-7", jpeg, "ancestor_crop")
        stale = (
            datetime.datetime.now(datetime.timezone.utc)
            - datetime.timedelta(seconds=serve_flask._D13_STUCK_AFTER_S + 60)
        ).isoformat()
        db.execute("UPDATE textures SET updated_at = ?", (stale,))
        requeued = []

        with (
            patch.object(
                serve_flask, "_tile_bbox",
                lambda depth, column, row: (0.0, 0.0, 330.0, 330.0),
            ),
            patch.object(
                serve_flask, "_queue_texture_fetch",
                lambda tile_id, bbox: requeued.append(tile_id),
            ),
            patch.object(serve_flask, "_d13_last_distribution", None),
        ):
            serve_flask._d13_watchdog_sweep(db)

        self.assertEqual(requeued, ["13-7-7"])

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
