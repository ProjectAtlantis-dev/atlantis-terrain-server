"""Classifier vote ladder from its broad D8 rung to the target rung.

Every level contributes one equally weighted local classification. Parent
votes are cropped into the selected child quadrant and enlarged with nearest
sampling, so a D8 decision remains present at D12 without smearing class
identities. The complete tally is retained; the displayed class is only a
view of those votes. A tie is resolved by the newest (finest) local vote.
"""
from __future__ import annotations

import numpy as np

from tile_address import require_tile_id


LADDER_START_DEPTH = 8
LADDER_SOURCE = "ladder_d8_votes_v1"


def ladder_tile_ids(tile_id: str, start_depth: int = LADDER_START_DEPTH) -> list[str]:
    depth, col, row = require_tile_id(tile_id)
    if depth < start_depth:
        raise ValueError(f"classifier ladder starts at D{start_depth}")
    return [
        f"{level}-{col >> (depth - level)}-{row >> (depth - level)}"
        for level in range(start_depth, depth + 1)
    ]


def crop_parent_field(field, child_col: int, child_row: int):
    """Crop one north-first parent raster/tally into an immediate child."""
    array = np.asarray(field)
    height, width = array.shape[-2:]
    x0, x1 = (child_col & 1) * width // 2, ((child_col & 1) + 1) * width // 2
    north_half = 1 - (child_row & 1)
    y0, y1 = north_half * height // 2, (north_half + 1) * height // 2
    crop = array[..., y0:y1, x0:x1]
    expanded = np.repeat(np.repeat(crop, 2, axis=-2), 2, axis=-1)
    return expanded[..., :height, :width].copy()


def add_vote(parent_votes, local_labels, class_count: int):
    """Add a local level vote and return tally, winner, and confidence."""
    labels = np.asarray(local_labels, dtype=np.uint8)
    if labels.ndim != 2:
        raise ValueError("local classifier vote must be a 2D label map")
    if labels.size and int(labels.max()) >= class_count:
        raise ValueError("local classifier vote contains an unknown class")
    if parent_votes is None:
        votes = np.zeros((class_count, *labels.shape), dtype=np.uint16)
    else:
        votes = np.asarray(parent_votes, dtype=np.uint16).copy()
        if votes.shape != (class_count, *labels.shape):
            raise ValueError("parent vote shape does not match local labels")
    rows, cols = np.indices(labels.shape)
    votes[labels, rows, cols] += 1
    maximum = votes.max(axis=0)
    winners = votes.argmax(axis=0).astype(np.uint8)
    # A finer observation refines its ancestors when the tally is tied.
    tied_local = votes[labels, rows, cols] == maximum
    winners[tied_local] = labels[tied_local]
    totals = votes.sum(axis=0)
    confidence = np.rint(255.0 * maximum / np.maximum(totals, 1)).astype(np.uint8)
    return votes, winners, confidence
