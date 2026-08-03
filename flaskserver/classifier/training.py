"""Trusted semantic annotations used by the neural classifier pipeline.

Regression reports are failure/evaluation cases, not labels. Human semantic
labels attach to deterministic superpixels and are expanded into pixel masks
only when exporting neural training pairs.
"""
from __future__ import annotations

import datetime
import hashlib
import io
import sqlite3
from pathlib import Path

import numpy as np
from PIL import Image

from classifier.segmentation import (
    SEGMENTER_VERSION,
    SegmentationConfig,
    segment_terrain_tile,
)


CLASSES = (
    "bare_rock", "vegetation", "soil_scree", "snow_ice", "water",
    "unknown_shadow", "lake", "sand", "shore_rock",
)
PALETTE = np.asarray(
    [
        (150, 105, 210), (150, 225, 60), (255, 140, 0),
        (255, 255, 255), (255, 42, 161), (60, 120, 255),
        (0, 200, 220), (255, 230, 90), (105, 92, 125),
    ],
    dtype=np.uint8,
)

_ANNOTATION_SCHEMA = """
CREATE TABLE IF NOT EXISTS classifier_annotations (
    tile_id            TEXT NOT NULL,
    segmenter_version  TEXT NOT NULL,
    segment_id         INTEGER NOT NULL CHECK (segment_id >= 0),
    class_name         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    PRIMARY KEY (tile_id, segmenter_version, segment_id),
    FOREIGN KEY (tile_id) REFERENCES tiles(tile_id) ON DELETE CASCADE
);
"""


def init_classifier_annotations(db: sqlite3.Connection) -> None:
    db.executescript(_ANNOTATION_SCHEMA)
    db.commit()


def _utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def geographic_group(tile_id: str, depth: int = 8) -> str:
    d, col, row = (int(value) for value in tile_id.split("-"))
    if d <= depth:
        return f"{d}-{col}-{row}"
    shift = d - depth
    return f"{depth}-{col >> shift}-{row >> shift}"


def geographic_split(tile_id: str, regression_tiles=()) -> str:
    group = geographic_group(tile_id)
    regression_groups = {
        geographic_group(regression_tile)
        for regression_tile in regression_tiles if regression_tile
    }
    if group in regression_groups:
        return "regression"
    bucket = int.from_bytes(
        hashlib.sha256(group.encode()).digest()[:4], "big"
    ) % 100
    if bucket < 70:
        return "train"
    if bucket < 85:
        return "validation"
    return "test"


def load_segmented_tile(db: sqlite3.Connection, tile_id: str):
    from classifier.official_water import classifier_water_mask_for_tile
    from database import GRID_N, _decompress_float32

    row = db.execute(
        "SELECT t.x_min, t.y_min, t.x_max, t.y_max, t.heightmap, x.texture "
        "FROM tiles t JOIN textures x USING (tile_id) WHERE t.tile_id = ?",
        (tile_id,),
    ).fetchone()
    if row is None or row[4] is None or row[5] is None:
        raise ValueError(f"{tile_id} needs a cached texture and heightmap")
    rgb = np.asarray(Image.open(io.BytesIO(row[5])).convert("RGB"))
    heightmap = _decompress_float32(row[4], (GRID_N, GRID_N))
    water = classifier_water_mask_for_tile(
        db, tile_id, rgb.shape[1], rgb.shape[0]
    )
    result = segment_terrain_tile(
        rgb,
        heightmap,
        float(row[2]) - float(row[0]),
        SegmentationConfig(target_segment_m=40.0),
        water_mask=water,
    )
    return rgb, result


def read_annotations(db: sqlite3.Connection, tile_id: str) -> dict[int, str]:
    init_classifier_annotations(db)
    return {
        int(segment_id): str(class_name)
        for segment_id, class_name in db.execute(
            "SELECT segment_id, class_name FROM classifier_annotations "
            "WHERE tile_id = ? AND segmenter_version = ? ORDER BY segment_id",
            (tile_id, SEGMENTER_VERSION),
        )
    }


def write_annotations(
    db: sqlite3.Connection,
    tile_id: str,
    assignments: list[dict],
    *,
    region_count: int,
) -> dict[int, str]:
    init_classifier_annotations(db)
    now = _utc_now()
    for assignment in assignments:
        segment_id = int(assignment.get("segmentId", -1))
        if not 0 <= segment_id < region_count:
            raise ValueError(f"invalid segment id: {segment_id}")
        class_name = assignment.get("className")
        if class_name in (None, "ignore"):
            db.execute(
                "DELETE FROM classifier_annotations WHERE tile_id = ? "
                "AND segmenter_version = ? AND segment_id = ?",
                (tile_id, SEGMENTER_VERSION, segment_id),
            )
            continue
        if class_name not in CLASSES:
            raise ValueError(f"unknown class: {class_name}")
        db.execute(
            "INSERT INTO classifier_annotations "
            "(tile_id, segmenter_version, segment_id, class_name, updated_at) "
            "VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET "
            "class_name=excluded.class_name, updated_at=excluded.updated_at",
            (tile_id, SEGMENTER_VERSION, segment_id, class_name, now),
        )
    db.commit()
    return read_annotations(db, tile_id)


