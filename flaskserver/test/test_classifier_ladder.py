"""The classification ladder: DEM co-proposes, never just color.

Covers the properties per-tile percentiles could never give:
  - a uniform tile stays entirely GREY (no forced DARK/WHITE fractions),
  - shadow is a first-class bucket split from dark by sun geometry,
  - the DEM vegetation prior gates GREEN (nothing living on north slopes,
    weak color believed only on strong prior),
  - macro grain measures the NE-SW structural strike from a heightmap.
"""

import os
import unittest

import numpy as np

os.environ.setdefault("DATAFORSYNINGEN_TOKEN", "test-token")

from classifier.ladder import (
    BEACH, DARK, GREEN, GREY, SHADOW, WATER, WHITE,
    _detect_beach, _split_shore_surfaces, _world_value_noise,
    _detect_lake_sheets,
    classify_ladder,
    macro_grain,
)

N = 129
SIZE = 256
BBOX = (0.0, 0.0, 659.18, 659.18)
GREEN_RGB = (90, 150, 70)
MID_GREY_RGB = (100, 100, 100)


def _flat_surface():
    return np.zeros((N, N), dtype=np.float32)


def _tilted_surface(rise_per_cell_north):
    """South-first rows rising northward → surface faces SOUTH."""
    cell = BBOX[2] / (N - 1)
    rows = np.arange(N, dtype=np.float32) * rise_per_cell_north * cell
    return np.repeat(rows[:, None], N, axis=1)


def _uniform_rgb(color):
    return np.tile(np.asarray(color, np.uint8), (SIZE, SIZE, 1))


class UniformTiles(unittest.TestCase):
    def test_uniform_mid_tile_is_all_grey(self):
        """No percentile artifacts: nothing forces DARK/WHITE to exist."""
        labels, _ = classify_ladder(
            _uniform_rgb(MID_GREY_RGB), _flat_surface(), BBOX,
            output_size=SIZE,
        )
        self.assertTrue(np.all(labels == GREY))

    def test_uniform_bright_tile_is_white(self):
        """Absolute thresholds: a genuinely bright tile is WHITE even
        though it has no per-tile brightness spread. Exposure gain is
        clipped, so a snowfield cannot normalize itself back to grey."""
        labels, _ = classify_ladder(
            _uniform_rgb((235, 235, 235)), _flat_surface(), BBOX,
            output_size=SIZE,
        )
        self.assertTrue(np.all(labels == WHITE))

    def test_uniform_dark_tile_is_dark_not_shadow_on_flat(self):
        """Flat ground is fully lit under the south sun: dark imagery on
        it is DARK ground, not shadow."""
        labels, _ = classify_ladder(
            _uniform_rgb((25, 25, 25)), _flat_surface(), BBOX,
            output_size=SIZE,
        )
        self.assertTrue(np.all(labels == DARK))


class ShadowRung(unittest.TestCase):
    def test_dark_north_slope_is_shadow(self):
        """Geometry + darkness = SHADOW, the first-class bucket."""
        surface = _tilted_surface(-0.6)  # falls northward → faces north
        labels, stats = classify_ladder(
            _uniform_rgb((25, 25, 25)), surface, BBOX, output_size=SIZE,
        )
        self.assertTrue(np.all(labels == SHADOW))
        self.assertGreater(stats["fractions"]["shadow"], 0.99)

    def test_bright_north_slope_is_not_shadow(self):
        """Geometry alone never makes shadow: the capture may be lit
        differently. Bright imagery on a north face stays non-shadow."""
        surface = _tilted_surface(-0.3)
        labels, _ = classify_ladder(
            _uniform_rgb((200, 200, 200)), surface, BBOX, output_size=SIZE,
        )
        self.assertFalse(np.any(labels == SHADOW))


