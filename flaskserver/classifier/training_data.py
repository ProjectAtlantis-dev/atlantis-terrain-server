"""Reproducible aligned training-pair export for the terrain U-Net.

Google imagery is a training/reference target only. It is never an inference
input, browser asset, or distributed artifact. Semantic masks contain only
trusted human annotations plus the official water authority.
"""
from __future__ import annotations

import datetime
import hashlib
import io
import json
import sqlite3
from pathlib import Path

import numpy as np
from PIL import Image

from classifier.terrain_channels import terrain_channels
from classifier.training import (
    CLASSES,
    geographic_group,
    geographic_split,
    load_segmented_tile,
    read_annotations,
    semantic_mask,
)
from database import GRID_N, _decompress_float32
from google_ref import DEFAULT_ZOOM, google_reference


DATASET_VERSION = "atlantis-terrain-pairs-v2"
DEFAULT_ROOT = Path(__file__).parent.parent / "sample" / "training_v2"
CHANNEL_NAMES = (
    "elevation", "slope", "southness", "eastness", "sun", "local_relief",
)
TEMPORARY_TEXTURE_SOURCES = {
    "placeholder", "ancestor_crop", "ancestor_crop_ratelimit",
    "ancestor_crop_nodata", "cooked_upscale", "fractal_upscale",
}


def _utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _resize_float(values, size: int) -> np.ndarray:
    return np.asarray(
        Image.fromarray(np.asarray(values, dtype=np.float32), mode="F").resize(
            (size, size), Image.Resampling.BILINEAR
        ),
        dtype=np.float32,
    )


def conditioning_channels(heightmap, tile_size_m: float, size: int) -> np.ndarray:
    """Image-oriented raw physical channels, stable across training/inference."""
    physical = terrain_channels(heightmap, tile_size_m)
    elevation = np.asarray(heightmap, dtype=np.float32)
    relief = elevation - np.asarray(
        Image.fromarray(elevation, mode="F").resize(
            (17, 17), Image.Resampling.BILINEAR
        ).resize((GRID_N, GRID_N), Image.Resampling.BILINEAR),
        dtype=np.float32,
    )
    values = {
        "elevation": elevation,
        "slope": physical["slope"],
        "southness": physical["southness"],
        "eastness": physical["eastness"],
        "sun": physical["sun"],
        "local_relief": relief,
    }
    return np.stack(
        [_resize_float(values[name][::-1], size) for name in CHANNEL_NAMES],
        axis=-1,
    ).astype(np.float32)


def normalize_channels(channels: np.ndarray) -> np.ndarray:
    """Fixed physical normalization; never fit normalization on a tile."""
    result = np.asarray(channels, dtype=np.float32).copy()
    result[..., 0] = np.clip(result[..., 0], -100.0, 1600.0) / 1000.0
    result[..., 1] = np.clip(result[..., 1], 0.0, 1.5) / 1.5
    result[..., 2] = np.clip(result[..., 2], -1.0, 1.0)
    result[..., 3] = np.clip(result[..., 3], -1.0, 1.0)
    result[..., 4] = np.clip(result[..., 4], 0.0, 2.0) / 2.0
    result[..., 5] = np.clip(result[..., 5], -150.0, 150.0) / 150.0
    return result


