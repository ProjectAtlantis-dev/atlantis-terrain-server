import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class FakeDb:
  """Reports every target as unmasked, so all of them get queued."""

  def execute(self, sql, params=()):
    return []


class CoastlineDemandOrderTest(unittest.TestCase):
  def setUp(self):
    import serve_flask
    self.sf = serve_flask
    # Never actually start the worker thread.
    self._saved_thread = serve_flask._coastline_demand_thread
    serve_flask._coastline_demand_thread = _AlivePlaceholder()
    serve_flask._coastline_demand_active = None
    serve_flask._coastline_demand_pending = {}

  def tearDown(self):
    self.sf._coastline_demand_thread = self._saved_thread
    self.sf._coastline_demand_pending = {}

  def _bbox(self, x, y, size=100.0):
    return (x, y, x + size, y + size)

  def test_queue_is_ordered_nearest_first(self):
    targets = {
      "far": self._bbox(10_000.0, 0.0),
      "near": self._bbox(100.0, 0.0),
      "middle": self._bbox(2_000.0, 0.0),
    }
    self.sf._schedule_coastline_demand(FakeDb(), targets, camera=(0.0, 0.0))
    self.assertEqual(
      list(self.sf._coastline_demand_pending), ["near", "middle", "far"],
    )

  def test_distance_uses_the_nearest_edge_not_the_centre(self):
    # A coarse tile the camera sits inside must sort ahead of a small tile
    # nearby: its centre is far away, but the camera is standing on it.
    targets = {
      "enclosing": (-20_000.0, -20_000.0, 20_000.0, 20_000.0),
      "small_nearby": self._bbox(500.0, 0.0),
    }
    self.sf._schedule_coastline_demand(FakeDb(), targets, camera=(0.0, 0.0))
    self.assertEqual(
      list(self.sf._coastline_demand_pending)[0], "enclosing",
    )

  def test_without_a_camera_the_targets_are_left_alone(self):
    targets = {"a": self._bbox(9_000.0, 0.0), "b": self._bbox(10.0, 0.0)}
    self.sf._schedule_coastline_demand(FakeDb(), targets)
    self.assertEqual(list(self.sf._coastline_demand_pending), ["a", "b"])

  def test_the_in_flight_tile_is_not_requeued(self):
    self.sf._coastline_demand_active = "near"
    targets = {"near": self._bbox(10.0, 0.0), "far": self._bbox(9_000.0, 0.0)}
    self.sf._schedule_coastline_demand(FakeDb(), targets, camera=(0.0, 0.0))
    self.assertEqual(list(self.sf._coastline_demand_pending), ["far"])


class _AlivePlaceholder:
  def is_alive(self):
    return True


if __name__ == "__main__":
  unittest.main()
