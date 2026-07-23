"""Physics-first classification inside the procedural cook."""

import io
import os
import sqlite3
import unittest
from unittest.mock import patch

import numpy as np

os.environ.setdefault("DATAFORSYNINGEN_TOKEN", "test-token")

from cook_classifier import (
    DARK, GREEN, GREY, WATER, WHITE,
    SLOPE_ROCK_MIN,
    classify_cooked_quad,
    classify_tile_surface,
)

N = 65
SIZE = 512
BBOX = (0.0, 0.0, 659.18, 659.18)
GREEN_RGB = (90, 150, 70)


def _flat_surface():
    return np.zeros((129, 129), dtype=np.float32)


def _north_rising_surface(rise_per_cell):
    """South-first rows rising northward → south-facing (southness > 0)."""
    cell = BBOX[2] / 128.0
    rows = np.arange(129, dtype=np.float32) * rise_per_cell * cell
    return np.repeat(rows[:, None], 129, axis=1)


def _uniform_rgb(color):
    return np.tile(np.asarray(color, np.uint8), (256, 256, 1))


class CookClassifierTest(unittest.TestCase):
    def test_green_survives_only_on_gentle_south_faces(self):
        rgb = _uniform_rgb(GREEN_RGB)

        south_gentle = _north_rising_surface(0.2)   # southness > 0, slope 0.2
        labels, _, _ = classify_cooked_quad(rgb, south_gentle, BBOX)
        self.assertEqual(labels[SIZE // 2, SIZE // 2], GREEN)

        south_steep = _north_rising_surface(0.6)    # south-facing but steep
        labels, _, _ = classify_cooked_quad(rgb, south_steep, BBOX)
        self.assertEqual(labels[SIZE // 2, SIZE // 2], GREY)

        north_gentle = _north_rising_surface(-0.2)  # gentle but north-facing
        labels, _, _ = classify_cooked_quad(rgb, north_gentle, BBOX)
        self.assertEqual(labels[SIZE // 2, SIZE // 2], GREY)

    def test_steep_ground_is_bare_rock_whatever_the_imagery_says(self):
        cliff = _north_rising_surface(SLOPE_ROCK_MIN + 0.3)
        for color in ((240, 240, 240), GREEN_RGB):
            labels, _, _ = classify_cooked_quad(_uniform_rgb(color), cliff, BBOX)
            self.assertEqual(labels[SIZE // 2, SIZE // 2], GREY)

    def test_color_proposals_hold_on_flat_ground(self):
        # DARK/WHITE are RELATIVE to each tile's own land luminance (no
        # fixed absolute threshold works across an imagery source whose
        # exposure varies tile to tile) — a perfectly uniform image has no
        # "brighter than the rest of this tile" region, so it must all
        # read as GREY regardless of its absolute brightness.
        flat = _flat_surface()
        for color in ((240, 240, 240), (30, 30, 30), (128, 128, 128)):
            labels, _, _ = classify_cooked_quad(_uniform_rgb(color), flat, BBOX)
            self.assertTrue(np.all(labels == GREY), color)

    def test_relative_brightness_finds_dark_and_white_within_one_tile(self):
        # A mid-grey field with a bright patch and a dark patch: DARK/WHITE
        # must be assigned by RELATIVE brightness within this tile, not an
        # absolute luminance cutoff.
        flat = _flat_surface()
        rgb = _uniform_rgb((128, 128, 128))
        w = rgb.shape[1]  # rgb is 256px; labels are resized up to SIZE=512
        rgb[:, : w // 3] = (20, 20, 20)         # west third: dark patch
        rgb[:, 2 * w // 3 :] = (235, 235, 235)  # east third: bright patch
        labels, _, _ = classify_cooked_quad(rgb, flat, BBOX)
        self.assertEqual(labels[SIZE // 2, SIZE // 6], DARK)
        self.assertEqual(labels[SIZE // 2, SIZE // 2], GREY)
        self.assertEqual(labels[SIZE // 2, 5 * SIZE // 6], WHITE)

    def test_water_mask_outranks_everything_and_carries_no_detail(self):
        mask = np.zeros((N, N), dtype=bool)
        mask[:, : N // 2] = True  # western half water (orientation-neutral)
        labels, amplitude, _ = classify_cooked_quad(
            _uniform_rgb(GREEN_RGB), _flat_surface(), BBOX, water_mask=mask
        )
        self.assertEqual(labels[SIZE // 2, SIZE // 4], WATER)
        self.assertEqual(amplitude[SIZE // 2, SIZE // 4], 0.0)
        self.assertEqual(labels[SIZE // 2, 3 * SIZE // 4], GREEN)

    def test_live_tile_surface_classification_matches_quad_labels(self):
        # A d12 tile classifying itself uses its own 65x65 measured grid and
        # 256px texture — same physics, no cook. Labels must agree with the
        # quad path given the same inputs.
        surface = np.zeros((N, N), dtype=np.float32)
        rows = np.arange(N, dtype=np.float32) * 0.2 * (BBOX[2] / (N - 1))
        surface += rows[:, None]
        rgb = _uniform_rgb(GREEN_RGB)
        labels = classify_tile_surface(rgb, surface, BBOX)
        self.assertEqual(labels.shape, (256, 256))
        self.assertEqual(labels[128, 128], GREEN)
        expected, _, _ = classify_cooked_quad(rgb, surface, BBOX, output_size=256)
        np.testing.assert_array_equal(labels, expected)

    def test_detail_energy_orders_rock_above_vegetation(self):
        steep_rock = _north_rising_surface(0.8)
        _, rock_amp, rock_char = classify_cooked_quad(
            _uniform_rgb((128, 128, 128)), steep_rock, BBOX
        )
        _, veg_amp, veg_char = classify_cooked_quad(
            _uniform_rgb(GREEN_RGB), _north_rising_surface(0.15), BBOX
        )
        center = (SIZE // 2, SIZE // 2)
        self.assertGreater(rock_amp[center], veg_amp[center])
        self.assertGreater(rock_char[center], veg_char[center])
        self.assertLessEqual(veg_char[center], 0.3)


class BakeTextureDetailTest(unittest.TestCase):
    def test_bake_is_deterministic_and_class_gated(self):
        from cook_classifier import WATER, bake_texture_detail

        rgb = np.full((128, 128, 3), 128, np.uint8)
        labels = np.zeros((128, 128), np.uint8)  # all rock
        labels[:, 64:] = WATER
        bbox = (1000.0, 2000.0, 1329.6, 2329.6)
        first = bake_texture_detail(rgb, labels, bbox)
        second = bake_texture_detail(rgb, labels, bbox)
        np.testing.assert_array_equal(first, second)
        # Rock half carries visible grain; water half is untouched.
        self.assertGreater(int(np.ptp(first[:, :64])), 10)
        np.testing.assert_array_equal(first[:, 64:], rgb[:, 64:])

    def test_bake_is_continuous_across_a_shared_tile_border(self):
        from cook_classifier import bake_texture_detail

        rgb = np.full((128, 128, 3), 128, np.uint8)
        labels = np.zeros((128, 128), np.uint8)
        west = (0.0, 0.0, 329.6, 329.6)
        east = (329.6, 0.0, 659.2, 329.6)
        west_baked = bake_texture_detail(rgb, labels, west)
        east_baked = bake_texture_detail(rgb, labels, east)
        # linspace includes both endpoints, so the shared world column is
        # sampled by both tiles and must bake to the same values.
        np.testing.assert_array_equal(west_baked[:, -1], east_baked[:, 0])

    def test_bake_never_brightens_black_shadow(self):
        from cook_classifier import bake_texture_detail

        rgb = np.zeros((64, 64, 3), np.uint8)  # pitch-dark imagery
        labels = np.zeros((64, 64), np.uint8)
        baked = bake_texture_detail(rgb, labels, (0.0, 0.0, 100.0, 100.0))
        # Multiplicative modulation: black stays black, no grey splotches.
        np.testing.assert_array_equal(baked, rgb)


class LiveD12ClassificationTest(unittest.TestCase):
    def _database_with_d12_tile(self, texture_source):
        from PIL import Image

        import database
        from classifier.storage import init_classifier_tiles
        from texture import init_textures, write_texture

        db = sqlite3.connect(":memory:")
        db.executescript(database._SCHEMA)
        init_textures(db)
        init_classifier_tiles(db)
        surface = np.zeros((65, 65), dtype=np.float32)
        surface += (
            np.arange(65, dtype=np.float32)[:, None] * 0.2 * (659.18 / 64.0)
        )
        db.execute(
            "INSERT INTO tiles (tile_id, depth, col, row, x_min, y_min, "
            "x_max, y_max, source, updated_at, heightmap, confidence_map) "
            "VALUES (?, 12, 100, 200, 0, 0, 659.18, 659.18, 'arcticdem_10m', "
            "'now', ?, ?)",
            (
                "12-100-200",
                database._compress_array(surface),
                database._compress_array(np.full((65, 65), 6, np.uint8)),
            ),
        )
        buf = io.BytesIO()
        Image.fromarray(
            np.tile(np.asarray(GREEN_RGB, np.uint8), (256, 256, 1)), "RGB"
        ).save(buf, format="JPEG")
        write_texture(db, "12-100-200", buf.getvalue(), texture_source)
        return db

    def test_final_texture_classifies_and_stores_on_demand(self):
        import serve_flask

        db = self._database_with_d12_tile("dataforsyningen_metatile4h2")
        with patch(
            "classifier.official_water.classifier_water_mask_for_tile",
            return_value=None,
        ):
            serve_flask._ensure_d12_class_map(db, "12-100-200")
        row = db.execute(
            "SELECT source FROM classifier_tiles WHERE tile_id = '12-100-200'"
        ).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row[0], "ladder_d12_v3")

        # Second call must be a no-op read, never a re-classification.
        with patch("classifier.ladder.classify_ladder") as untouched:
            serve_flask._ensure_d12_class_map(db, "12-100-200")
            untouched.assert_not_called()

    def test_old_ladder_source_is_reclassified_on_demand(self):
        import classifier.ladder
        import serve_flask

        db = self._database_with_d12_tile("dataforsyningen_metatile4h2")
        with patch(
            "classifier.official_water.classifier_water_mask_for_tile",
            return_value=None,
        ):
            serve_flask._ensure_d12_class_map(db, "12-100-200")
            db.execute(
                "UPDATE classifier_tiles SET source = 'ladder_d12_v2' "
                "WHERE tile_id = '12-100-200'"
            )
            db.commit()
            with patch(
                "classifier.ladder.classify_ladder",
                wraps=classifier.ladder.classify_ladder,
            ) as refreshed:
                serve_flask._ensure_d12_class_map(db, "12-100-200")
            refreshed.assert_called_once()
        source = db.execute(
            "SELECT source FROM classifier_tiles WHERE tile_id = '12-100-200'"
        ).fetchone()[0]
        self.assertEqual(source, "ladder_d12_v3")

    def test_placeholder_texture_is_never_persisted_as_classification(self):
        import serve_flask

        db = self._database_with_d12_tile("ancestor_crop")
        serve_flask._ensure_d12_class_map(db, "12-100-200")
        row = db.execute(
            "SELECT source FROM classifier_tiles WHERE tile_id = '12-100-200'"
        ).fetchone()
        self.assertIsNone(row)


if __name__ == "__main__":
    unittest.main()
