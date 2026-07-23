"""NMS-style intermediate rung: landform archetype decisions per cell.

The No Man's Sky generation architecture (McKendrick, GDC 2017) never jumps
from coarse parameters straight to fine geometry: every level commits to
SYMBOLIC decisions that constrain the level below, and everything is a pure
function of parent data + position. This module is that missing middle rung
for us. Between the d12 coarse_v2 class map and per-instance procgen, each
~20 m cell of a d12 tile commits to ONE landform interpretation — derived
deterministically from the class labels, the DEM, and adjacency. Downstream
consumers (scatter recipes, detail materials, talus fans, rock-face stamps)
key off the DECISION, not the raw channels — disputes become reviewable at
the archetype level ("this cell is not talus") instead of per-bush
probability arguments.

v1 archetypes:
    unknown  — nothing below claimed it (kept rare)
    water    — official water authority
    lake     — DEM flat-sheet water (ingest gap, still not land)
    shore    — land cell touching water/lake
    bench    — gentle veg-capable ground (the shrub/grass carpet lives here)
    bog      — flat dark wet ground (shrubs own it, fine grass does not)
    slab     — bare rock, gentle-to-moderate slope
    face     — steep rock wall (stamp target; nothing lives here)
    talus    — repose-angle rubble apron adjacent to a face (future boulders)
    ridge    — convex crest line (grain-aligned; shadow-caster)
    shadow   — geometry+imagery say unlit/unknown; decide nothing
    snow     — white-dominated cover

Cells are image-oriented (row 0 = north) like every classifier product.
"""
from __future__ import annotations

import datetime
import zlib

import numpy as np

ARCHETYPE_SOURCE = "archetype_d12_v2"

UNKNOWN, WATER, LAKE, SHORE, BENCH, BOG, SLAB, FACE, TALUS, RIDGE, SHADOW, \
    SNOW = range(12)

ARCHETYPE_NAMES = (
    "unknown", "water", "lake", "shore", "bench", "bog", "slab", "face",
    "talus", "ridge", "shadow", "snow",
)
# Debug palette — high contrast, distinct from the coarse_v2 palette so a
# glance never confuses the two rungs.
ARCHETYPE_PALETTE = np.asarray(
    [
        (24, 24, 24),      # unknown  near-black
        (255, 42, 161),    # water    pink (matches coarse water)
        (0, 200, 220),     # lake     cyan (matches coarse lake)
        (255, 230, 90),    # shore    sand yellow
        (110, 205, 60),    # bench    green
        (120, 85, 40),     # bog      peat brown
        (168, 168, 178),   # slab     light rock grey
        (232, 90, 40),     # face     hot orange-red
        (150, 105, 210),   # talus    purple
        (255, 255, 255),   # ridge    white
        (60, 120, 255),    # shadow   blue (matches coarse shadow)
        (225, 240, 255),   # snow     blue-white
    ],
    dtype=np.uint8,
)

GRID = 32  # cells per d12 tile edge (~20 m cells)

# Slope bands (rise/run). Face threshold sits below the classifier's
# SLOPE_ROCK_MIN because a wall averaged over a ~20 m cell reads shallower
# than its steepest pixel. Talus is the repose band underneath one.
FACE_SLOPE_MIN = 0.60
TALUS_SLOPE = (0.42, FACE_SLOPE_MIN)
BENCH_SLOPE_MAX = 0.35
BOG_SLOPE_MAX = 0.08
RIDGE_CURVATURE_MIN = 0.02
RIDGE_SLOPE_MIN = 0.12

# Class-fraction thresholds per cell.
WATERISH_MIN = 0.5
SNOW_MIN = 0.4
SHADOW_MIN = 0.5
GREEN_MIN = 0.25
DARK_MIN = 0.30


def _cell_fractions(labels, grid, n_classes):
    """Per-cell fraction of each label; labels must divide evenly."""
    size = labels.shape[0]
    block = size // grid
    trimmed = labels[: grid * block, : grid * block]
    stack = trimmed.reshape(grid, block, grid, block)
    fractions = np.empty((n_classes, grid, grid), dtype=np.float32)
    for index in range(n_classes):
        fractions[index] = (stack == index).mean(axis=(1, 3))
    return fractions


