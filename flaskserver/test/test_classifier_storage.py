import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from classifier.storage import (
    COARSE_SCHEMA,
    colorize_class_map,
    decode_class_map,
    decode_vote_map,
    write_classifier_votes,
    write_classifier_tile,
)
from database import open_db


class ClassifierStorageTest(unittest.TestCase):
    def test_schema_starts_empty_and_round_trips_indexed_labels(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM classifier_tiles").fetchone()[0],
                0,
            )
            db.execute(
                "INSERT INTO tiles "
                "(tile_id, depth, col, row, x_min, y_min, x_max, y_max, "
                "parent_id, geometric_error, source, updated_at) "
                "VALUES ('12-1-2', 12, 1, 2, 0, 0, 1, 1, NULL, 0, 'test', 'now')"
            )
            labels = np.asarray([[0, 1, 2], [3, 4, 0]], dtype=np.uint8)
            with patch(
                "classifier.official_water.classifier_water_mask_for_tile",
                return_value=np.zeros(labels.shape, dtype=bool),
            ):
                write_classifier_tile(
                    db, "12-1-2", labels, class_schema=COARSE_SCHEMA,
                    source="test-model-v1"
                )
            schema, width, height, blob, source = db.execute(
                "SELECT class_schema, width, height, class_map, source "
                "FROM classifier_tiles WHERE tile_id = '12-1-2'"
            ).fetchone()
            self.assertEqual((schema, width, height, source),
                             (COARSE_SCHEMA, 3, 2, "test-model-v1"))
            np.testing.assert_array_equal(decode_class_map(blob, width, height), labels)
            self.assertEqual(colorize_class_map(labels, schema).shape, (2, 3, 3))
            db.close()

    def test_official_water_overrides_model_class_and_confidence(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            db.execute(
                "INSERT INTO tiles "
                "(tile_id, depth, col, row, x_min, y_min, x_max, y_max, "
                "parent_id, geometric_error, source, updated_at) "
                "VALUES ('12-1-2', 12, 1, 2, 0, 0, 1, 1, NULL, 0, 'test', 'now')"
            )
            labels = np.zeros((2, 3), dtype=np.uint8)
            confidence = np.full(labels.shape, 80, dtype=np.uint8)
            water = np.array([[False, True, False], [True, True, False]])
            with patch(
                "classifier.official_water.classifier_water_mask_for_tile",
                return_value=water,
            ):
                write_classifier_tile(
                    db, "12-1-2", labels, confidence=confidence
                )
            width, height, class_blob, confidence_blob = db.execute(
                "SELECT width, height, class_map, confidence_map "
                "FROM classifier_tiles WHERE tile_id = '12-1-2'"
            ).fetchone()
            stored = decode_class_map(class_blob, width, height)
            stored_confidence = np.frombuffer(
                __import__("zlib").decompress(confidence_blob), dtype=np.uint8
            ).reshape(labels.shape)
            np.testing.assert_array_equal(stored == 4, water)
            np.testing.assert_array_equal(stored_confidence[water], 255)
            db.close()

    def test_ladder_vote_tallies_round_trip_without_losing_minorities(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            db.execute(
                "INSERT INTO tiles "
                "(tile_id, depth, col, row, x_min, y_min, x_max, y_max, "
                "parent_id, geometric_error, source, updated_at) "
                "VALUES ('8-1-2', 8, 1, 2, 0, 0, 1, 1, NULL, 0, 'test', 'now')"
            )
            votes = np.zeros((5, 2, 3), dtype=np.uint16)
            votes[0] = 3
            votes[1, 0, 0] = 2
            write_classifier_votes(db, "8-1-2", votes, source="ladder-test")
            schema, width, height, blob, count = db.execute(
                "SELECT class_schema,width,height,vote_map,vote_count "
                "FROM classifier_votes WHERE tile_id='8-1-2'"
            ).fetchone()
            self.assertEqual((schema, width, height, count), (COARSE_SCHEMA, 3, 2, 5))
            np.testing.assert_array_equal(
                decode_vote_map(blob, 5, width, height), votes,
            )
            db.close()

    def test_rejects_labels_outside_the_declared_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            with self.assertRaisesRegex(ValueError, "outside coarse_v1"):
                write_classifier_tile(db, "12-1-2", np.asarray([[5]], dtype=np.uint8))
            db.close()

    def test_water_class_is_hot_pink_in_debug_view(self):
        labels = np.asarray([[4]], dtype=np.uint8)
        np.testing.assert_array_equal(
            colorize_class_map(labels, COARSE_SCHEMA)[0, 0],
            np.asarray([255, 42, 161], dtype=np.uint8),
        )

    def test_water_highlight_can_be_disabled_without_removing_water_label(self):
        labels = np.asarray([[4, 1]], dtype=np.uint8)
        colors = colorize_class_map(
            labels, COARSE_SCHEMA, highlight_water=False,
        )
        np.testing.assert_array_equal(
            colors[0, 0], np.asarray([42, 42, 42], dtype=np.uint8),
        )
        np.testing.assert_array_equal(
            colors[0, 1], np.asarray([150, 225, 60], dtype=np.uint8),
        )


if __name__ == "__main__":
    unittest.main()
