"""Persistent preparation cache for deterministic cliff-graft donors.

Cliff grafts are projected in world space by the renderer, so there is no
per-target-tile bitmap to bake.  The reusable artifact is the donor texture
after classifier water/lake pixels have been replaced with nearest land.
Store that lossless PNG once in SQLite so every process and browser shares it.
"""
from __future__ import annotations

import datetime
import hashlib
import io
import json
import threading

import numpy as np
from PIL import Image

from classifier.storage import CLASS_SCHEMAS, decode_class_map
from tile_address import parse_tile_id


CLIFF_GRAFT_ASSET_VERSION = 1

_SCHEMA = """
CREATE TABLE IF NOT EXISTS cliff_graft_assets (
    donor_tile_id       TEXT NOT NULL,
    recipe_version      INTEGER NOT NULL,
    source_fingerprint  TEXT NOT NULL,
    width               INTEGER NOT NULL CHECK (width > 0),
    height              INTEGER NOT NULL CHECK (height > 0),
    water_pixels        INTEGER NOT NULL CHECK (water_pixels >= 0),
    texture             BLOB NOT NULL,
    updated_at          TEXT NOT NULL,
    PRIMARY KEY (donor_tile_id, recipe_version)
);
"""

_prepare_lock = threading.RLock()


def init_cliff_graft_assets(db) -> None:
    db.executescript(_SCHEMA)
    db.commit()


def _classifier_ancestor(db, tile_id: str):
    parsed = parse_tile_id(tile_id)
    if parsed is None:
        return None
    child_depth, child_col, child_row = parsed
    depth, column, row = parsed
    while depth >= 0:
        candidate_id = f"{depth}-{column}-{row}"
        found = db.execute(
            "SELECT class_schema, width, height, class_map, source, updated_at "
            "FROM classifier_tiles WHERE tile_id = ?",
            (candidate_id,),
        ).fetchone()
        if found is not None:
            return {
                "tile_id": candidate_id,
                "depth": depth,
                "child_depth": child_depth,
                "child_col": child_col,
                "child_row": child_row,
                "schema": found[0],
                "width": int(found[1]),
                "height": int(found[2]),
                "blob": found[3],
                "source": found[4],
                "updated_at": found[5],
            }
        depth -= 1
        column //= 2
        row //= 2
    return None


def _mask_dependency_rows(db, tile_id: str):
    rows = []
    for table in ("coastline_masks", "hydrography_masks"):
        try:
            row = db.execute(
                f"SELECT width, height, mask, source, version, updated_at "
                f"FROM {table} WHERE tile_id = ?",
                (tile_id,),
            ).fetchone()
        except Exception:
            row = None
        rows.append((table, row))
    return rows


def _fingerprint(tile_id, texture_row, classifier, mask_rows) -> str:
    digest = hashlib.sha256()
    metadata = {
        "tile": tile_id,
        "recipe": CLIFF_GRAFT_ASSET_VERSION,
        "texture_source": texture_row[1],
        "texture_updated_at": texture_row[2],
        "classifier_tile": classifier["tile_id"],
        "classifier_schema": classifier["schema"],
        "classifier_source": classifier["source"],
        "classifier_updated_at": classifier["updated_at"],
    }
    digest.update(json.dumps(metadata, sort_keys=True).encode("utf-8"))
    digest.update(texture_row[0])
    digest.update(classifier["blob"])
    for table, row in mask_rows:
        digest.update(table.encode("ascii"))
        if row is None:
            digest.update(b"missing")
            continue
        digest.update(str((row[0], row[1], row[3], row[4], row[5])).encode("utf-8"))
        digest.update(row[2])
    return digest.hexdigest()


def _water_labels(classifier, output_width: int, output_height: int):
    labels = decode_class_map(
        classifier["blob"], classifier["width"], classifier["height"],
    )
    depth = classifier["depth"]
    child_depth = classifier["child_depth"]
    if depth != child_depth:
        divisions = 1 << (child_depth - depth)
        sub_col = classifier["child_col"] % divisions
        sub_row = classifier["child_row"] % divisions
        x0 = sub_col * classifier["width"] // divisions
        x1 = (sub_col + 1) * classifier["width"] // divisions
        # Classifier rows are image-oriented: row zero is north.
        y0 = (divisions - 1 - sub_row) * classifier["height"] // divisions
        y1 = (divisions - sub_row) * classifier["height"] // divisions
        labels = labels[y0:y1, x0:x1]
    resized = Image.fromarray(labels, mode="L").resize(
        (output_width, output_height), Image.Resampling.NEAREST,
    )
    output = np.asarray(resized)
    schema = CLASS_SCHEMAS.get(classifier["schema"])
    if schema is None:
        raise ValueError(f"unknown classifier schema: {classifier['schema']}")
    water_indices = [
        schema["names"].index(name)
        for name in ("water", "lake")
        if name in schema["names"]
    ]
    return np.isin(output, water_indices)


