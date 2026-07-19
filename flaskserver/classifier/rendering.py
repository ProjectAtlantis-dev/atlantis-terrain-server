"""Rendering helpers for classifier debug textures."""
from __future__ import annotations

import numpy as np
from PIL import Image


CLASSIFIER_WATER_RGB = (255, 42, 161)
BLACK_WATER_SHADOW_RGB = (0, 255, 0)


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


def paint_navy_water_shadows(classifier_rgb, satellite_rgb):
    """Paint navy source shadows green within pink classifier water only."""
    result = np.asarray(classifier_rgb, dtype=np.uint8).copy()
    satellite = np.asarray(satellite_rgb, dtype=np.uint8)
    if result.ndim != 3 or result.shape[2] != 3:
        raise ValueError("classifier RGB must have shape (height, width, 3)")
    if satellite.shape != result.shape:
        raise ValueError("satellite RGB must match classifier RGB shape")
    water = np.all(result == CLASSIFIER_WATER_RGB, axis=2)
    # Supplied crop: navy shadow B/G ~= 1.30, adjacent teal B/G ~= 1.10.
    # Integer ratio math preserves that hue distinction across exposure.
    blue = satellite[:, :, 2].astype(np.uint16)
    green = satellite[:, :, 1].astype(np.uint16)
    navy = blue * 100 >= green * 120
    shadow = water & navy
    result[shadow] = BLACK_WATER_SHADOW_RGB
    return result, shadow
