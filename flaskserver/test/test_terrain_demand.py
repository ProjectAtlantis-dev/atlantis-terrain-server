"""Terrain demand coverage and LOD-history behavior."""

import unittest
from unittest.mock import patch

from serve import (
    _lod_complete_ancestors, _lod_leaf_descendants_cover, _traverse,
    bbox_in_view_circle,
)


def _bbox_at(cx, cy, size=100.0):
    half = size / 2
    return [cx - half, cy - half, cx + half, cy + half]


class TestViewCoverageCircle(unittest.TestCase):
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
                without_history, [], max_range=1000,
            )
            _traverse(
                None, 11, 10, 20, 0, 0, 12, 0.001,
                with_history, [], max_range=1000,
                previous_subdivided=_lod_complete_ancestors(previous),
            )
        self.assertEqual(without_history, ['11-10-20'])
        self.assertEqual(set(with_history), previous)

    def test_uses_the_configured_radius_in_every_direction(self):
        for x, y in ((0, 900), (0, -900), (900, 0), (-900, 0)):
            self.assertTrue(bbox_in_view_circle(
                0, 0, _bbox_at(x, y, 10), 1000
            ))
        for x, y in ((0, 1100), (0, -1100), (1100, 0), (-1100, 0)):
            self.assertFalse(bbox_in_view_circle(
                0, 0, _bbox_at(x, y, 10), 1000
            ))

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