class VegetationPrior(unittest.TestCase):
    def test_green_on_lit_flat_ground_stays_green(self):
        labels, _ = classify_ladder(
            _uniform_rgb(GREEN_RGB), _flat_surface(), BBOX, output_size=SIZE,
        )
        self.assertTrue(np.all(labels == GREEN))

    def test_hard_rule_nothing_living_on_north_slopes(self):
        """Green imagery on a north slope: the DEM prior kills the
        proposal before the veto even runs. Aspect beats imagery color."""
        surface = _tilted_surface(-0.2)
        labels, _ = classify_ladder(
            _uniform_rgb(GREEN_RGB), surface, BBOX, output_size=SIZE,
        )
        self.assertFalse(np.any(labels == GREEN))

    def test_weak_green_believed_only_on_strong_prior(self):
        """Ambiguous color (small green excess) needs the DEM to vouch:
        accepted on a lit gentle south slope, rejected on a steep one."""
        # excess must sit in (GREEN_WEAK_EXCESS, GREEN_MIN_EXCESS]: 8.
        weak_green = (104, 110, 100)
        gentle_south = _tilted_surface(0.1)
        labels, _ = classify_ladder(
            _uniform_rgb(weak_green), gentle_south, BBOX, output_size=SIZE,
        )
        self.assertTrue(np.any(labels == GREEN))

        steep = _tilted_surface(0.5)  # south-facing but far too steep
        labels, _ = classify_ladder(
            _uniform_rgb(weak_green), steep, BBOX, output_size=SIZE,
        )
        self.assertFalse(np.any(labels == GREEN))

    def test_no_vegetation_above_greenline(self):
        """Elevation is a proposer too: the same green reading high above
        the greenline cannot propose GREEN."""
        surface = _flat_surface() + 900.0
        labels, _ = classify_ladder(
            _uniform_rgb(GREEN_RGB), surface, BBOX, output_size=SIZE,
        )
        self.assertFalse(np.any(labels == GREEN))