def _inpaint_nearest_land(rgba: np.ndarray, water: np.ndarray) -> int:
    """Exact deterministic port of the browser's multi-source flood fill."""
    height, width = water.shape
    pixel_count = width * height
    nearest_land = np.full(pixel_count, -1, dtype=np.int32)
    queue = np.empty(pixel_count, dtype=np.int32)
    tail = 0
    flat_water = water.reshape(-1)
    for index in range(pixel_count):
        if flat_water[index]:
            continue
        nearest_land[index] = index
        queue[tail] = index
        tail += 1
    water_pixels = pixel_count - tail
    if water_pixels == 0:
        return 0
    if tail == 0:
        raise ValueError("cliff graft donor contains no classified land pixels")

    head = 0
    while head < tail:
        index = int(queue[head])
        head += 1
        x = index % width
        y = index // width
        donor = nearest_land[index]
        neighbors = []
        if x > 0:
            neighbors.append(index - 1)
        if x + 1 < width:
            neighbors.append(index + 1)
        if y > 0:
            neighbors.append(index - width)
        if y + 1 < height:
            neighbors.append(index + width)
        for neighbor in neighbors:
            if nearest_land[neighbor] != -1:
                continue
            nearest_land[neighbor] = donor
            queue[tail] = neighbor
            tail += 1

    flat = rgba.reshape((-1, 4))
    source = flat.copy()
    water_indexes = np.flatnonzero(flat_water)
    flat[water_indexes] = source[nearest_land[water_indexes]]
    return int(water_pixels)


def get_or_create_cliff_graft_asset(db, tile_id: str):
    """Return a persisted donor PNG and whether this call generated it.

    ``None`` means the donor texture or a real classifier ancestor is not
    ready yet. The caller should return a retryable response.
    """
    if parse_tile_id(tile_id) is None:
        raise ValueError(f"invalid cliff graft donor tile id: {tile_id}")
    init_cliff_graft_assets(db)
    with _prepare_lock:
        texture_row = db.execute(
            "SELECT texture, source, updated_at FROM textures WHERE tile_id = ?",
            (tile_id,),
        ).fetchone()
        classifier = _classifier_ancestor(db, tile_id)
        if texture_row is None or classifier is None:
            return None
        mask_rows = _mask_dependency_rows(db, tile_id)
        fingerprint = _fingerprint(tile_id, texture_row, classifier, mask_rows)
        cached = db.execute(
            "SELECT texture, width, height, water_pixels, updated_at "
            "FROM cliff_graft_assets "
            "WHERE donor_tile_id = ? AND recipe_version = ? "
            "AND source_fingerprint = ?",
            (tile_id, CLIFF_GRAFT_ASSET_VERSION, fingerprint),
        ).fetchone()
        if cached is not None:
            return {
                "texture": cached[0],
                "width": int(cached[1]),
                "height": int(cached[2]),
                "water_pixels": int(cached[3]),
                "updated_at": cached[4],
                "fingerprint": fingerprint,
                "generated": False,
            }

        image = Image.open(io.BytesIO(texture_row[0])).convert("RGBA")
        rgba = np.asarray(image).copy()
        water = _water_labels(classifier, image.width, image.height)
        from classifier.rendering import smooth_effective_water_mask
        from coastline import read_water_mask

        effective_water = read_water_mask(db, tile_id)
        if effective_water is not None:
            water |= smooth_effective_water_mask(
                effective_water, image.width, image.height,
            )
        water_pixels = _inpaint_nearest_land(rgba, water)
        output = io.BytesIO()
        Image.fromarray(rgba, mode="RGBA").save(
            output, format="PNG", optimize=True,
        )
        payload = output.getvalue()
        updated_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        db.execute(
            "INSERT INTO cliff_graft_assets "
            "(donor_tile_id, recipe_version, source_fingerprint, width, height, "
            "water_pixels, texture, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(donor_tile_id, recipe_version) DO UPDATE SET "
            "source_fingerprint=excluded.source_fingerprint, "
            "width=excluded.width, height=excluded.height, "
            "water_pixels=excluded.water_pixels, texture=excluded.texture, "
            "updated_at=excluded.updated_at",
            (
                tile_id, CLIFF_GRAFT_ASSET_VERSION, fingerprint,
                image.width, image.height, water_pixels, payload, updated_at,
            ),
        )
        db.commit()
        return {
            "texture": payload,
            "width": image.width,
            "height": image.height,
            "water_pixels": water_pixels,
            "updated_at": updated_at,
            "fingerprint": fingerprint,
            "generated": True,
        }
