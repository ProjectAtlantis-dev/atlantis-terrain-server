"""Rendering helpers for classifier debug textures."""
from __future__ import annotations

import numpy as np
from PIL import Image


def smooth_effective_water_mask(south_first, width: int, height: int):
    """Upscale a terrain-grid water mask into a smoother image-grid mask.

    Coastline masks are stored in the terrain heightmap's south-first
    orientation. Bilinear interpolation followed by a midpoint threshold keeps
    the result binary, but reconstructs the boundary at the output resolution
    instead of exposing every source-grid cell as a large square.
    """
    north_first = np.ascontiguousarray(
        np.asarray(south_first, dtype=np.uint8)[::-1] * 255
    )
    resized = Image.fromarray(north_first, mode="L").resize(
        (int(width), int(height)), Image.Resampling.BILINEAR
    )
    return np.asarray(resized, dtype=np.uint8) >= 128
