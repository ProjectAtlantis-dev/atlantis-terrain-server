import unittest
from unittest.mock import patch

from shapely.geometry import Polygon

import gtk50_vector


class _Ground:
    def __init__(self, value):
        self.value = value
        self.samples = []

    def sample(self, x, y):
        self.samples.append((x, y))
        return self.value


class Gtk50StructureTests(unittest.TestCase):
    def test_camera_bbox_returns_local_extrusion_with_sampled_ground(self):
        polygon = Polygon([(10, 20), (30, 20), (30, 40), (10, 40)])
        ground = _Ground(125.0)
        with (
            patch.object(gtk50_vector, "blocks_for_bbox", return_value=["1_01"]),
            patch.object(
                gtk50_vector,
                "_load_structures",
                return_value=[("gtk50:test", polygon, 8.0, "building_s")],
            ),
        ):
            result = gtk50_vector.query_structures(
                (0, 0, 50, 50), ground_sampler=ground, ox=5, oy=10
            )

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["groundZ"], 125.0)
        self.assertEqual(result[0]["ring"][0], [5.0, 10.0, 133.0])
        self.assertEqual(result[0]["sourceLayer"], "building_s")
        self.assertEqual(result[0]["_center"], [15.0, 20.0])
        self.assertEqual(len(ground.samples), 1)

    def test_power_station_preserves_source_layer_and_gets_default_height(self):
        polygon = Polygon([(0, 0), (2, 0), (2, 2), (0, 2)])
        with (
            patch.object(gtk50_vector, "blocks_for_bbox", return_value=["1_01"]),
            patch.object(
                gtk50_vector,
                "_load_structures",
                return_value=[
                    ("gtk50:station", polygon, None, "electricpowerstation_s")
                ],
            ),
        ):
            result = gtk50_vector.query_structures(
                (-1, -1, 3, 3), ground_sampler=_Ground(None), ox=0, oy=0
            )

        self.assertEqual(result[0]["sourceLayer"], "electricpowerstation_s")
        self.assertNotIn("b", result[0])
        self.assertNotIn("use", result[0])
        self.assertEqual(result[0]["groundZ"], 0.0)
        self.assertEqual(result[0]["ring"][0][2], 5.0)

    def test_structures_outside_camera_bbox_are_skipped(self):
        polygon = Polygon([(100, 100), (110, 100), (110, 110), (100, 110)])
        ground = _Ground(1.0)
        with (
            patch.object(gtk50_vector, "blocks_for_bbox", return_value=["1_01"]),
            patch.object(
                gtk50_vector,
                "_load_structures",
                return_value=[("gtk50:far", polygon, 5.0, "building_s")],
            ),
        ):
            result = gtk50_vector.query_structures(
                (0, 0, 50, 50), ground_sampler=ground, ox=0, oy=0
            )

        self.assertEqual(result, [])
        self.assertEqual(ground.samples, [])


if __name__ == "__main__":
    unittest.main()
