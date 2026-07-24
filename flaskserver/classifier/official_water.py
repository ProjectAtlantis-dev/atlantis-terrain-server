"""Image-oriented official water masks for classifier inputs and outputs."""
from __future__ import annotations

import numpy as np
from PIL import Image

from coastline import (
    cache_official_water_mask,
    read_water_mask,
)
from database import GRID_N


def _resize_for_classifier(south_first, width: int, height: int):
    if south_first is None:
        return None
    north_first = np.ascontiguousarray(south_first[::-1].astype(np.uint8) * 255)
    resized = Image.fromarray(north_first, mode="L").resize(
        (int(width), int(height)), Image.Resampling.NEAREST
    )
    return np.asarray(resized, dtype=np.uint8) >= 128


def classifier_water_mask_for_tile(db, tile_id: str, width: int, height: int):
    south_first = read_water_mask(db, tile_id)
    if south_first is None:
        south_first = cache_official_water_mask(db, tile_id, resolution=GRID_N)
    return _resize_for_classifier(south_first, width, height)
