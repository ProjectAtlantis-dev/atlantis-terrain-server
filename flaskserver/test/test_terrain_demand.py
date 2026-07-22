"""Terrain demand coverage and LOD-history behavior."""

import unittest
from unittest.mock import patch

from serve import (
    _UPGRADEABLE_SOURCES,
    _balance_lod_leaves, _coarse_lod_neighbors, _lod_complete_ancestors,
    _lod_leaf_descendants_cover, _lod_target_depth,
    _traverse, bbox_in_view_circle,
)


def _bbox_at(cx, cy, size=100.0):
    half = size / 2
    return [cx - half, cy - half, cx + half, cy + half]


class TestViewCoverageCircle(unittest.TestCase):
    def test_parent_resampled_tiles_remain_visible_upgrade_candidates(self):
        self.assertIn('parent_resampled', _UPGRADEABLE_SOURCES)

    def test_lod_history_requires_complete_descendant_coverage(self):
        complete = {'12-20-40', '12-21-40', '12-20-41', '12-21-41'}
        self.assertTrue(_lod_leaf_descendants_cover(11, 10, 20, complete))
        complete.remove('12-21-41')
        self.assertFalse(_lod_leaf_descendants_cover(11, 10, 20, complete))

    def test_traversal_uses_a_lower_threshold_to_coarsen(self):
        parent = {
            'source': 'arcticdem', 'bbox': [100, 0, 200, 100],
            'geometric_error': 0.08,
        }
        child = {
            'source': 'arcticdem', 'bbox': [100, 0, 150, 50],
            'geometric_error': 0.01,
        }
        previous = {'12-20-40', '12-21-40', '12-20-41', '12-21-41'}

        def metadata(_db, tile_id):
            return parent if tile_id == '11-10-20' else child

        without_history, with_history = [], []
        with patch('serve.read_tile_metadata', side_effect=metadata):
            _traverse(
                None, 11, 10, 20, 0, 0, 12, 0.001,
                without_history, [], max_range=0,
            )
            _traverse(
                None, 11, 10, 20, 0, 0, 12, 0.001,
                with_history, [], max_range=0,
                previous_subdivided=_lod_complete_ancestors(previous),
            )
        self.assertEqual(without_history, ['11-10-20'])
        self.assertEqual(set(with_history), previous)

    def test_radial_lod_curve_uses_every_depth_before_the_rim(self):
        max_range = 16000
        self.assertEqual(_lod_target_depth(0, max_range, 12), 12)
        self.assertEqual(_lod_target_depth(4000, max_range, 12), 12)
        self.assertEqual(_lod_target_depth(4001, max_range, 12), 11)
        self.assertEqual(_lod_target_depth(7000, max_range, 12), 11)
        self.assertEqual(_lod_target_depth(7001, max_range, 12), 10)
        self.assertEqual(_lod_target_depth(10000, max_range, 12), 10)
        self.assertEqual(_lod_target_depth(10001, max_range, 12), 9)
        self.assertEqual(_lod_target_depth(13000, max_range, 12), 9)
        self.assertEqual(_lod_target_depth(13001, max_range, 12), 8)
        self.assertEqual(_lod_target_depth(16000, max_range, 12), 8)

        # A very large view range must not expand the depth-12 plateau.
        self.assertEqual(_lod_target_depth(4000, 50000, 12), 12)
        self.assertLess(_lod_target_depth(4001, 50000, 12), 12)

    def test_radial_lod_floor_is_always_depth_eight_when_reachable(self):
        # A shallower internal caller must not produce a depth-6 rim.
        self.assertEqual(_lod_target_depth(16000, 16000, 10), 8)
        self.assertEqual(_lod_target_depth(16000, 16000, 12), 8)

        # A future finer dataset must retain that same floor.
        self.assertEqual(_lod_target_depth(16000, 16000, 13), 8)
        self.assertEqual(_lod_target_depth(16000, 16000, 14), 8)

    def test_lod_neighbor_balance_detects_only_gaps_larger_than_one(self):
        # 8-1-1 spans depth-10 cells [4..7] in both axes. 10-8-4 touches
        # its east edge directly, so the depth-8 leaf must refine to depth 9.
        leaves = {'8-1-1', '10-8-4'}
        self.assertEqual(_coarse_lod_neighbors(leaves), {(8, 1, 1)})

        # A depth-9 buffer is already a valid 2:1 transition.
        balanced = {'8-1-1', '9-4-2', '10-10-4'}
        self.assertEqual(_coarse_lod_neighbors(balanced), set())

    def test_lod_neighbor_balance_refines_only_the_coarse_side(self):
        child = {
            'source': 'arcticdem', 'bbox': [900, 0, 950, 50],
            'geometric_error': 0.0,
        }
        leaves = ['8-1-1', '10-8-4']

        with (
            patch('serve.read_tile_metadata', return_value=child),
            patch('serve._tile_bbox', return_value=child['bbox']),
        ):
            refined = _balance_lod_leaves(
                None, leaves, [], 0, 0, 12, 1.0, 1000, 0.0, set(),
            )

        self.assertEqual(refined, 1)
        self.assertNotIn('8-1-1', leaves)
        self.assertIn('10-8-4', leaves)
        self.assertEqual(
            {tile_id for tile_id in leaves if tile_id.startswith('9-')},
            {'9-2-2', '9-3-2', '9-2-3', '9-3-3'},
        )
        self.assertEqual(_coarse_lod_neighbors(leaves), set())

    def test_large_geometric_error_cannot_refine_past_radial_ceiling(self):
        parent = {
            'source': 'arcticdem', 'bbox': [900, 0, 1000, 100],
            'geometric_error': 1000,
        }
        child = {
            'source': 'arcticdem', 'bbox': [900, 0, 950, 50],
            'geometric_error': 1000,
        }

        def metadata(_db, tile_id):
            return parent if tile_id == '10-1-1' else child

        results = []
        with patch('serve.read_tile_metadata', side_effect=metadata):
            _traverse(
                None, 10, 1, 1, 0, 0, 11, 0.0005,
                results, [], max_range=1000,
            )

        # The parent lies in the coarse outer 15% of the demand circle. Its
        # huge measured terrain error must not override the radial ceiling.
        self.assertEqual(results, ['10-1-1'])

    def test_coarse_tile_intruding_into_fine_band_must_subdivide(self):
        parent = {
            'source': 'arcticdem', 'bbox': [3900, 0, 4500, 600],
            'geometric_error': 1000,
        }
        child = {
            'source': 'arcticdem', 'bbox': [3900, 0, 4200, 300],
            'geometric_error': 1000,
        }

        def metadata(_db, tile_id):
            return parent if tile_id == '11-1-1' else child

        results = []
        with patch('serve.read_tile_metadata', side_effect=metadata):
            _traverse(
                None, 11, 1, 1, 0, 0, 12, 0.000001,
                results, [], max_range=16000,
            )

        # The parent center is outside the 4 km depth-12 band, but its near
        # edge intrudes into it. It must not remain as one coarse neighbor.
        self.assertEqual(set(results), {
            '12-2-2', '12-3-2', '12-2-3', '12-3-3',
        })

    def test_radial_curve_keeps_depth_eight_coverage_at_rim(self):
        metadata = {
            'source': 'arcticdem', 'bbox': [900, 0, 1000, 100],
            'geometric_error': 0.00001,
        }
        results = []
        with patch('serve.read_tile_metadata', return_value=metadata):
            _traverse(
                None, 7, 1, 1, 0, 0, 12, 1.0,
                results, [], max_range=1000, altitude=10000,
            )

        self.assertEqual(set(results), {
            '8-2-2', '8-3-2', '8-2-3', '8-3-3',
        })

    def test_uses_the_configured_radius_in_every_direction(self):
        for x, y in ((0, 900), (0, -900), (900, 0), (-900, 0)):
            self.assertTrue(bbox_in_view_circle(
                0, 0, _bbox_at(x, y, 10), 1000
            ))
        for x, y in ((0, 1100), (0, -1100), (1100, 0), (-1100, 0)):
            self.assertFalse(bbox_in_view_circle(
                0, 0, _bbox_at(x, y, 10), 1000
            ))

    def test_large_rim_tile_is_kept_when_its_bbox_reaches_the_circle(self):
        tile_bbox = [900, -500, 1900, 500]
        tile_center = [1400, 0, 1400, 0]

        self.assertTrue(bbox_in_view_circle(0, 0, tile_bbox, 1000))
        self.assertFalse(bbox_in_view_circle(0, 0, tile_center, 1000))

    def test_traversal_does_not_return_greenland_wide_outside_parent(self):
        metadata = {
            "source": "arcticdem",
            "bbox": [2000, 2000, 3000, 3000],
            "geometric_error": 100,
        }
        results, missing = [], []
        with patch("serve.read_tile_metadata", return_value=metadata):
            _traverse(
                None, 1, 0, 0, 0, 0, 10, 0.001,
                results, missing, max_range=1000,
            )
        self.assertEqual(results, [])
        self.assertEqual(missing, [])


if __name__ == "__main__":
    unittest.main()
