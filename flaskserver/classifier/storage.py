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
CLASS_SCHEMAS = {
    COARSE_SCHEMA: {
        "names": ("grey", "green", "dark", "white", "water"),
        "palette": np.asarray(
            [
                (150, 105, 210),
                (150, 225, 60),
                (255, 140, 0),
                (255, 255, 255),
                (255, 42, 161),
            ],
            dtype=np.uint8,
        ),
    },
}

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

    For ``coarse_v1``, mapped sea pixels are always forced to the schema's
    ``water`` label. The model cannot override the official coastline.
    """
    if class_schema not in CLASS_SCHEMAS:
        raise ValueError(f"unknown classifier schema: {class_schema}")
    array = np.asarray(classes, dtype=np.uint8)
    if array.ndim != 2:
        raise ValueError("classifier class map must be a 2D array")
    if array.size and int(array.max()) >= len(CLASS_SCHEMAS[class_schema]["names"]):
        raise ValueError(f"class map contains labels outside {class_schema}")
    array = array.copy()
    if enforce_official_water and class_schema == COARSE_SCHEMA:
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
        if enforce_official_water and class_schema == COARSE_SCHEMA:
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
