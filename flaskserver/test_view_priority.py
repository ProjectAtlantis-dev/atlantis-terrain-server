"""View-priority ordering for the missing-heightmap fetch batch."""

import math
import unittest

from serve import bbox_view_priority


def _bbox_at(cx, cy, size=100.0):
    half = size / 2
    return [cx - half, cy - half, cx + half, cy + half]


class TestBboxViewPriority(unittest.TestCase):
    def test_ahead_beats_behind_at_equal_distance(self):
        # Heading 0 = north = +y (fwd taken from -sin/cos convention).
        fwd_x, fwd_y = -math.sin(0.0), math.cos(0.0)
        ahead = bbox_view_priority(0, 0, fwd_x, fwd_y, _bbox_at(0, 1000))
        behind = bbox_view_priority(0, 0, fwd_x, fwd_y, _bbox_at(0, -1000))
        self.assertLess(ahead, behind)
        # Behind is penalized by the 0.01 dot floor: 100x distance.
        self.assertGreater(behind, ahead * 50)

    def test_near_ahead_beats_far_ahead(self):
        fwd_x, fwd_y = 0.0, 1.0
        near = bbox_view_priority(0, 0, fwd_x, fwd_y, _bbox_at(0, 500))
        far = bbox_view_priority(0, 0, fwd_x, fwd_y, _bbox_at(0, 5000))
        self.assertLess(near, far)

    def test_camera_inside_tile_is_top_priority(self):
        self.assertEqual(bbox_view_priority(0, 0, 0.0, 1.0, _bbox_at(0, 0)), 0.0)

    def test_matches_texture_priority_shape(self):
        # Same formula as serve_flask._tile_priority: dist / max(dot, 0.01).
        fwd_x, fwd_y = 0.0, 1.0
        diagonal = bbox_view_priority(0, 0, fwd_x, fwd_y, _bbox_at(1000, 1000))
        expected = math.hypot(1000, 1000) / (1000 / math.hypot(1000, 1000))
        self.assertAlmostEqual(diagonal, expected, places=6)


if __name__ == "__main__":
    unittest.main()
