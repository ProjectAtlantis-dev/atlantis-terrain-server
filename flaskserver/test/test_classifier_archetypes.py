"""Archetype rung: symbolic landform decisions per cell (NMS-style).

The rung must read canonical landforms out of DEM + coarse labels:
a cliff resolves into face / talus-apron / bench bands, water grows a
shore ring on gentle land only, and everything is deterministic.
"""

import os
import unittest

import numpy as np

os.environ.setdefault("DATAFORSYNINGEN_TOKEN", "test-token")

from classifier.archetypes import (
    BENCH, BOG, FACE, GRID, LAKE, SHORE, SLAB, TALUS, WATER,
    derive_archetypes,
    read_archetype_tile,
    write_archetype_tile,
)
from classifier.ladder import DARK as L_DARK
from classifier.ladder import GREEN as L_GREEN
from classifier.ladder import GREY as L_GREY
from classifier.ladder import LAKE as L_LAKE
from classifier.ladder import WATER as L_WATER

N = 129
SIZE = 256
BBOX = (0.0, 0.0, 659.18, 659.18)


def _labels(fill):
    return np.full((SIZE, SIZE), np.uint8(fill))


class CliffProfile(unittest.TestCase):
    def _cliff_surface(self):
        """South-first: flat valley south, wall in the middle, plateau
        north. The wall's rise/run ~1.2 over its band; a repose-angle
        ramp (~0.5) sits at its southern foot."""
        surface = np.zeros((N, N), dtype=np.float32)
        cell = BBOX[2] / (N - 1)
        for row in range(N):
            y = row * cell
            if y < 250:
                height = 0.0
            elif y < 320:
                height = (y - 250) * 0.5          # talus ramp
            elif y < 420:
                height = 35.0 + (y - 320) * 1.2   # face
            else:
                height = 155.0                    # plateau
            surface[row, :] = height
        return surface

    def test_cliff_resolves_into_face_talus_and_gentle_bands(self):
        surface = self._cliff_surface()
        labels = _labels(L_GREY)
        # Valley floor reads green (a bench under the wall).
        labels[: SIZE // 3, :] = np.uint8(L_GREEN)  # image row 0 = north!
        cells, stats = derive_archetypes(labels, surface, BBOX)
        # Image-oriented: north (plateau) at row 0, wall mid, valley south.
        self.assertGreater(stats["fractions"]["face"], 0.05)
        self.assertGreater(stats["fractions"]["talus"], 0.01)
        face_rows = np.nonzero((cells == FACE).any(axis=1))[0]
        talus_rows = np.nonzero((cells == TALUS).any(axis=1))[0]
        self.assertTrue(face_rows.size and talus_rows.size)
        # Talus sits SOUTH of the face (higher image row = further south).
        self.assertGreater(talus_rows.mean(), face_rows.mean())
        # The plateau (north rows) is gentle rock, never face.
        self.assertTrue(
            set(np.unique(cells[:3, :])) <= {np.uint8(SLAB), np.uint8(BENCH)}
        )

    def test_deterministic(self):
        surface = self._cliff_surface()
        labels = _labels(L_GREY)
        a, _ = derive_archetypes(labels, surface, BBOX)
        b, _ = derive_archetypes(labels, surface, BBOX)
        np.testing.assert_array_equal(a, b)


class WaterAndShore(unittest.TestCase):
    def test_lake_gets_shore_ring_on_gentle_land(self):
        surface = np.zeros((N, N), dtype=np.float32)
        labels = _labels(L_GREEN)
        labels[96:160, 96:160] = np.uint8(L_LAKE)
        cells, stats = derive_archetypes(labels, surface, BBOX)
        self.assertGreater(stats["fractions"]["lake"], 0.04)
        self.assertGreater(stats["fractions"]["shore"], 0.005)
        lake_cells = cells == LAKE
        from classifier.archetypes import _touches
        ring = _touches(lake_cells)
        self.assertTrue(np.all(cells[ring] == SHORE))

    def test_official_water_beats_everything(self):
        surface = np.zeros((N, N), dtype=np.float32)
        labels = _labels(L_WATER)
        cells, stats = derive_archetypes(labels, surface, BBOX)
        self.assertEqual(stats["fractions"]["water"], 1.0)
        self.assertTrue(np.all(cells == WATER))


class FlatGround(unittest.TestCase):
    def test_flat_dark_is_bog_flat_green_is_bench(self):
        surface = np.zeros((N, N), dtype=np.float32)
        labels = _labels(L_DARK)
        labels[:, : SIZE // 2] = np.uint8(L_GREEN)
        cells, _ = derive_archetypes(labels, surface, BBOX)
        self.assertTrue(np.all(cells[:, : GRID // 2 - 1] == BENCH))
        self.assertTrue(np.all(cells[:, GRID // 2 + 1:] == BOG))


class Storage(unittest.TestCase):
    def test_round_trip(self):
        import sqlite3

        from classifier.archetypes import init_archetype_tiles

        db = sqlite3.connect(":memory:")
        db.executescript(
            "CREATE TABLE tiles (tile_id TEXT PRIMARY KEY);"
            "INSERT INTO tiles VALUES ('12-1-1');"
        )
        init_archetype_tiles(db)
        cells = np.arange(GRID * GRID, dtype=np.uint8).reshape(GRID, GRID) % 12
        write_archetype_tile(db, "12-1-1", cells)
        loaded = read_archetype_tile(db, "12-1-1")
        np.testing.assert_array_equal(loaded, cells)
        self.assertIsNone(
            read_archetype_tile(
                db, "12-1-1", expected_source="archetype_d12_v1",
            )
        )
        self.assertIsNone(read_archetype_tile(db, "12-2-2"))


if __name__ == "__main__":
    unittest.main()
