import sqlite3
import unittest
from unittest.mock import patch

from coastline import invalidate_cooked_descendants


def _db():
    db = sqlite3.connect(":memory:")
    db.executescript(
        """
        CREATE TABLE tiles (
            tile_id TEXT PRIMARY KEY,
            depth INTEGER, col INTEGER, row INTEGER,
            source TEXT, heightmap BLOB, confidence_map BLOB,
            geometric_error REAL DEFAULT 0, updated_at TEXT
        );
        """
    )
    return db


def _tile(db, tile_id, source="cooked_dem"):
    depth, col, row = (int(p) for p in tile_id.split("-"))
    db.execute(
        "INSERT INTO tiles (tile_id, depth, col, row, source, heightmap, "
        "geometric_error, updated_at) VALUES (?,?,?,?,?,?,?,'t0')",
        (tile_id, depth, col, row, source, b"baked", 5.0),
    )


class CookedStalenessTests(unittest.TestCase):
    """A late coastline must un-bake the cooks that predate it."""

    def setUp(self):
        self._seams = patch("terrain_seams.invalidate_tile_seams")
        self._seams.start()
        self.addCleanup(self._seams.stop)

    def test_descendants_are_reset_to_pending(self):
        db = _db()
        _tile(db, "13-2920-1696")
        _tile(db, "14-5840-3392")
        db.commit()

        reset = invalidate_cooked_descendants(db, "12-1460-848")

        self.assertEqual(reset, 2)
        rows = dict(db.execute("SELECT tile_id, source FROM tiles").fetchall())
        self.assertEqual(rows["13-2920-1696"], "pending")
        self.assertEqual(rows["14-5840-3392"], "pending")
        # The payload has to go, or the cook returns early on the stale bytes.
        payloads = [
            r[0] for r in db.execute("SELECT heightmap FROM tiles").fetchall()
        ]
        self.assertTrue(all(p is None for p in payloads))

    def test_measured_tiles_are_never_reset(self):
        db = _db()
        _tile(db, "13-2920-1696", source="arcticdem_10m")
        db.commit()

        self.assertEqual(invalidate_cooked_descendants(db, "12-1460-848"), 0)
        source = db.execute(
            "SELECT source FROM tiles WHERE tile_id='13-2920-1696'"
        ).fetchone()[0]
        # Only cooked DEMs bake the mask in; measured tiles apply water on read
        # and already self-heal.
        self.assertEqual(source, "arcticdem_10m")

    def test_neighbours_outside_the_quadrant_are_untouched(self):
        db = _db()
        _tile(db, "13-2920-1696")   # inside 12-1460-848
        _tile(db, "13-2922-1696")   # inside 12-1461-848, a neighbour
        db.commit()

        invalidate_cooked_descendants(db, "12-1460-848")

        rows = dict(db.execute("SELECT tile_id, source FROM tiles").fetchall())
        self.assertEqual(rows["13-2920-1696"], "pending")
        self.assertEqual(rows["13-2922-1696"], "cooked_dem")

    def test_prefix_lookalikes_are_not_matched(self):
        db = _db()
        # A tile_id LIKE '12-146-%' style match would sweep col 1460 when asked
        # about col 146; the quadrant arithmetic must not.
        _tile(db, "13-2920-1696")
        _tile(db, "13-292-169")
        db.commit()

        invalidate_cooked_descendants(db, "12-146-84")

        rows = dict(db.execute("SELECT tile_id, source FROM tiles").fetchall())
        self.assertEqual(rows["13-2920-1696"], "cooked_dem")
        self.assertEqual(rows["13-292-169"], "pending")

    def test_ancestors_are_not_reset(self):
        db = _db()
        _tile(db, "11-730-424")
        db.commit()
        self.assertEqual(invalidate_cooked_descendants(db, "12-1460-848"), 0)

    def test_deep_cascade_reaches_every_level(self):
        db = _db()
        for tile_id in ("13-2920-1696", "14-5840-3392", "15-11680-6784"):
            _tile(db, tile_id)
        db.commit()
        # d14 cooks from d13 and d15 from d14, so a stale root poisons the whole
        # chain and all of it has to be dropped.
        self.assertEqual(invalidate_cooked_descendants(db, "12-1460-848"), 3)


if __name__ == "__main__":
    unittest.main()
