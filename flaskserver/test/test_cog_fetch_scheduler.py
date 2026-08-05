import os
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from unittest.mock import patch

import numpy as np

import ingest
import serve_flask


class _ManualFuture:
    def __init__(self):
        self.callback = None
        self.outcome = None

    def add_done_callback(self, callback):
        self.callback = callback

    def result(self):
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self.outcome

    def complete(self, outcome="fetched"):
        self.outcome = outcome
        assert self.callback is not None
        self.callback(self)


class _ManualPool:
    def __init__(self):
        self.submissions = []
        self.futures = []

    def submit(self, function, tile_id, bbox, origin):
        future = _ManualFuture()
        self.submissions.append((function, tile_id, bbox, origin))
        self.futures.append(future)
        return future


class CogFetchSchedulerTests(unittest.TestCase):
    def test_arctic_flat_sea_level_plate_is_not_terrain(self):
        ocean = np.linspace(-0.3, -0.2, 65 * 65, dtype=np.float32).reshape(65, 65)
        self.assertTrue(ingest._is_arctic_sea_level_plate(ocean))

        low_relief_land = ocean + np.float32(2.0)
        self.assertFalse(ingest._is_arctic_sea_level_plate(low_relief_land))

        coast = ocean.copy()
        coast[32, 32] = np.float32(4.0)
        self.assertFalse(ingest._is_arctic_sea_level_plate(coast))

    def test_authoritative_ocean_preflight_skips_all_cog_reads(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "t.db")
            db = sqlite3.connect(path)
            db.execute(
                "CREATE TABLE tiles (tile_id TEXT PRIMARY KEY, "
                "source TEXT, dem_requested_at TEXT)"
            )
            db.execute("INSERT INTO tiles (tile_id) VALUES ('10-326-208')")
            db.commit()
            db.close()

            with (
                patch.object(serve_flask, "DB_PATH", path),
                patch("serve._cache_coastline", return_value=np.ones((65, 65), dtype=bool)),
                patch("serve._mark_official_ocean") as mark_ocean,
                patch.object(
                    ingest, "_read_cog_heightmap",
                    side_effect=AssertionError("ocean preflight must skip COGs"),
                ),
            ):
                self.assertEqual(
                    serve_flask._fetch_one_cog_tile(
                        "10-326-208", (0.0, 0.0, 1.0, 1.0)
                    ),
                    "fetched",
                )
                mark_ocean.assert_called_once()

    def test_provider_ocean_classification_is_terminal(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "t.db")
            db = sqlite3.connect(path)
            db.execute(
                "CREATE TABLE tiles (tile_id TEXT PRIMARY KEY, "
                "source TEXT, dem_requested_at TEXT)"
            )
            db.execute(
                "INSERT INTO tiles (tile_id, source) VALUES "
                "('12-1359-785', 'parent_resampled')"
            )
            db.commit()
            db.close()

            with (
                patch.object(serve_flask, "DB_PATH", path),
                patch("serve._cache_coastline", return_value=None),
                patch("serve._mark_official_ocean") as mark_ocean,
                patch.object(
                    ingest, "_read_cog_heightmap",
                    return_value=(None, "official_ocean"),
                ),
                patch.object(
                    ingest, "_resample_from_parent",
                    side_effect=AssertionError("terminal ocean must not resample"),
                ),
            ):
                self.assertEqual(
                    serve_flask._fetch_one_cog_tile(
                        "12-1359-785", (0.0, 0.0, 1.0, 1.0)
                    ),
                    "fetched",
                )
                mark_ocean.assert_called_once()

    def test_each_provider_cog_attempt_emits_requested_and_completed_events(self):
        events = []

        @contextmanager
        def unavailable(_url):
            raise OSError("offline")
            yield

        with (
            patch.object(ingest, "_tiles_for_bbox", return_value=[(1, 2)]),
            patch.object(ingest, "_open_remote_cog", side_effect=unavailable),
        ):
            result = ingest._read_cog_heightmap(
                (0, 0, 1, 1), arctic_workers=1, audit=events.append
            )

        self.assertEqual(result, (None, None))
        attempts = [(event["stage"], event["provider"], event.get("outcome"))
                    for event in events]
        self.assertEqual(
            attempts,
            [
                ("cog_requested", "arcticdem", None),
                ("cog_completed", "arcticdem", "error"),
                ("cog_requested", "copernicus", None),
                ("cog_completed", "copernicus", "error"),
                ("cog_requested", "copernicus", None),
                ("cog_completed", "copernicus", "error"),
            ],
        )

    def test_past_contract_demand_cooks_and_never_reads_cog(self):
        # Regression: the cog-worker path fetched d13-d15 heightmaps straight
        # from 10m/30m COGs (interpolation mush, edges ignoring every
        # neighbor — raised square tile corners). Past-contract tiles must
        # route to the DEM cook, exactly like serve._fetch_tile.
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "t.db")
            db = sqlite3.connect(path)
            db.execute(
                "CREATE TABLE tiles (tile_id TEXT PRIMARY KEY, "
                "dem_requested_at TEXT, source TEXT)"
            )
            db.commit()
            db.close()
            bbox = (0.0, 0.0, 329.6, 329.6)
            with (
                patch.object(serve_flask, "DB_PATH", path),
                patch("serve._cook_cooked_dem_quad", return_value=True) as cook,
                patch.object(
                    ingest, "_read_cog_heightmap",
                    side_effect=AssertionError("COG read past the contract depth"),
                ),
            ):
                self.assertEqual(
                    serve_flask._fetch_one_cog_tile("13-2754-1568", bbox),
                    "fetched",
                )
                cook.assert_called_once()

            # A cook without a stable parent defers to the NEXT demand
            # refresh (not the immediate-requeue path — that would hot-loop
            # a worker on a millisecond-fast defer).
            with (
                patch.object(serve_flask, "DB_PATH", path),
                patch("serve._cook_cooked_dem_quad", return_value=False),
            ):
                self.assertEqual(
                    serve_flask._fetch_one_cog_tile("13-2754-1568", bbox),
                    "cook_deferred",
                )

    def test_request_timestamps_are_persisted_independently(self):
        db = sqlite3.connect(":memory:")
        db.execute(
            "CREATE TABLE tiles (tile_id TEXT PRIMARY KEY, "
            "dem_demanded_at TEXT, dem_requested_at TEXT, cog_requested_at TEXT)"
        )
        db.executemany(
            "INSERT INTO tiles (tile_id) VALUES (?)",
            (("12-1-1",), ("12-1-2",)),
        )

        count = serve_flask._record_dem_requests(
            db,
            [("12-1-1", (0, 0, 1, 1)), ("12-1-2", (1, 0, 2, 1))],
            requested_at="2026-07-21T10:00:00+00:00",
        )
        serve_flask._record_dem_request(
            db, "12-1-2", requested_at="2026-07-21T10:00:01+00:00"
        )

        self.assertEqual(count, 2)
        self.assertEqual(
            db.execute(
                "SELECT tile_id, dem_demanded_at, dem_requested_at, "
                "cog_requested_at "
                "FROM tiles ORDER BY tile_id"
            ).fetchall(),
            [
                ("12-1-1", "2026-07-21T10:00:00+00:00", None, None),
                (
                    "12-1-2",
                    "2026-07-21T10:00:00+00:00",
                    "2026-07-21T10:00:01+00:00",
                    None,
                ),
            ],
        )
        db.close()

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
            patch.object(serve_flask, "_cog_synthetic_retry_at", {}),
        ):
            self.assertEqual(
                serve_flask._schedule_cog_demand(
                    initial, origin="bathymetry"
                ),
                (2, 2),
            )
            self.assertEqual(
                [submission[1] for submission in pool.submissions],
                ["12-0-0", "12-1-0"],
            )
            self.assertEqual(
                [submission[3] for submission in pool.submissions],
                ["bathymetry", "bathymetry"],
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

    def test_synthetic_tile_reenters_visible_demand_after_cooldown(self):
        pool = _ManualPool()
        tile = ("12-7-9", (0, 0, 1, 1))
        with (
            patch.object(serve_flask, "_COG_TILE_WORKERS", 1),
            patch.object(serve_flask, "_cog_pool", pool),
            patch.object(serve_flask, "_cog_fetching_tiles", set()),
            patch.object(serve_flask, "_cog_pending_tiles", {}),
            patch.object(serve_flask, "_cog_demand_ids", set()),
            patch.object(serve_flask, "_cog_already_fetched", {tile[0]}),
            patch.object(serve_flask, "_cog_synthetic_retry_at", {tile[0]: 100}),
            patch.object(serve_flask.time, "time", return_value=101),
        ):
            self.assertEqual(
                serve_flask._schedule_cog_demand([], [tile]), (1, 0)
            )
            self.assertEqual([item[1] for item in pool.submissions], [tile[0]])

    def test_worker_exception_retries_visible_tile_after_backoff(self):
        pool = _ManualPool()
        tile = ("12-7-9", (0, 0, 1, 1))
        with (
            patch.object(serve_flask, "_COG_TILE_WORKERS", 1),
            patch.object(serve_flask, "_cog_pool", pool),
            patch.object(serve_flask, "_cog_fetching_tiles", set()),
            patch.object(serve_flask, "_cog_pending_tiles", {}),
            patch.object(serve_flask, "_cog_demand_ids", set()),
            patch.object(serve_flask, "_cog_already_fetched", set()),
            patch.object(serve_flask, "_cog_synthetic_retry_at", {}),
            patch.object(serve_flask, "_cog_failure_retry_at", {}),
            patch.object(serve_flask, "_cog_failure_attempts", {}),
            patch.object(serve_flask, "_COG_FAILURE_RETRY_BASE_SECONDS", 10),
            patch.object(serve_flask, "_COG_FAILURE_RETRY_MAX_SECONDS", 60),
            patch.object(serve_flask.time, "time", return_value=100) as now,
        ):
            self.assertEqual(serve_flask._schedule_cog_demand([tile]), (1, 0))
            pool.futures[0].complete(RuntimeError("worker exploded"))

            self.assertNotIn(tile[0], serve_flask._cog_fetching_tiles)
            self.assertEqual(len(pool.submissions), 1)
            self.assertEqual(serve_flask._cog_failure_retry_at, {tile[0]: 110})

            now.return_value = 109
            self.assertEqual(serve_flask._schedule_cog_demand([tile]), (0, 0))
            self.assertEqual(len(pool.submissions), 1)

            now.return_value = 110
            self.assertEqual(serve_flask._schedule_cog_demand([tile]), (1, 0))
            self.assertEqual(len(pool.submissions), 2)

            pool.futures[1].complete(RuntimeError("worker still offline"))
            self.assertEqual(len(pool.submissions), 2)
            self.assertEqual(serve_flask._cog_failure_retry_at, {tile[0]: 130})

    def test_overdue_synthetic_retry_waits_until_tile_is_visible(self):
        tile = ("12-7-9", (0, 0, 1, 1))
        retry_state = {tile[0]: 100}
        with (
            patch.object(serve_flask, "_cog_fetching_tiles", set()),
            patch.object(serve_flask, "_cog_pending_tiles", {}),
            patch.object(serve_flask, "_cog_demand_ids", set()),
            patch.object(serve_flask, "_cog_already_fetched", {tile[0]}),
            patch.object(serve_flask, "_cog_synthetic_retry_at", retry_state),
            patch.object(serve_flask.time, "time", return_value=101),
        ):
            self.assertEqual(serve_flask._schedule_cog_demand([]), (0, 0))
            self.assertEqual(retry_state, {tile[0]: 100})


if __name__ == "__main__":
    unittest.main()