class WaterAuthority(unittest.TestCase):
    def test_official_water_outranks_everything(self):
        mask = np.zeros((N, N), dtype=bool)
        mask[:, : N // 2] = True  # west half water
        labels, _ = classify_ladder(
            _uniform_rgb(GREEN_RGB), _flat_surface(), BBOX,
            water_mask=mask, lake_prior=np.zeros((SIZE, SIZE), dtype=bool),
            output_size=SIZE,
        )
        self.assertTrue(np.all(labels[:, : SIZE // 2 - 2] == WATER))
        self.assertTrue(np.all(labels[:, SIZE // 2 + 8:] == GREEN))
        self.assertTrue(np.any(labels[:, SIZE // 2: SIZE // 2 + 8] == BEACH))

    def test_dem_lake_sheet_becomes_lake_not_water(self):
        """A dark, flat, level basin inside brighter sloped land is a
        LAKE (DEM flat-sheet detection — the lakes missing from the
        official blue dataset), distinct from authority WATER, and it
        never proposes GREEN no matter how green the water reads."""
        surface = _tilted_surface(0.15)  # gentle lit south slope
        basin = np.s_[N // 4: 3 * N // 4, N // 4: 3 * N // 4]
        surface = surface.copy()
        surface[basin] = 40.0  # level sheet
        rgb = _uniform_rgb((120, 130, 110))
        dark_green_water = np.s_[
            SIZE // 4 + 4: 3 * SIZE // 4 - 4, SIZE // 4 + 4: 3 * SIZE // 4 - 4
        ]
        rgb[dark_green_water] = (20, 45, 25)  # dark water with a green lean
        labels, stats = classify_ladder(
            rgb, surface, BBOX,
            lake_prior=np.ones((SIZE, SIZE), dtype=bool),
            output_size=SIZE,
        )
        from classifier.ladder import LAKE
        center = labels[SIZE // 2 - 8: SIZE // 2 + 8,
                        SIZE // 2 - 8: SIZE // 2 + 8]
        self.assertTrue(np.all(center == LAKE))
        self.assertFalse(np.any(labels == WATER))
        self.assertGreater(stats["fractions"]["lake"], 0.1)

    def test_d10_d11_prior_vetoes_a_d12_only_phantom_lake(self):
        """A locally convincing D12 basin cannot originate inferred water
        when the broader ladder rungs found no lake at that location."""
        surface = _tilted_surface(0.15)
        basin = np.s_[N // 4: 3 * N // 4, N // 4: 3 * N // 4]
        surface = surface.copy()
        surface[basin] = 40.0
        rgb = _uniform_rgb((120, 130, 110))
        rgb[
            SIZE // 4 + 4: 3 * SIZE // 4 - 4,
            SIZE // 4 + 4: 3 * SIZE // 4 - 4,
        ] = (20, 45, 25)

        labels, stats = classify_ladder(
            rgb, surface, BBOX,
            lake_prior=np.zeros((SIZE, SIZE), dtype=bool),
            output_size=SIZE,
        )

        from classifier.ladder import LAKE
        self.assertFalse(np.any(labels == LAKE))
        self.assertGreater(stats["lake_candidate_fraction"], 0.1)
        self.assertEqual(stats["fractions"]["lake"], 0.0)
        self.assertTrue(stats["lake_prior_applied"])

    def test_supported_parent_hypothesis_keeps_d12_shoreline_detail(self):
        """Coarse parents authorize existence; they do not clip the precise
        D12 shoreline to their lower-resolution support cells."""
        candidate = np.zeros((32, 32), dtype=bool)
        candidate[6:26, 5:27] = True
        prior = np.zeros_like(candidate)
        prior[13:19, 13:19] = True

        from classifier.ladder import _gate_inferred_lakes
        gated = _gate_inferred_lakes(candidate, prior)

        np.testing.assert_array_equal(gated, candidate)
        self.assertFalse(np.any(_gate_inferred_lakes(candidate, None)))

    def test_lake_seed_flood_fills_same_level_noisy_edges(self):
        """A strict flat core seeds the lake, then shoreline DEM noise is
        recovered without flooding the brighter, higher surrounding land."""
        slope = np.full((12, 12), 0.12, dtype=np.float32)
        elev = np.full((12, 12), 44.0, dtype=np.float32)
        luminance = np.full((12, 12), 120.0, dtype=np.float32)
        slope[4:8, 4:8] = 0.01
        elev[4:8, 4:8] = 40.0
        luminance[4:8, 4:8] = 20.0
        slope[3:9, 3:9] = np.minimum(slope[3:9, 3:9], 0.10)
        elev[3:9, 3:9] = 40.8
        elev[4:8, 4:8] = 40.0
        # Flood growth is DEM-only: even an edge brighter than surrounding
        # land remains lake when it is connected at the water elevation.
        luminance[3:9, 3:9] = 250.0
        luminance[4:8, 4:8] = 20.0

        lake = _detect_lake_sheets(slope, elev, luminance)

        self.assertTrue(np.all(lake[3:9, 3:9]))
        self.assertFalse(np.any(lake[:2, :]))
        self.assertFalse(np.any(lake[:, :2]))

    def test_uniform_flat_dark_tile_stays_dark_not_lake(self):
        """With no brighter land to compare against, a uniformly dark
        flat tile cannot claim to be a lake — it stays DARK ground."""
        labels, stats = classify_ladder(
            _uniform_rgb((25, 25, 25)), _flat_surface(), BBOX,
            output_size=SIZE,
        )
        self.assertFalse(np.any(labels == WATER))
        self.assertEqual(stats["fractions"]["lake"], 0.0)

    def test_beach_covers_all_non_snow_land_within_terrain_shaped_reach(self):
        labels = np.full((9, 9), np.uint8(GREEN))
        labels[:, 0] = np.uint8(GREY)
        labels[4, 3] = np.uint8(WHITE)
        labels[3, 4] = np.uint8(WATER)
        waterish = np.zeros((9, 9), dtype=bool)
        waterish[4, 4] = True
        flat = np.zeros((9, 9), dtype=np.float32)

        beach = _detect_beach(labels, waterish, flat, 80.0)

        self.assertTrue(beach[4, 5])       # 10 m from water
        self.assertTrue(beach[3, 3])       # ~14.1 m diagonal
        self.assertFalse(beach[4, 6])      # 20 m away
        self.assertFalse(beach[4, 3])      # snow remains snow
        self.assertFalse(beach[3, 4])      # water remains water

        steep = np.full((9, 9), 0.5, dtype=np.float32)
        self.assertFalse(np.any(_detect_beach(
            labels, waterish, steep, 80.0,
        )))

    def test_shore_surface_split_is_deterministic_coherent_and_signal_biased(self):
        beach = np.ones((128, 128), dtype=bool)
        bbox = (-1000.0, -2000.0, -340.0, -1340.0)
        neutral_lum = np.full(beach.shape, 95.0, dtype=np.float32)
        neutral_slope = np.full(beach.shape, 0.08, dtype=np.float32)

        first = _split_shore_surfaces(
            beach, neutral_lum, neutral_slope, bbox,
        )
        second = _split_shore_surfaces(
            beach, neutral_lum, neutral_slope, bbox,
        )

        np.testing.assert_array_equal(first[0], second[0])
        np.testing.assert_array_equal(first[1], second[1])
        np.testing.assert_array_equal(first[0] | first[1], beach)
        self.assertTrue(np.any(first[0]))
        self.assertTrue(np.any(first[1]))
        # Coherent value noise produces patches, not independent pixel salt:
        # most horizontal neighbours make the same material decision.
        agreement = np.mean(first[0][:, 1:] == first[0][:, :-1])
        self.assertGreater(agreement, 0.93)

        bright_flat = _split_shore_surfaces(
            beach, np.full(beach.shape, 120.0),
            np.full(beach.shape, 0.02), bbox,
        )[0]
        dark_steep = _split_shore_surfaces(
            beach, np.full(beach.shape, 72.0),
            np.full(beach.shape, 0.24), bbox,
        )[0]
        self.assertGreater(np.mean(bright_flat), np.mean(dark_steep))

    def test_shore_noise_matches_at_adjacent_tile_edge(self):
        left = _world_value_noise(
            (0.0, 0.0, 660.0, 660.0), (129, 129), 36.0, 1234,
        )
        right = _world_value_noise(
            (660.0, 0.0, 1320.0, 660.0), (129, 129), 36.0, 1234,
        )
        np.testing.assert_allclose(left[:, -1], right[:, 0], atol=1e-12)


class MacroGrain(unittest.TestCase):
    def test_ne_sw_ridges_measure_45_degree_strike(self):
        """Ridges running NE-SW (the west-coast Greenland grain) → strike
        ~45°, strong anisotropy."""
        n = 129
        cell = 20000.0 / (n - 1)
        x = np.arange(n) * cell
        y = np.arange(n) * cell
        xx, yy = np.meshgrid(x, y)
        # Height varies along the NW-SE axis (x + y grows to the NE along
        # the diagonal; constant height along x - y... choose sin(x - y):
        # constant where x - y is constant — lines at 45°, i.e. NE-SW.
        surface = 200.0 * np.sin((xx - yy) / 1500.0)
        grain = macro_grain(surface.astype(np.float32), 20000.0)
        self.assertIsNotNone(grain["strike_deg"])
        self.assertGreater(grain["anisotropy"], 0.9)
        self.assertLess(min(abs(grain["strike_deg"] - 45.0),
                            abs(grain["strike_deg"] - 135.0)), 6.0)
        # Disambiguate: rows are south-first, +row = north. Lines of
        # constant x - y run from SW (small x, small y) to NE — compass
        # strike 45, not 135.
        self.assertLess(abs(grain["strike_deg"] - 45.0), 6.0)

    def test_isotropic_surface_reports_no_grain(self):
        rng = np.random.default_rng(7)
        surface = rng.normal(0, 1.0, (65, 65)).astype(np.float32)
        grain = macro_grain(surface, 20000.0)
        self.assertLess(grain["anisotropy"], 0.35)


if __name__ == "__main__":
    unittest.main()
