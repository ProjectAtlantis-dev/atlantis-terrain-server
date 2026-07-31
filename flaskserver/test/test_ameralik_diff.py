import math
import sqlite3
import tempfile
import unittest
from pathlib import Path

from ameralik_diff import EvidenceResult, compare, load_results, metrics


class AmeralikDiffTests(unittest.TestCase):
    def test_metrics_preserve_health_and_signed_bias(self):
        result = metrics(
            [
                EvidenceResult("12-1-1", "8-0-0", 3.0, -2.0, "white"),
                EvidenceResult("12-1-2", "8-0-0", 4.0, 6.0, "red"),
            ]
        )
        self.assertEqual(result.count, 2)
        self.assertAlmostEqual(result.rms_m, math.sqrt(12.5))
        self.assertEqual(result.bias_m, 2.0)
        self.assertEqual(result.mean_abs_tile_bias_m, 4.0)
        self.assertEqual((result.white, result.yellow, result.red), (1, 0, 1))

    def test_compare_is_paired_and_reports_root_changes(self):
        baseline = {
            "12-1408-772": EvidenceResult(
                "12-1408-772", "8-88-48", 100.0, -80.0, "red"
            ),
            "12-1409-772": EvidenceResult(
                "12-1409-772", "8-88-48", 60.0, -40.0, "yellow"
            ),
            "12-999-999": EvidenceResult(
                "12-999-999", "8-62-62", 10.0, 1.0, "white"
            ),
        }
        candidate = {
            "12-1408-772": EvidenceResult(
                "12-1408-772", "8-88-48", 50.0, -20.0, "yellow"
            ),
            "12-1409-772": EvidenceResult(
                "12-1409-772", "8-88-48", 40.0, 10.0, "white"
            ),
            "12-1000-1000": EvidenceResult(
                "12-1000-1000", "8-62-62", 5.0, 0.0, "white"
            ),
        }
        result = compare(baseline, candidate)
        self.assertEqual(result["common_count"], 2)
        self.assertEqual(result["baseline_only_count"], 1)
        self.assertEqual(result["candidate_only_count"], 1)
        self.assertLess(
            result["candidate"]["rms_m"],
            result["baseline"]["rms_m"],
        )
        self.assertEqual(result["roots"]["8-88-48"]["candidate"]["red"], 0)

    def test_load_uses_only_accepted_d12_exact_raster_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "terrain.db"
            connection = sqlite3.connect(database)
            connection.executescript(
                """
                CREATE TABLE soundings (
                    source_url TEXT,
                    record_id TEXT,
                    evidence_format TEXT,
                    evidence_status TEXT,
                    model_error_m REAL,
                    model_delta_m REAL,
                    model_health TEXT
                );
                """
            )
            source = "https://doi.org/10.1594/PANGAEA.992416"
            connection.executemany(
                "INSERT INTO soundings VALUES (?, ?, ?, ?, ?, ?, ?)",
                [
                    (source, "12-1408-772", "raster", "accepted",
                     12.0, -10.0, "yellow"),
                    (source, "11-704-386", "raster", "accepted",
                     8.0, -5.0, "white"),
                    (source, "12-1409-772", "point", "accepted",
                     5.0, 1.0, "white"),
                    (source, "12-1410-772", "raster", "rejected",
                     5.0, 1.0, "white"),
                ],
            )
            connection.commit()
            connection.close()

            result = load_results(database)
            self.assertEqual(list(result), ["12-1408-772"])
            self.assertEqual(result["12-1408-772"].root_id, "8-88-48")


if __name__ == "__main__":
    unittest.main()
