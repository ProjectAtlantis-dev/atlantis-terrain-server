"""Image-oriented official water masks for classifier inputs and outputs."""
from __future__ import annotations

import numpy as np
from PIL import Image

from coastline import fetch_official_water_mask
from database import GRID_N


def classifier_water_mask(bbox, width: int, height: int) -> np.ndarray | None:
    """Return an official north-first mask matching a classifier raster.

    The coastline authority is sampled on the canonical terrain grid.  GTK50
    does not justify a denser shoreline, and reusing this grid keeps classifier
    water aligned with the geometry that was clamped during DEM ingestion.
    """
    south_first = fetch_official_water_mask(bbox, GRID_N)
    if south_first is None:
        return None
    north_first = np.ascontiguousarray(south_first[::-1].astype(np.uint8) * 255)
    resized = Image.fromarray(north_first, mode="L").resize(
        (int(width), int(height)), Image.Resampling.NEAREST
    )
    return np.asarray(resized, dtype=np.uint8) >= 128


def classifier_water_mask_for_tile(db, tile_id: str, width: int, height: int):
    row = db.execute(
        "SELECT x_min, y_min, x_max, y_max FROM tiles WHERE tile_id = ?",
        (tile_id,),
    ).fetchone()
    if row is None:
        return None
    return classifier_water_mask(tuple(float(value) for value in row), width, height)
