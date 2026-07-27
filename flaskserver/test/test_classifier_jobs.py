import os
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

os.environ.setdefault("DATAFORSYNINGEN_TOKEN", "test-token")

from classifier_job_control import ClassifierJobControl, classifier_inventory
import serve_flask


class ClassifierJobControlTest(unittest.TestCase):
    def test_worker_tracks_success_skip_failure_and_rejects_overlap(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "terrain.db"
            sqlite3.connect(db_path).close()
            entered = threading.Event()
            release = threading.Event()
            finished = []

            def verify(_db, tile_id, _out, *, use_google):
                self.assertTrue(use_google)
                if tile_id == "12-1-1":
                    entered.set()
                    release.wait(2)
                    return {"tile": tile_id, "stats": {"fractions": {}}}
                if tile_id == "12-1-2":
                    return None
                raise ValueError("bad pixels")

            control = ClassifierJobControl(
                db_path,
                verify_tile=verify,
                finish_job=lambda scope, metrics: finished.append((scope, metrics)),
            )
            started = control.start(
                scope="selected",
                tiles=["12-1-1", "12-1-2", "12-1-3"],
                use_google=True,
            )
            self.assertEqual(started["status"], "queued")
            self.assertTrue(entered.wait(1))
            with self.assertRaisesRegex(RuntimeError, "already running"):
                control.start(
                    scope="selected", tiles=["12-2-2"], use_google=False,
                )
            release.set()
            result = control.wait()

            self.assertEqual(result["status"], "complete")
            self.assertEqual(result["processed"], 3)
            self.assertEqual(result["succeeded"], 1)
            self.assertEqual(result["skipped"], 1)
            self.assertEqual(result["failed"], 1)
            self.assertEqual(result["errors"][0]["tile"], "12-1-3")
            self.assertEqual(finished[0][0], "selected")
            self.assertEqual(finished[0][1][0]["tile"], "12-1-1")

    def test_inventory_separates_current_and_legacy_rows(self):
        db = sqlite3.connect(":memory:")
        db.executescript("""
            CREATE TABLE classifier_tiles (
              tile_id TEXT, class_schema TEXT, source TEXT
            );
            CREATE TABLE textures (
              tile_id TEXT, source TEXT
            );
            CREATE TABLE tiles (
              tile_id TEXT, heightmap BLOB
            );
            INSERT INTO classifier_tiles VALUES
              ('12-1-1', 'coarse_v4', 'ladder_d12_v9'),
              ('12-1-2', 'coarse_v2', 'ladder_d12_v2');
            INSERT INTO textures VALUES
              ('12-1-1', 'dataforsyningen'),
              ('12-1-2', 'dataforsyningen'),
              ('12-1-3', 'placeholder');
            INSERT INTO tiles VALUES
              ('12-1-1', X'01'),
              ('12-1-2', X'01'),
              ('12-1-3', X'01');
        """)

        result = classifier_inventory(db)

        self.assertEqual(result["totalRows"], 2)
        self.assertEqual(result["currentRows"], 1)
        self.assertEqual(result["legacyRows"], 1)
        self.assertEqual(result["readyD12"], 2)
        self.assertEqual(result["coveragePct"], 50.0)
        db.close()


class ClassifierJobEndpointTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript("""
            CREATE TABLE classifier_tiles (
              tile_id TEXT, class_schema TEXT, source TEXT
            );
            CREATE TABLE textures (tile_id TEXT, source TEXT);
            CREATE TABLE tiles (tile_id TEXT, heightmap BLOB);
        """)
        self.control = MagicMock()
        self.control.snapshot.return_value = {"status": "idle"}
        self.control.start.return_value = {
            "jobId": "job-1", "status": "queued", "total": 2,
        }

    def tearDown(self):
        self.db.close()

    def _patches(self):
        return (
            patch.object(
                serve_flask, "_terrain_unavailable_response", return_value=None,
            ),
            patch.object(serve_flask, "_get_db", return_value=self.db),
            patch.object(serve_flask, "_classifier_job_control", self.control),
            patch.object(serve_flask, "regression_case_summaries", return_value=[]),
        )

    def test_launches_selected_tiles_and_reports_status(self):
        with self._patches()[0], self._patches()[1], self._patches()[2], self._patches()[3]:
            client = serve_flask.app.test_client()
            response = client.post(
                "/api/classifier/jobs",
                json={
                    "scope": "selected",
                    "tiles": "12-1-2, 12-1-3",
                    "useGoogle": True,
                },
            )
            status = client.get("/api/classifier/jobs")

        self.assertEqual(response.status_code, 202)
        self.control.start.assert_called_once_with(
            scope="selected",
            tiles=["12-1-2", "12-1-3"],
            use_google=True,
        )
        self.assertEqual(status.status_code, 200)
        self.assertEqual(status.headers["Cache-Control"], "no-store")
        self.assertIn("inventory", status.get_json())

    def test_rejects_non_d12_selected_tile(self):
        with self._patches()[0], self._patches()[1], self._patches()[2], self._patches()[3]:
            response = serve_flask.app.test_client().post(
                "/api/classifier/jobs",
                json={"scope": "selected", "tiles": ["13-2-4"]},
            )

        self.assertEqual(response.status_code, 400)
        self.assertIn("require D12", response.get_json()["error"])
        self.control.start.assert_not_called()


if __name__ == "__main__":
    unittest.main()
