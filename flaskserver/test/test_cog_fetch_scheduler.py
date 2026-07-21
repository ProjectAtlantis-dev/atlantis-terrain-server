import unittest
from unittest.mock import patch

import serve_flask


class _ManualFuture:
    def __init__(self):
        self.callback = None
        self.outcome = None

    def add_done_callback(self, callback):
        self.callback = callback

    def result(self):
        return self.outcome

    def complete(self, outcome="fetched"):
        self.outcome = outcome
        self.callback(self)


class _ManualPool:
    def __init__(self):
        self.submissions = []
        self.futures = []

    def submit(self, function, tile_id, bbox):
        future = _ManualFuture()
        self.submissions.append((function, tile_id, bbox))
        self.futures.append(future)
        return future


class CogFetchSchedulerTests(unittest.TestCase):
    def test_tile_ancestor_ids_are_nearest_first(self):
        self.assertEqual(
            list(serve_flask._tile_ancestor_ids("3-6-5")),
            ["2-3-2", "1-1-1", "0-0-0"],
        )

    def test_invalid_tile_has_no_ancestors(self):
        self.assertEqual(list(serve_flask._tile_ancestor_ids("invalid")), [])

    def test_each_completion_backfills_without_waiting_for_siblings(self):
        pool = _ManualPool()
        initial = [
            (f"12-{index}-0", (index, 0, index + 1, 1)) for index in range(4)
        ]
        urgent = [("12-99-0", (99, 0, 100, 1)), initial[3]]

        with (
            patch.object(serve_flask, "_COG_TILE_WORKERS", 2),
            patch.object(serve_flask, "_cog_pool", pool),
            patch.object(serve_flask, "_cog_fetching_tiles", set()),
            patch.object(serve_flask, "_cog_pending_tiles", {}),
            patch.object(serve_flask, "_cog_demand_ids", set()),
            patch.object(serve_flask, "_cog_already_fetched", set()),
        ):
            self.assertEqual(serve_flask._schedule_cog_demand(initial), (2, 2))
            self.assertEqual(
                [submission[1] for submission in pool.submissions],
                ["12-0-0", "12-1-0"],
            )

            # A new camera request replaces only the two unstarted tiles.
            self.assertEqual(serve_flask._schedule_cog_demand(urgent), (2, 2))
            pool.futures[0].complete()
            self.assertEqual(
                [submission[1] for submission in pool.submissions],
                ["12-0-0", "12-1-0", "12-99-0"],
            )

            # The other original worker is still running: no wave barrier.
            self.assertIn("12-1-0", serve_flask._cog_fetching_tiles)
            self.assertIn("12-99-0", serve_flask._cog_fetching_tiles)


if __name__ == "__main__":
    unittest.main()
