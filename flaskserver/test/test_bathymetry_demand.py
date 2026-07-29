import sqlite3
import tempfile
import unittest
import zlib
from pathlib import Path
from typing import Any, Callable

import numpy as np

from bathymetry_demand import (
    BATHYMETRY_DEMAND_PAUSED_KEY,
    BATHYMETRY_JOB_DEPTH,
    BathymetryDemandScheduler,
    eligible_fjord_jobs,
    terrain_request_max_depth,
    terrain_request_origin,
)
from database import GRID_N
from tile_address import format_tile_id


def _db():
    db = sqlite3.connect(":memory:")
    db.executescript(
        """
        CREATE TABLE tiles (
            tile_id TEXT PRIMARY KEY,
            depth INTEGER NOT NULL,
            col INTEGER NOT NULL,
            row INTEGER NOT NULL
        );
        CREATE TABLE coastline_masks (
            tile_id TEXT PRIMARY KEY,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            mask BLOB NOT NULL
        );
        CREATE TABLE bathymetry (tile_id TEXT PRIMARY KEY);
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
        """
    )
    return db


def _mask(db, column, row, values):
    tile_id = format_tile_id(12, column, row)
    db.execute(
        "INSERT INTO tiles (tile_id, depth, col, row) VALUES (?, 12, ?, ?)",
        (tile_id, column, row),
    )
    db.execute(
        "INSERT INTO coastline_masks "
        "(tile_id, width, height, mask) VALUES (?, ?, ?, ?)",
        (
            tile_id,
            values.shape[1],
            values.shape[0],
            zlib.compress(values.astype(np.uint8).tobytes()),
        ),
    )
    return tile_id


class BathymetryEligibilityTests(unittest.TestCase):
    def test_mixed_coastline_mask_schedules_depth_8_ancestor(self):
        db = _db()
        self.addCleanup(db.close)
        water = np.zeros((GRID_N, GRID_N), dtype=bool)
        water[:, : GRID_N // 2] = True
        tile_id = _mask(db, 1600, 900, water)

        self.assertEqual(
            eligible_fjord_jobs(db, [tile_id]),
            {format_tile_id(BATHYMETRY_JOB_DEPTH, 100, 56)},
        )

    def test_all_water_is_limited_to_two_kilometres_offshore(self):
        db = _db()
        self.addCleanup(db.close)
        coast = np.zeros((GRID_N, GRID_N), dtype=bool)
        coast[:, : GRID_N // 2] = True
        _mask(db, 1600, 900, coast)
        near = _mask(db, 1604, 900, np.ones_like(coast))
        far = _mask(db, 1605, 900, np.ones_like(coast))

        self.assertTrue(eligible_fjord_jobs(db, [near]))
        self.assertFalse(eligible_fjord_jobs(db, [far]))

    def test_land_open_ocean_and_already_covered_jobs_do_not_schedule(self):
        db = _db()
        self.addCleanup(db.close)
        land = _mask(db, 1600, 900, np.zeros((GRID_N, GRID_N), dtype=bool))
        ocean = _mask(db, 1700, 900, np.ones((GRID_N, GRID_N), dtype=bool))
        self.assertEqual(eligible_fjord_jobs(db, [land, ocean]), set())

        coast = np.zeros((GRID_N, GRID_N), dtype=bool)
        coast[:, : GRID_N // 2] = True
        coastal_id = _mask(db, 1601, 900, coast)
        job_id = format_tile_id(BATHYMETRY_JOB_DEPTH, 100, 56)
        db.execute("INSERT INTO bathymetry (tile_id) VALUES (?)", (job_id,))
        self.assertEqual(eligible_fjord_jobs(db, [coastal_id]), set())

    def test_finer_visible_tile_is_folded_to_depth_12_then_depth_8(self):
        db = _db()
        self.addCleanup(db.close)
        coast = np.zeros((GRID_N, GRID_N), dtype=bool)
        coast[:, : GRID_N // 2] = True
        _mask(db, 1600, 900, coast)
        fine_id = format_tile_id(14, 1600 * 4 + 2, 900 * 4 + 1)
        self.assertEqual(
            eligible_fjord_jobs(db, [fine_id]),
            {format_tile_id(BATHYMETRY_JOB_DEPTH, 100, 56)},
        )


class _Future:
    def __init__(self):
        self.callback: Callable[[Any], Any] | None = None
        self.result_value = None

    def add_done_callback(self, callback: Callable[[Any], Any]):
        self.callback = callback

    def result(self):
        return self.result_value

    def complete(self, result):
        self.result_value = result
        callback = self.callback
        if callback is None:
            raise AssertionError("future completed before callback registration")
        callback(self)


class _Pool:
    def __init__(self):
        self.calls = []
        self.futures = []

    def submit(self, function, job_id):
        self.calls.append((function, job_id))
        future = _Future()
        self.futures.append(future)
        return future


class BathymetrySchedulerTests(unittest.TestCase):
    def test_only_real_viewer_demand_can_descend_below_depth_12(self):
        self.assertEqual(terrain_request_max_depth({}, 16), 16)
        self.assertEqual(terrain_request_origin({}), "viewer")
        self.assertEqual(
            terrain_request_max_depth({"demand": "bathymetry"}, 16), 12
        )
        self.assertEqual(
            terrain_request_origin({"demand": "bathymetry"}), "bathymetry"
        )
        self.assertEqual(
            terrain_request_max_depth({"bathymetry": "0"}, 16), 12
        )

    def test_durable_pause_prevents_worker_submission(self):
        db = _db()
        self.addCleanup(db.close)
        coast = np.zeros((GRID_N, GRID_N), dtype=bool)
        coast[:, : GRID_N // 2] = True
        tile_id = _mask(db, 1600, 900, coast)
        db.execute(
            "INSERT INTO metadata (key, value) VALUES (?, '1')",
            (BATHYMETRY_DEMAND_PAUSED_KEY,),
        )
        pool = _Pool()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "runOnDemand").touch()
            scheduler = BathymetryDemandScheduler(
                "/tmp/terrain.db", glacier_root=root, pool=pool
            )
            self.assertEqual(scheduler.schedule(db, [tile_id]), [])
            self.assertEqual(pool.calls, [])
            self.assertTrue(scheduler.status()["paused"])

    def test_scheduler_deduplicates_active_and_completed_jobs(self):
        db = _db()
        self.addCleanup(db.close)
        coast = np.zeros((GRID_N, GRID_N), dtype=bool)
        coast[:, : GRID_N // 2] = True
        tile_id = _mask(db, 1600, 900, coast)
        pool = _Pool()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "runOnDemand").touch()
            scheduler = BathymetryDemandScheduler(
                "/tmp/terrain.db", glacier_root=root, pool=pool
            )
            first = scheduler.schedule(db, [tile_id])
            self.assertEqual(len(first), 1)
            self.assertEqual(scheduler.schedule(db, [tile_id]), [])

            pool.futures[0].complete(
                type("Result", (), {"returncode": 0, "stdout": "", "stderr": ""})()
            )
            self.assertEqual(scheduler.schedule(db, [tile_id]), [])
            self.assertEqual(scheduler.status()["completed"], 1)


if __name__ == "__main__":
    unittest.main()
