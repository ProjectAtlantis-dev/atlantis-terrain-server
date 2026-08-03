import unittest
from typing import cast

import numpy as np
from scipy import ndimage

from classifier.segmentation import (
    SegmentationConfig,
    render_boundaries,
    segment_terrain_tile,
    terrain_feature_channels,
)


class TerrainSegmentationTest(unittest.TestCase):
    def test_heightmap_is_flipped_to_image_orientation(self):
        rgb = np.zeros((8, 8, 3), dtype=np.uint8)
        # DB row zero is south: elevation increases toward north.
        heightmap = np.repeat(
            np.linspace(0, 70, 8, dtype=np.float32)[:, None], 8, axis=1
        )
        channels = terrain_feature_channels(rgb, heightmap, 70.0)
        self.assertGreater(
            float(channels["elevation"][0].mean()),
            float(channels["elevation"][-1].mean()),
        )

    def test_geometry_contributes_boundaries_with_uniform_color(self):
        rgb = np.full((64, 64, 3), 100, dtype=np.uint8)
        heightmap = np.zeros((17, 17), dtype=np.float32)
        heightmap[:, 9:] = 120.0
        result = segment_terrain_tile(
            rgb,
            heightmap,
            160.0,
            SegmentationConfig(target_segment_m=40.0, image_blur_pixels=0),
        )
        cost = result.channels["boundary_cost"]
        center_cost = float(cost[:, 30:38].mean())
        outer_cost = float(np.concatenate((cost[:, :16], cost[:, 48:]), 1).mean())
        self.assertGreater(center_cost, outer_cost + 20)

    def test_southness_is_an_independent_image_aligned_feature(self):
        rgb = np.full((8, 8, 3), 100, dtype=np.uint8)
        # DB rows progress south -> north. Rising north means a south-facing
        # surface, and flipping to image orientation must not change its sign.
        heightmap = np.repeat(
            np.linspace(0, 40, 5, dtype=np.float32)[:, None], 5, axis=1
        )
        channels = terrain_feature_channels(rgb, heightmap, 40.0)
        self.assertGreater(float(channels["southness"].mean()), 0.5)
        self.assertIn("insolation", channels)

    def test_official_water_mask_overrides_elevation_fallback(self):
        rgb = np.full((8, 8, 3), 100, dtype=np.uint8)
        heightmap = np.full((5, 5), 150.0, dtype=np.float32)
        official = np.zeros((8, 8), dtype=bool)
        official[:, :3] = True
        channels = terrain_feature_channels(
            rgb, heightmap, 40.0, water_mask=official
        )
        np.testing.assert_array_equal(channels["water"], official.astype(np.float32))

    def test_official_water_mask_must_match_classifier_pixels(self):
        with self.assertRaisesRegex(ValueError, "water_mask shape"):
            terrain_feature_channels(
                np.zeros((8, 8, 3), dtype=np.uint8),
                np.zeros((5, 5), dtype=np.float32),
                40.0,
                water_mask=np.zeros((5, 5), dtype=bool),
            )

    def test_labels_are_dense_and_statistics_cover_every_pixel(self):
        rgb = np.zeros((48, 64, 3), dtype=np.uint8)
        rgb[:, 32:] = (220, 230, 240)
        heightmap = np.repeat(
            np.linspace(0, 40, 13, dtype=np.float32)[:, None], 17, axis=1
        )
        result = segment_terrain_tile(rgb, heightmap, 120.0)
        self.assertEqual(result.labels.shape, rgb.shape[:2])
        self.assertEqual(result.labels.min(), 0)
        self.assertEqual(result.labels.max() + 1, len(result.regions))
        self.assertEqual(
            sum(region["pixel_count"] for region in result.regions),
            rgb.shape[0] * rgb.shape[1],
        )
        for region_id in range(len(result.regions)):
            _, component_count = cast(
                tuple[np.ndarray, int],
                ndimage.label(result.labels == region_id),
            )
            self.assertEqual(component_count, 1)
        self.assertEqual(render_boundaries(rgb, result.labels).shape, rgb.shape)

    def test_sparse_dem_holes_are_filled_but_empty_dem_is_rejected(self):
        rgb = np.zeros((8, 8, 3), dtype=np.uint8)
        heightmap = np.zeros((5, 5), dtype=np.float32)
        heightmap[2, 2] = np.nan
        result = segment_terrain_tile(rgb, heightmap, 40.0)
        self.assertTrue(np.isfinite(result.channels["elevation"]).all())
        with self.assertRaisesRegex(ValueError, "no finite samples"):
            segment_terrain_tile(rgb, np.full((5, 5), np.nan), 40.0)


if __name__ == "__main__":
    unittest.main()
