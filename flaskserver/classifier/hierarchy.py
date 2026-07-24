"""Coarse-to-fine priors for the authoritative D12 classification.

D10 answers whether an inferred lake exists at all; D11 localizes that
support; D12 resolves the precise boundary. These helpers read only measured
ancestor imagery/DEM. They never classify or persist a D13+ tile.
"""
from __future__ import annotations

import io

import numpy as np
from PIL import Image
from scipy import ndimage

from classifier.ladder import lake_support_mask
from database import read_tile
from tile_address import require_tile_id


TEMPORARY_TEXTURE_SOURCES = {
    "sentinel2_crop",
    "ancestor_crop",
    "ancestor_crop_ratelimit",
    "dataforsyningen",
    "dataforsyningen_metatile",
    "dataforsyningen_metatile4",
    "dataforsyningen_metatile4h",
}


def lake_prior_ancestor_ids(tile_id: str) -> tuple[str, str]:
    depth, col, row = require_tile_id(tile_id)
    if depth != 12:
        raise ValueError("lake hierarchy prior is defined for d12 tiles")
    return (
        f"10-{col >> 2}-{row >> 2}",
        f"11-{col >> 1}-{row >> 1}",
    )


def _ancestor_support(db, child_id: str, ancestor_depth: int):
    child_depth, child_col, child_row = require_tile_id(child_id)
    levels = child_depth - ancestor_depth
    divisions = 1 << levels
    ancestor_col = child_col >> levels
    ancestor_row = child_row >> levels
    ancestor_id = f"{ancestor_depth}-{ancestor_col}-{ancestor_row}"
    texture_row = db.execute(
        "SELECT texture, source FROM textures WHERE tile_id = ?",
        (ancestor_id,),
    ).fetchone()
    if (
        texture_row is None
        or texture_row[0] is None
        or texture_row[1] in TEMPORARY_TEXTURE_SOURCES
    ):
        return None
    tile = read_tile(db, ancestor_id)
    if tile is None or tile.get("heightmap") is None:
        return None

    rgb = np.asarray(Image.open(io.BytesIO(texture_row[0])).convert("RGB"))
    support = lake_support_mask(
        rgb, tile["heightmap"], list(tile["bbox"]), output_size=256,
    )
    # One parent pixel of tolerance lets D12 refine a coarse shoreline without
    # allowing it to originate a water body where the parent saw none.
    support = ndimage.binary_dilation(support, iterations=1)
    sub_col = child_col % divisions
    sub_row = child_row % divisions
    # scipy's type stub preserves only ``tuple[int]`` for this result even
    # though the classifier contract is a 2D mask; ``-1`` is valid for both.
    x0 = sub_col * support.shape[-1] // divisions
    x1 = (sub_col + 1) * support.shape[-1] // divisions
    # Support rasters are image-oriented while quadtree rows increase north.
    y0 = (divisions - 1 - sub_row) * support.shape[0] // divisions
    y1 = (divisions - sub_row) * support.shape[0] // divisions
    crop = support[y0:y1, x0:x1]
    return np.asarray(
        Image.fromarray(crop.astype(np.uint8) * 255, mode="L").resize(
            (256, 256), Image.Resampling.NEAREST,
        )
    ) > 0


def d12_lake_prior(db, tile_id: str):
    """Return strict D10∩D11 inferred-lake support, or None if unavailable."""
    d10 = _ancestor_support(db, tile_id, 10)
    d11 = _ancestor_support(db, tile_id, 11)
    if d10 is None or d11 is None:
        return None
    return d10 & d11
