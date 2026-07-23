"""Archetype-conditioned macro relief (the NMS-style d13+ terrain build-out).

Covers the contract that matters for a shared deterministic world:
same inputs -> identical geometry, class decisions pick relief character,
water stays flat, deeper cooks add weaker bands, and adjacent cooks agree
at shared borders purely from world-anchored math (no seam repair).
"""

import unittest
from unittest.mock import patch

import numpy as np

from classifier.archetypes import (
    ARCHETYPE_NAMES, BENCH, FACE, WATER,
)
from terrain_upscale import (
    MACRO_RELIEF_PARAMS, MACRO_SHADE_RANGE, _world_bilinear,
    macro_cascade_delta, macro_surfaces, shade_texture_with_relief,
    upscale_heightmap,
)


def _cells(fill, grid=32):
    return np.full((grid, grid), np.uint8(fill))


class MacroReliefTest(unittest.TestCase):
    def setUp(self):
        rows, columns = np.mgrid[0:65, 0:65]
        self.heightmap = (200.0 + rows * 2.0 + columns * 0.5).astype(np.float32)
        self.bbox = (0.0, 0.0, 659.18, 659.18)

    def _upscale(self, cells, depth=13, **kwargs):
        return upscale_heightmap(
            self.heightmap, self.bbox, factor=2, amplitude_m=0.0,
            archetype_cells=cells, macro_depth=depth, **kwargs,
        )

    def test_relief_params_cover_every_archetype(self):
        self.assertEqual(len(MACRO_RELIEF_PARAMS), len(ARCHETYPE_NAMES))

    def test_is_deterministic(self):
        first = self._upscale(_cells(FACE))
        second = self._upscale(_cells(FACE))
        np.testing.assert_array_equal(first, second)

    def test_face_builds_real_relief_over_bilinear(self):
        bilinear = upscale_heightmap(
            self.heightmap, self.bbox, factor=2, amplitude_m=0.0,
        )
        face = self._upscale(_cells(FACE))
        relief = face - bilinear
        self.assertGreater(float(np.abs(relief).max()), 1.0)

    def test_water_archetype_stays_flat(self):
        bilinear = upscale_heightmap(
            self.heightmap, self.bbox, factor=2, amplitude_m=0.0,
        )
        water = self._upscale(_cells(WATER))
        np.testing.assert_array_equal(water, bilinear)

    def test_face_is_rougher_than_bench(self):
        bilinear = upscale_heightmap(
            self.heightmap, self.bbox, factor=2, amplitude_m=0.0,
        )
        face_std = float(np.std(self._upscale(_cells(FACE)) - bilinear))
        bench_std = float(np.std(self._upscale(_cells(BENCH)) - bilinear))
        self.assertGreater(face_std, bench_std * 2)

    def test_deeper_bands_are_weaker(self):
        # The source heightmap is a plane, so the sharpen term is ~zero and
        # the comparison isolates the noise band's depth falloff.
        bilinear = upscale_heightmap(
            self.heightmap, self.bbox, factor=2, amplitude_m=0.0,
        )
        d13 = float(np.std(self._upscale(_cells(FACE), depth=13) - bilinear))
        d15 = float(np.std(self._upscale(_cells(FACE), depth=15) - bilinear))
        self.assertGreater(d13, d15)

    def test_water_mask_still_wins_over_relief(self):
        water = np.zeros((65, 65), dtype=bool)
        water[:, :8] = True
        out = self._upscale(_cells(FACE), water_mask=water)
        self.assertTrue(np.all(out[:, :2] == 0.0))

    def test_adjacent_cooks_agree_at_shared_border_without_seam_repair(self):
        # Two neighboring parent tiles sample the SAME world-anchored
        # archetype field: their independently cooked surfaces must be
        # bit-identical along the shared edge, with zero fade-to-base moat.
        flat = np.full((65, 65), 300.0, dtype=np.float32)
        rng = np.random.default_rng(7)
        field = rng.integers(3, 12, size=(32, 64)).astype(np.uint8)
        field_bbox = (0.0, 0.0, 1320.0, 660.0)
        west = upscale_heightmap(
            flat, (0.0, 0.0, 660.0, 660.0), factor=2, amplitude_m=0.0,
            archetype_cells=field, archetype_bbox=field_bbox, macro_depth=13,
        )
        east = upscale_heightmap(
            flat, (660.0, 0.0, 1320.0, 660.0), factor=2, amplitude_m=0.0,
            archetype_cells=field, archetype_bbox=field_bbox, macro_depth=13,
        )
        np.testing.assert_array_equal(west[:, -1], east[:, 0])
        # And the border actually carries relief — no flat seam valley.
        self.assertGreater(float(np.std(west[:, -1])), 0.0)


