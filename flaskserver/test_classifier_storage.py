import tempfile
import unittest
from pathlib import Path

import numpy as np

from classifier.storage import (
    COARSE_SCHEMA,
    colorize_class_map,
    decode_class_map,
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
            write_classifier_tile(
                db, "12-1-2", labels, class_schema=COARSE_SCHEMA, source="test-model-v1"
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

    def test_rejects_labels_outside_the_declared_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            with self.assertRaisesRegex(ValueError, "outside coarse_v1"):
                write_classifier_tile(db, "12-1-2", np.asarray([[5]], dtype=np.uint8))
            db.close()


if __name__ == "__main__":
    unittest.main()
