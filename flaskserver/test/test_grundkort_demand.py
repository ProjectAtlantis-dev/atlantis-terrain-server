import unittest

from grundkort import GrundkortDemand


class _Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class GrundkortDemandTests(unittest.TestCase):
    def _demand(self, *, loaded=(), acquire=None, clock=None):
        state = {"loaded": set(loaded), "acquired": []}

        def do_acquire(folder):
            if acquire is not None:
                acquire(folder)
            state["acquired"].append(folder)
            state["loaded"].add(folder)

        demand = GrundkortDemand(
            centres=(("near", 100.0, 100.0), ("far", 100_000.0, 100_000.0)),
            acquire=do_acquire,
            loaded=lambda folder: folder in state["loaded"],
            radius_m=1_000.0,
            retry_after_s=300.0,
            clock=clock or _Clock(),
        )
        demand._pool.submit = lambda fn, *args, **kwargs: fn(*args, **kwargs)
        return demand, state

    def test_disabled_scheduler_never_acquires(self):
        demand, state = self._demand()
        self.assertEqual(demand.request_for_point(100.0, 100.0), [])
        self.assertEqual(state["acquired"], [])

    def test_camera_position_only_acquires_nearby_unloaded_settlement(self):
        demand, state = self._demand()
        demand.enable()
        self.assertEqual(demand.request_for_point(100.0, 100.0), ["near"])
        self.assertEqual(state["acquired"], ["near"])
        self.assertEqual(demand.request_for_point(100.0, 100.0), [])
        self.assertEqual(demand.request_for_point(100_000.0, 100_000.0), ["far"])

    def test_failed_acquisition_backs_off_until_later_camera_demand(self):
        clock = _Clock()
        attempts = []

        def fail_once(folder):
            attempts.append(folder)
            if len(attempts) == 1:
                raise RuntimeError("offline")

        demand, state = self._demand(acquire=fail_once, clock=clock)
        demand.enable()
        self.assertEqual(demand.request_for_point(100.0, 100.0), ["near"])
        self.assertEqual(demand.request_for_point(100.0, 100.0), [])
        clock.now = 301.0
        self.assertEqual(demand.request_for_point(100.0, 100.0), ["near"])
        self.assertEqual(state["acquired"], ["near"])


if __name__ == "__main__":
    unittest.main()