def ready_d12_tiles(db: sqlite3.Connection) -> list[str]:
    return [
        row[0] for row in db.execute(
            "SELECT t.tile_id FROM tiles t JOIN textures x USING(tile_id) "
            "WHERE t.depth=12 AND t.heightmap IS NOT NULL "
            "AND x.source NOT IN (?,?,?,?,?,?) ORDER BY t.tile_id",
            tuple(TEMPORARY_TEXTURE_SOURCES),
        )
    ]


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def export_tile_pair(
    db: sqlite3.Connection,
    tile_id: str,
    out_root: Path = DEFAULT_ROOT,
    *,
    size: int = 256,
    allow_network: bool = False,
    regression_tiles=(),
    reference_fn=google_reference,
) -> dict:
    row = db.execute(
        "SELECT t.depth,t.x_min,t.y_min,t.x_max,t.y_max,t.heightmap," 
        "x.texture,x.source FROM tiles t JOIN textures x USING(tile_id) "
        "WHERE t.tile_id=?",
        (tile_id,),
    ).fetchone()
    if row is None or int(row[0]) != 12 or row[5] is None or row[6] is None:
        raise ValueError(f"{tile_id} is not a ready D12 training tile")
    if str(row[7]) in TEMPORARY_TEXTURE_SOURCES:
        raise ValueError(f"{tile_id} has temporary texture source {row[7]}")
    bbox = tuple(float(value) for value in row[1:5])
    source = np.asarray(
        Image.open(io.BytesIO(row[6])).convert("RGB").resize(
            (size, size), Image.Resampling.LANCZOS
        ),
        dtype=np.uint8,
    )
    target = reference_fn(
        bbox, size=size, zoom=DEFAULT_ZOOM, allow_network=allow_network
    )
    if target is None:
        raise ValueError(f"{tile_id} has no cached Google reference")
    heightmap = _decompress_float32(row[5], (GRID_N, GRID_N))
    physical = conditioning_channels(heightmap, bbox[2] - bbox[0], size)
    _, segmented = load_segmented_tile(db, tile_id)
    annotations = read_annotations(db, tile_id)
    labels = semantic_mask(db, tile_id, segmented)
    human_mask = np.zeros(segmented.labels.shape, dtype=bool)
    for segment_id in annotations:
        human_mask |= segmented.labels == segment_id
    authority_water = np.asarray(
        segmented.channels.get("water", np.zeros(segmented.labels.shape))
    ) >= 0.5
    if labels.shape != (size, size):
        labels = np.asarray(
            Image.fromarray(labels, mode="I").resize(
                (size, size), Image.Resampling.NEAREST
            ),
            dtype=np.int16,
        )
    tile_dir = out_root / tile_id
    tile_dir.mkdir(parents=True, exist_ok=True)
    sample_path = tile_dir / "sample.npz"
    np.savez_compressed(
        sample_path,
        source=source,
        reference=np.asarray(target, dtype=np.uint8),
        terrain=physical,
        semantic=labels,
        bbox=np.asarray(bbox, dtype=np.float64),
        channel_names=np.asarray(CHANNEL_NAMES),
        class_names=np.asarray(CLASSES),
    )
    return {
        "tile": tile_id,
        "file": str(sample_path.relative_to(out_root)),
        "sha256": _file_sha256(sample_path),
        "split": geographic_split(tile_id, regression_tiles),
        "group": geographic_group(tile_id),
        "textureSource": str(row[7]),
        "size": size,
        "trustedPixels": int(np.count_nonzero(labels >= 0)),
        "humanPixels": int(np.count_nonzero(human_mask)),
        "authorityWaterPixels": int(np.count_nonzero(authority_water)),
        "classPixels": {
            name: int(np.count_nonzero(labels == index))
            for index, name in enumerate(CLASSES)
        },
    }


def write_manifest(out_root: Path, entries: list[dict]) -> dict:
    document = {
        "format": DATASET_VERSION,
        "createdAt": _utc_now(),
        "channelNames": list(CHANNEL_NAMES),
        "classNames": list(CLASSES),
        "entries": sorted(entries, key=lambda entry: entry["tile"]),
    }
    out_root.mkdir(parents=True, exist_ok=True)
    (out_root / "manifest.json").write_text(json.dumps(document, indent=2) + "\n")
    return document


def load_manifest(root: Path = DEFAULT_ROOT) -> dict:
    path = root / "manifest.json"
    if not path.exists():
        return {
            "format": DATASET_VERSION,
            "channelNames": list(CHANNEL_NAMES),
            "classNames": list(CLASSES),
            "entries": [],
        }
    document = json.loads(path.read_text())
    if document.get("format") != DATASET_VERSION:
        raise ValueError("unsupported classifier training dataset")
    return document


def export_pairs(
    db: sqlite3.Connection,
    tile_ids,
    out_root: Path = DEFAULT_ROOT,
    **kwargs,
) -> dict:
    existing = {
        entry["tile"]: entry for entry in load_manifest(out_root)["entries"]
    }
    for tile_id in tile_ids:
        existing[tile_id] = export_tile_pair(
            db, tile_id, out_root, **kwargs
        )
    return write_manifest(out_root, list(existing.values()))