class MacroCascadeDeltaTest(unittest.TestCase):
    def setUp(self):
        self.flat = np.full((65, 65), 300.0, dtype=np.float32)
        self.bbox = (0.0, 0.0, 660.0, 660.0)

    def _delta(self, cells, bbox=None, **kwargs):
        bbox = bbox or self.bbox
        return macro_cascade_delta(
            self.flat, bbox,
            archetype_cells=cells, archetype_bbox=bbox,
            resolution=129, **kwargs,
        )

    def test_is_deterministic(self):
        np.testing.assert_array_equal(
            self._delta(_cells(FACE)), self._delta(_cells(FACE)),
        )

    def test_cascade_carries_more_relief_than_single_band(self):
        # The whole point: the d13 texture's shading must represent bands
        # d13..d15, not just its own — otherwise deeper LODs differ again.
        cascade = self._delta(_cells(FACE))
        single = self._delta(_cells(FACE), extra_bands=0)
        self.assertGreater(float(np.std(cascade)), float(np.std(single)))

    def test_water_is_flat(self):
        water = np.zeros((65, 65), dtype=bool)
        water[:, :16] = True
        delta = self._delta(_cells(FACE), water_mask=water)
        self.assertTrue(np.all(delta[:, :16] == 0.0))

    def test_adjacent_quads_agree_at_shared_border(self):
        # Shading fences were the whole bug class: the cascade delta must be
        # world-pure so two neighboring d12 quads bake identical shading
        # along their shared edge.
        rng = np.random.default_rng(5)
        field = rng.integers(3, 12, size=(32, 64)).astype(np.uint8)
        field_bbox = (0.0, 0.0, 1320.0, 660.0)
        west = macro_cascade_delta(
            self.flat, (0.0, 0.0, 660.0, 660.0),
            archetype_cells=field, archetype_bbox=field_bbox, resolution=129,
        )
        east = macro_cascade_delta(
            self.flat, (660.0, 0.0, 1320.0, 660.0),
            archetype_cells=field, archetype_bbox=field_bbox, resolution=129,
        )
        np.testing.assert_array_equal(west[:, -1], east[:, 0])


class WorldBilinearTest(unittest.TestCase):
    def test_clamps_outside_and_interpolates_inside(self):
        field = np.asarray([[0.0, 1.0], [2.0, 3.0]])
        bbox = (0.0, 0.0, 2.0, 2.0)
        # Far outside clamps to the nearest border cell.
        self.assertEqual(
            float(_world_bilinear(field, bbox, np.asarray(-10.0), np.asarray(-10.0))),
            0.0,
        )
        # Dead center interpolates all four cells.
        self.assertAlmostEqual(
            float(_world_bilinear(field, bbox, np.asarray(1.0), np.asarray(1.0))),
            1.5,
        )


