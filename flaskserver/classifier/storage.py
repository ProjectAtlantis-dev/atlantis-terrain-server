"""Persistent semantic classifier tiles.

Class maps are zlib-compressed row-major uint8 label indices.  Row zero is
north (image orientation), unlike the terrain heightmaps.  Keeping labels
instead of a pre-colored image lets procgen consume the same payload that the
debug view colorizes.
"""
from __future__ import annotations

import datetime
import zlib

import numpy as np


COARSE_SCHEMA = "coarse_v1"
# coarse_v2 (classifier.ladder): indices 0-4 are IDENTICAL to coarse_v1 so
# index-based consumers keep working; SHADOW (5) is purely additive — a
# first-class "honestly unknown, geometrically unlit" bucket, never folded
# into dark ground.
COARSE_V2_SCHEMA = "coarse_v2"
COARSE_V3_SCHEMA = "coarse_v3"
COARSE_V4_SCHEMA = "coarse_v4"
_COARSE_PALETTE = [
    (150, 105, 210),
    (150, 225, 60),
    (255, 140, 0),
    (255, 255, 255),
    (255, 42, 161),
]
CLASS_SCHEMAS = {
    COARSE_SCHEMA: {
        "names": ("grey", "green", "dark", "white", "water"),
        "palette": np.asarray(_COARSE_PALETTE, dtype=np.uint8),
    },
    COARSE_V2_SCHEMA: {
        # shadow: geometrically unlit + dark — honestly unknown ground.
        # lake: DEM flat-sheet water the official blue dataset is missing —
        # distinct from authority water on purpose.
        "names": ("grey", "green", "dark", "white", "water", "shadow", "lake"),
        "palette": np.asarray(
            _COARSE_PALETTE + [(60, 120, 255), (0, 200, 220)],
            dtype=np.uint8,
        ),
    },
    COARSE_V3_SCHEMA: {
        # v3 adds an explicit high-resolution beach class. It is derived
        # only from vegetation evidence beside classified water, so the
        # debug color follows the real bank instead of painting a coarse
        # constant-width ring.
        "names": (
            "grey", "green", "dark", "white", "water", "shadow", "lake",
            "beach",
        ),
        "palette": np.asarray(
            _COARSE_PALETTE
            + [(60, 120, 255), (0, 200, 220), (255, 230, 90)],
            dtype=np.uint8,
        ),
    },
    COARSE_V4_SCHEMA: {
        # v4 splits the former monolithic beach class into full-resolution
        # sand and shore-rock patches. Both remain shoreline/no-growth
        # surfaces, but the renderer can now give the latter real rock grain
        # instead of painting one uniform material around the water.
        "names": (
            "grey", "green", "dark", "white", "water", "shadow", "lake",
            "sand", "shore_rock",
        ),
        "palette": np.asarray(
            _COARSE_PALETTE
            + [
                (60, 120, 255), (0, 200, 220), (255, 230, 90),
                (105, 92, 125),
            ],
            dtype=np.uint8,
        ),
    },
}
# Schemas whose "water" label the official coastline overrides on write.
_WATER_ENFORCED_SCHEMAS = (
    COARSE_SCHEMA, COARSE_V2_SCHEMA, COARSE_V3_SCHEMA, COARSE_V4_SCHEMA,
)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS classifier_tiles (
    tile_id         TEXT PRIMARY KEY,
    class_schema    TEXT NOT NULL,
    width           INTEGER NOT NULL CHECK (width > 0),
    height          INTEGER NOT NULL CHECK (height > 0),
    class_map       BLOB NOT NULL,
    confidence_map  BLOB,
    source          TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    FOREIGN KEY (tile_id) REFERENCES tiles(tile_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS classifier_votes (
    tile_id         TEXT PRIMARY KEY,
    class_schema    TEXT NOT NULL,
    width           INTEGER NOT NULL CHECK (width > 0),
    height          INTEGER NOT NULL CHECK (height > 0),
    vote_map        BLOB NOT NULL,
    vote_count      INTEGER NOT NULL CHECK (vote_count > 0),
    source          TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    FOREIGN KEY (tile_id) REFERENCES tiles(tile_id) ON DELETE CASCADE
);
"""


def init_classifier_tiles(db):
    """Create classifier storage without generating any classifier rows."""
    db.executescript(_SCHEMA)
    db.commit()


def encode_class_map(classes):
    array = np.asarray(classes, dtype=np.uint8)
    if array.ndim != 2:
        raise ValueError("classifier class map must be a 2D array")
    return zlib.compress(array.tobytes(), level=6)


def decode_class_map(blob, width, height):
    values = np.frombuffer(zlib.decompress(blob), dtype=np.uint8)
    expected = int(width) * int(height)
    if values.size != expected:
        raise ValueError(f"classifier map has {values.size} labels; expected {expected}")
    return values.reshape((int(height), int(width))).copy()


def encode_vote_map(votes):
    array = np.asarray(votes, dtype=np.uint16)
    if array.ndim != 3:
        raise ValueError("classifier vote map must be classes x height x width")
    return zlib.compress(array.tobytes(), level=6)


def decode_vote_map(blob, class_count, width, height):
    values = np.frombuffer(zlib.decompress(blob), dtype=np.uint16)
    expected = int(class_count) * int(width) * int(height)
    if values.size != expected:
        raise ValueError(
            f"classifier vote map has {values.size} values; expected {expected}"
        )
    return values.reshape((int(class_count), int(height), int(width))).copy()


def write_classifier_votes(
    db, tile_id, votes, *, class_schema=COARSE_SCHEMA, source="classifier",
):
    """Persist the complete ladder tally; never discard losing votes."""
    if class_schema not in CLASS_SCHEMAS:
        raise ValueError(f"unknown classifier schema: {class_schema}")
    array = np.asarray(votes, dtype=np.uint16)
    class_count = len(CLASS_SCHEMAS[class_schema]["names"])
    if array.ndim != 3 or array.shape[0] != class_count:
        raise ValueError(
            f"classifier vote map must contain {class_count} class planes"
        )
    vote_count = int(array.sum(axis=0).max(initial=0))
    if vote_count <= 0:
        raise ValueError("classifier vote map is empty")
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    db.execute(
        "INSERT INTO classifier_votes "
        "(tile_id,class_schema,width,height,vote_map,vote_count,source,updated_at) "
        "VALUES (?,?,?,?,?,?,?,?) "
        "ON CONFLICT(tile_id) DO UPDATE SET "
        "class_schema=excluded.class_schema,width=excluded.width,"
        "height=excluded.height,vote_map=excluded.vote_map,"
        "vote_count=excluded.vote_count,source=excluded.source,"
        "updated_at=excluded.updated_at",
        (
            tile_id, class_schema, int(array.shape[2]), int(array.shape[1]),
            encode_vote_map(array), vote_count, source, now,
        ),
    )
    db.commit()


def write_classifier_tile(
    db,
    tile_id,
    classes,
    *,
    class_schema=COARSE_SCHEMA,
    confidence=None,
    source="classifier",
    enforce_official_water=True,
):
    """Insert or replace a semantic tile. Primarily used by classifier jobs.

    For the coarse schemas, mapped sea pixels are always forced to the
    schema's ``water`` label. The model cannot override the official
    coastline.
    """
    if class_schema not in CLASS_SCHEMAS:
        raise ValueError(f"unknown classifier schema: {class_schema}")
    array = np.asarray(classes, dtype=np.uint8)
    if array.ndim != 2:
        raise ValueError("classifier class map must be a 2D array")
    if array.size and int(array.max()) >= len(CLASS_SCHEMAS[class_schema]["names"]):
        raise ValueError(f"class map contains labels outside {class_schema}")
    array = array.copy()
    official_water = None
    if enforce_official_water and class_schema in _WATER_ENFORCED_SCHEMAS:
        from classifier.official_water import classifier_water_mask_for_tile

        official_water = classifier_water_mask_for_tile(
            db, tile_id, int(array.shape[1]), int(array.shape[0])
        )
        if official_water is not None:
            water_label = CLASS_SCHEMAS[class_schema]["names"].index("water")
            array[official_water] = np.uint8(water_label)
    confidence_blob = None
    if confidence is not None:
        confidence_array = np.asarray(confidence, dtype=np.uint8)
        if confidence_array.shape != array.shape:
            raise ValueError("classifier confidence map must match the class map")
        if enforce_official_water and class_schema in _WATER_ENFORCED_SCHEMAS:
            if official_water is not None:
                confidence_array = confidence_array.copy()
                confidence_array[official_water] = np.uint8(255)
        confidence_blob = zlib.compress(confidence_array.tobytes(), level=6)
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    db.execute(
        "INSERT INTO classifier_tiles "
        "(tile_id, class_schema, width, height, class_map, confidence_map, source, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(tile_id) DO UPDATE SET "
        "class_schema=excluded.class_schema, width=excluded.width, height=excluded.height, "
        "class_map=excluded.class_map, confidence_map=excluded.confidence_map, "
        "source=excluded.source, updated_at=excluded.updated_at",
        (
            tile_id,
            class_schema,
            int(array.shape[1]),
            int(array.shape[0]),
            encode_class_map(array),
            confidence_blob,
            source,
            now,
        ),
    )
    db.commit()


def colorize_class_map(
    classes,
    class_schema,
    *,
    highlight_water=True,
    neutral_water_color=(42, 42, 42),
):
    schema = CLASS_SCHEMAS.get(class_schema)
    if schema is None:
        raise ValueError(f"unknown classifier schema: {class_schema}")
    array = np.asarray(classes, dtype=np.uint8)
    palette = schema["palette"]
    if array.size and int(array.max()) >= len(palette):
        raise ValueError(f"class map contains labels outside {class_schema}")
    rgb = palette[array]
    if not highlight_water and "water" in schema["names"]:
        water_label = schema["names"].index("water")
        rgb = rgb.copy()
        rgb[array == water_label] = np.asarray(neutral_water_color, dtype=np.uint8)
    return rgb