def semantic_mask(db: sqlite3.Connection, tile_id: str, segmented) -> np.ndarray:
    """Image-oriented int16 mask; -1 means no trusted semantic label."""
    output = np.full(segmented.labels.shape, -1, dtype=np.int16)
    for segment_id, class_name in read_annotations(db, tile_id).items():
        if segment_id < len(segmented.regions) and class_name in CLASSES:
            output[segmented.labels == segment_id] = CLASSES.index(class_name)
    # Official water is an authority dataset, not a guessed pseudo-label.
    water = segmented.channels.get("water")
    if water is not None:
        output[np.asarray(water) >= 0.5] = CLASSES.index("water")
    return output


_SUGGESTION_CLASS_MAP = {
    "grey": "bare_rock",
    "green": "vegetation",
    "dark": "soil_scree",
    "white": "snow_ice",
    "water": "water",
    "shadow": "unknown_shadow",
    "lake": "lake",
    "beach": "sand",
    "sand": "sand",
    "shore_rock": "shore_rock",
}


def read_classifier_suggestions(
    db: sqlite3.Connection, tile_id: str, shape: tuple[int, int]
) -> tuple[np.ndarray | None, str | None]:
    """Translate an existing classifier tile into annotation-display classes.

    Suggestions are never returned by ``semantic_mask`` and therefore can
    never become training labels without an explicit human annotation.
    """
    from classifier.storage import CLASS_SCHEMAS, decode_class_map

    row = db.execute(
        "SELECT class_schema,width,height,class_map,source FROM classifier_tiles "
        "WHERE tile_id=?", (tile_id,),
    ).fetchone()
    if row is None or row[0] not in CLASS_SCHEMAS:
        return None, None
    labels = decode_class_map(row[3], int(row[1]), int(row[2]))
    if labels.shape != shape:
        labels = np.asarray(
            Image.fromarray(labels, mode="L").resize(
                (shape[1], shape[0]), Image.Resampling.NEAREST
            ), dtype=np.uint8,
        )
    translated = np.full(shape, -1, dtype=np.int16)
    for source_index, source_name in enumerate(CLASS_SCHEMAS[row[0]]["names"]):
        class_name = _SUGGESTION_CLASS_MAP.get(source_name)
        if class_name in CLASSES:
            translated[labels == source_index] = CLASSES.index(class_name)
    return translated, str(row[4])


def render_annotation_overlay(rgb, segmented, annotations, suggestions=None):
    output = np.asarray(rgb, dtype=np.uint8).copy()
    if suggestions is not None:
        suggested = np.asarray(suggestions)
        for class_index, color in enumerate(PALETTE):
            mask = suggested == class_index
            output[mask] = np.rint(
                output[mask] * 0.58 + color * 0.42
            ).astype(np.uint8)
    for segment_id, class_name in annotations.items():
        if segment_id >= len(segmented.regions) or class_name not in CLASSES:
            continue
        mask = segmented.labels == segment_id
        color = PALETTE[CLASSES.index(class_name)]
        output[mask] = np.rint(
            output[mask] * 0.25 + color * 0.75
        ).astype(np.uint8)
    labels = np.asarray(segmented.labels)
    boundary = np.zeros(labels.shape, dtype=bool)
    boundary[1:, :] |= labels[1:, :] != labels[:-1, :]
    boundary[:, 1:] |= labels[:, 1:] != labels[:, :-1]
    # A translucent one-sided edge stays legible without hiding both regions.
    output[boundary] = np.rint(
        output[boundary] * 0.62
    ).astype(np.uint8)
    return output


def encode_segment_ids(labels):
    values = np.asarray(labels, dtype=np.uint32) + 1
    return np.stack(
        (values & 255, (values >> 8) & 255, (values >> 16) & 255), axis=-1
    ).astype(np.uint8)


# Runtime-facing names remain here so existing APIs need no transitional
# import shims while the provisional region model is retired.
MODEL_VERSION = "terrain_unet_v2"
MODEL_PATH = Path(__file__).parent / "models" / f"{MODEL_VERSION}.pt"


def load_model(*args, **kwargs):
    from classifier.neural import load_model as implementation
    return implementation(*args, **kwargs)


def predict_tile(*args, **kwargs):
    from classifier.neural import predict_tile as implementation
    return implementation(*args, **kwargs)


def train_from_annotations(*args, **kwargs):
    from classifier.neural import train_model as implementation
    return implementation(*args, **kwargs)
