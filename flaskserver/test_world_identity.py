import os
import sqlite3
import unittest
from unittest.mock import patch

from world_identity import ensure_world_identity


class WorldIdentityTests(unittest.TestCase):
    def make_db(self):
        db = sqlite3.connect(":memory:")
        db.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        return db

    def test_identity_is_created_once_and_survives_environment_changes(self):
        db = self.make_db()
        with patch.dict(os.environ, {
            "ATLANTIS_WORLD_SEED": "42",
            "ATLANTIS_PROCGEN_VERSION": "7",
        }):
            self.assertEqual(
                ensure_world_identity(db),
                {"worldSeed": 42, "procgenVersion": 7},
            )
        with patch.dict(os.environ, {
            "ATLANTIS_WORLD_SEED": "99",
            "ATLANTIS_PROCGEN_VERSION": "8",
        }):
            self.assertEqual(
                ensure_world_identity(db),
                {"worldSeed": 42, "procgenVersion": 7},
            )

    def test_invalid_identity_values_use_bounded_defaults(self):
        db = self.make_db()
        with patch.dict(os.environ, {
            "ATLANTIS_WORLD_SEED": "-1",
            "ATLANTIS_PROCGEN_VERSION": "not-a-number",
        }):
            self.assertEqual(
                ensure_world_identity(db),
                {"worldSeed": 1337, "procgenVersion": 2},
            )


if __name__ == "__main__":
    unittest.main()