def _touches(mask):
    """Cells 8-adjacent to a True cell (excluding the cell itself)."""
    padded = np.pad(mask, 1)
    out = np.zeros_like(mask)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy == 0 and dx == 0:
                continue
            out |= padded[1 + dy: 1 + dy + mask.shape[0],
                          1 + dx: 1 + dx + mask.shape[1]]
    return out & ~mask


def derive_archetypes(labels, heightmap, bbox, grid=GRID):
    """Commit each cell of one tile to a landform archetype.

    labels: coarse_v2 uint8 map (image-oriented, square, size divisible by
    grid). heightmap: south-first surface covering bbox. Deterministic —
    same inputs, same decisions, no randomness anywhere in this rung.
    Returns (archetypes uint8 grid×grid, stats dict).
    """
    from classifier import ladder

    channels = ladder.physics_channels(
        heightmap, float(bbox[2]) - float(bbox[0]), grid
    )
    slope = channels["slope"]
    curvature = channels["curvature"]

    labels = np.asarray(labels, dtype=np.uint8)
    fractions = _cell_fractions(labels, grid, 7)
    grey, green, dark, white, water, shadow, lake = fractions

    rocky = grey + dark + shadow

    cells = np.full((grid, grid), np.uint8(UNKNOWN))

    # Gentle ground: vegetation-capable bench, else wet dark bog, else slab.
    gentle = slope < BENCH_SLOPE_MAX
    cells[gentle] = np.uint8(SLAB)
    cells[gentle & (slope < BOG_SLOPE_MAX) & (dark > DARK_MIN)] = np.uint8(BOG)
    cells[gentle & (green > GREEN_MIN)] = np.uint8(BENCH)

    # Moderate-to-steep rock.
    cells[~gentle] = np.uint8(SLAB)
    face = (slope > FACE_SLOPE_MIN) & (rocky > 0.3)
    cells[face] = np.uint8(FACE)
    # Talus: repose band touching a face — the rubble apron under the wall.
    repose = (slope >= TALUS_SLOPE[0]) & (slope < TALUS_SLOPE[1])
    cells[repose & _touches(face) & (green < GREEN_MIN)] = np.uint8(TALUS)
    # Ridge crests: convex break with real slope around them.
    cells[
        (curvature > RIDGE_CURVATURE_MIN) & (slope > RIDGE_SLOPE_MIN) & ~face
    ] = np.uint8(RIDGE)

    # Cover classes override landform where they dominate the cell.
    cells[white > SNOW_MIN] = np.uint8(SNOW)
    cells[shadow > SHADOW_MIN] = np.uint8(SHADOW)

    # Water family last — authority. Shore ring goes on land cells only.
    is_water = water > WATERISH_MIN
    is_lake = lake > WATERISH_MIN
    cells[is_lake] = np.uint8(LAKE)
    cells[is_water] = np.uint8(WATER)
    # Shore only claims GENTLE land touching water — a cliff plunging
    # straight into the fjord stays a face, not a beach.
    touching = _touches(is_water | is_lake)
    shoreable = touching & (
        (cells == BENCH) | (cells == BOG) | (cells == SLAB)
    ) & (slope < BENCH_SLOPE_MAX)
    cells[shoreable] = np.uint8(SHORE)

    total = cells.size
    stats = {
        "fractions": {
            name: float(np.count_nonzero(cells == index)) / total
            for index, name in enumerate(ARCHETYPE_NAMES)
        },
    }
    return cells, stats


def colorize_archetypes(cells):
    return ARCHETYPE_PALETTE[np.asarray(cells, dtype=np.uint8)]


_SCHEMA = """
CREATE TABLE IF NOT EXISTS archetype_tiles (
    tile_id    TEXT PRIMARY KEY,
    grid       INTEGER NOT NULL CHECK (grid > 0),
    cells      BLOB NOT NULL,
    source     TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (tile_id) REFERENCES tiles(tile_id) ON DELETE CASCADE
);
"""