class ShadeTextureWithReliefTest(unittest.TestCase):
    def _grey_jpeg(self, size=64, value=128):
        import io

        from PIL import Image

        buffer = io.BytesIO()
        Image.new("RGB", (size, size), (value, value, value)).save(
            buffer, format="JPEG",
        )
        return buffer.getvalue()

    def _mean_pixel(self, jpeg_bytes):
        import io

        from PIL import Image

        with Image.open(io.BytesIO(jpeg_bytes)) as image:
            return float(np.asarray(image.convert("L"), dtype=np.float64).mean())

    def test_flat_delta_leaves_photo_untouched(self):
        bbox = (0.0, 0.0, 330.0, 330.0)
        shaded = shade_texture_with_relief(
            self._grey_jpeg(), np.zeros((65, 65)), bbox,
        )
        self.assertAlmostEqual(self._mean_pixel(shaded), 128.0, delta=2.0)

    def test_south_faces_brighten_north_faces_darken(self):
        bbox = (0.0, 0.0, 330.0, 330.0)
        rows = np.arange(65, dtype=np.float64)[:, None]
        # Delta rising northward (south-first rows) = a south-facing slope.
        south_facing = np.broadcast_to(rows * 3.0, (65, 65))
        north_facing = np.broadcast_to(-rows * 3.0, (65, 65))
        bright = self._mean_pixel(
            shade_texture_with_relief(self._grey_jpeg(), south_facing, bbox),
        )
        dark = self._mean_pixel(
            shade_texture_with_relief(self._grey_jpeg(), north_facing, bbox),
        )
        self.assertGreater(bright, 129.0)
        self.assertLess(dark, 127.0)

    def test_shading_is_clamped(self):
        bbox = (0.0, 0.0, 330.0, 330.0)
        rows = np.arange(65, dtype=np.float64)[:, None]
        # Absurdly steep wall — the multiplier must stay inside the clamp.
        cliff = np.broadcast_to(-rows * 50.0, (65, 65))
        dark = self._mean_pixel(
            shade_texture_with_relief(self._grey_jpeg(), cliff, bbox),
        )
        self.assertGreaterEqual(dark, 128.0 * MACRO_SHADE_RANGE[0] - 3.0)

    def test_is_deterministic(self):
        bbox = (0.0, 0.0, 330.0, 330.0)
        rng = np.random.default_rng(3)
        delta = rng.normal(0.0, 2.0, size=(65, 65))
        first = shade_texture_with_relief(self._grey_jpeg(), delta, bbox)
        second = shade_texture_with_relief(self._grey_jpeg(), delta, bbox)
        self.assertEqual(first, second)

    def test_adjacent_rough_and_calm_quads_get_equal_tone(self):
        # END-TO-END reproduction of the d14 seam bug (2026-07-23): a crag-
        # heavy FACE quad cooked next to a gentle BENCH quad, each shading
        # its own texture independently through the real pipeline. The bug
        # was a shading formula whose mean tracked gradient variance — the
        # rough quad dimmed as a whole and every cook border became a
        # brightness fence. Contract: per-quad mean tone is invariant to
        # relief roughness.
        flat = np.full((65, 65), 300.0, dtype=np.float32)
        means = {}
        for name, archetype in (("face", FACE), ("bench", BENCH)):
            bbox = (0.0, 0.0, 660.0, 660.0)
            base, sculpted = macro_surfaces(
                flat, bbox, 13,
                archetype_cells=_cells(archetype), archetype_bbox=bbox,
            )
            shaded = shade_texture_with_relief(
                self._grey_jpeg(), sculpted - base, bbox,
            )
            means[name] = self._mean_pixel(shaded)
        self.assertAlmostEqual(means["face"], 128.0, delta=2.5)
        self.assertAlmostEqual(means["bench"], 128.0, delta=2.5)
        self.assertAlmostEqual(means["face"], means["bench"], delta=2.0)

    def test_rough_relief_does_not_shift_quad_tone(self):
        # The seam-step regression: shading a rough quad must not change its
        # OVERALL tone, or every cook boundary shows as a brightness fence.
        bbox = (0.0, 0.0, 330.0, 330.0)
        rng = np.random.default_rng(11)
        delta = rng.normal(0.0, 1.5, size=(65, 65))
        mean = self._mean_pixel(
            shade_texture_with_relief(self._grey_jpeg(), delta, bbox),
        )
        self.assertAlmostEqual(mean, 128.0, delta=2.5)


class MacroArchetypeFieldTest(unittest.TestCase):
    def test_pads_with_neighbor_strips_and_replicates_missing(self):
        import serve

        center = (np.arange(16, dtype=np.uint8) % 12).reshape(4, 4)
        north = np.full((4, 4), np.uint8(9))

        def stored_resolver(db, tile_id, **kwargs):
            if tile_id == "12-100-101":  # row + 1 = north neighbor
                return north
            return None

        with patch(
            "classifier.archetypes.resolve_archetype_window",
            side_effect=stored_resolver,
        ):
            cells, field_bbox = serve.macro_archetype_field(
                None, "12-100-100", resolver=lambda tile_id: center,
            )
        self.assertEqual(cells.shape, (6, 6))
        np.testing.assert_array_equal(cells[1:-1, 1:-1], center)
        # North strip (image row 0) carries the north neighbor's SOUTH edge.
        np.testing.assert_array_equal(cells[0, 1:-1], north[-1])
        # Unclassified neighbors replicate our own border cells.
        np.testing.assert_array_equal(cells[-1, 1:-1], center[-1])
        np.testing.assert_array_equal(cells[1:-1, 0], center[:, 0])
        # The padded bbox extends the d12 bbox by exactly one cell each side.
        from database import _tile_bbox
        x_min, y_min, x_max, y_max = _tile_bbox(12, 100, 100)
        cell = (x_max - x_min) / 4
        self.assertAlmostEqual(field_bbox[0], x_min - cell)
        self.assertAlmostEqual(field_bbox[3], y_max + cell)

    def test_returns_none_without_classification(self):
        import serve

        with patch(
            "classifier.archetypes.resolve_archetype_window",
            return_value=None,
        ):
            cells, field_bbox = serve.macro_archetype_field(None, "12-100-100")
        self.assertIsNone(cells)
        self.assertIsNone(field_bbox)


if __name__ == "__main__":
    unittest.main()