def init_archetype_tiles(db):
    db.executescript(_SCHEMA)
    db.commit()


def write_archetype_tile(db, tile_id, cells, source=ARCHETYPE_SOURCE):
    array = np.asarray(cells, dtype=np.uint8)
    if array.ndim != 2 or array.shape[0] != array.shape[1]:
        raise ValueError("archetype grid must be square")
    if array.size and int(array.max()) >= len(ARCHETYPE_NAMES):
        raise ValueError("archetype grid contains unknown indices")
    db.execute(
        "INSERT INTO archetype_tiles (tile_id, grid, cells, source, updated_at) "
        "VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(tile_id) DO UPDATE SET grid=excluded.grid, "
        "cells=excluded.cells, source=excluded.source, "
        "updated_at=excluded.updated_at",
        (
            tile_id,
            int(array.shape[0]),
            zlib.compress(array.tobytes(), level=6),
            source,
            datetime.datetime.now(datetime.timezone.utc).isoformat(),
        ),
    )
    db.commit()


def resolve_archetype_window(db, tile_id, *, contract_depth=12,
                             ensure_class_map=None):
    """Archetype cell window covering ``tile_id``, or None.

    The archetype rung is a d12 DECISION layer (NMS-style: symbols cascade
    down, they are never re-derived from synthetic deep imagery). d12 tiles
    compute-and-store on first demand from their stored classification +
    heightmap; deeper tiles inherit by nearest-neighbor crop of the d12
    ancestor — the same hierarchy rule as the classifier walk.

    ``ensure_class_map(db, d12_id)`` optionally forces live classification of
    the ancestor before giving up (the Flask endpoint passes its ensure hook;
    the DEM cook path works from whatever classification is already stored).
    """
    import sqlite3

    parts = str(tile_id).split("-")
    if len(parts) != 3:
        return None
    try:
        depth, col, row = (int(part) for part in parts)
    except ValueError:
        return None
    if depth < contract_depth:
        return None
    shift = depth - contract_depth
    d12_id = f"{contract_depth}-{col >> shift}-{row >> shift}"

    init_archetype_tiles(db)
    cells = read_archetype_tile(db, d12_id, expected_source=ARCHETYPE_SOURCE)
    if cells is None:
        if ensure_class_map is not None:
            ensure_class_map(db, d12_id)
        try:
            found = db.execute(
                "SELECT width, height, class_map FROM classifier_tiles "
                "WHERE tile_id = ?", (d12_id,),
            ).fetchone()
        except sqlite3.OperationalError:
            return None
        if found is None:
            return None
        from classifier.storage import decode_class_map
        from database import read_tile
        tile = read_tile(db, d12_id)
        if tile is None or tile.get("heightmap") is None:
            return None
        labels = decode_class_map(found[2], found[0], found[1])
        cells, _stats = derive_archetypes(
            labels, tile["heightmap"], list(tile["bbox"]),
        )
        write_archetype_tile(db, d12_id, cells)
    if shift == 0:
        return cells
    grid = cells.shape[0]
    divisions = 1 << shift
    sub_col = col % divisions
    sub_row = row % divisions
    x0 = sub_col * grid // divisions
    x1 = max(x0 + 1, (sub_col + 1) * grid // divisions)
    # Image-oriented: row zero is north.
    y0 = (divisions - 1 - sub_row) * grid // divisions
    y1 = max(y0 + 1, (divisions - sub_row) * grid // divisions)
    return np.asarray(cells[y0:y1, x0:x1])


def read_archetype_tile(db, tile_id, expected_source=None):
    row = db.execute(
        "SELECT grid, cells, source FROM archetype_tiles WHERE tile_id = ?",
        (tile_id,),
    ).fetchone()
    if row is None or (
        expected_source is not None and row[2] != expected_source
    ):
        return None
    grid = int(row[0])
    return np.frombuffer(
        zlib.decompress(row[1]), dtype=np.uint8
    ).reshape((grid, grid)).copy()
