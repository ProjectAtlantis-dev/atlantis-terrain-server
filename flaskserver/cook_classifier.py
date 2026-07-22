"""Physics-first coarse classification inside the fractal texture cook.

There is no semantic contract below the official water mask yet (no d12
classifier coverage beyond water and roads), so cooked tiles classify
themselves: a coarse color read of the parent's final texture proposes
labels, and the physics of the upscaled heightmap surface vetoes them.
The vetoes are law: steep ground and north faces carry nothing living,
whatever color the imagery has — imagery lies under cloud shadow, the
surface does not.

Outputs are image-oriented (row 0 = north) to match classifier storage and
the texture pipeline; heightmap inputs are south-first like the database.
All inputs are world-anchored and deterministic, so labels reproduce
identically and stay consistent across tile borders.
"""
from __future__ import annotations

import numpy as np
from PIL import Image

from terrain_upscale import _resize_bilinear

COOK_CLASS_SOURCE = "fractal_cook_v1"

# coarse_v1 label indices (classifier.storage.CLASS_SCHEMAS order).
GREY, GREEN, DARK, WHITE, WATER = 0, 1, 2, 3, 4

# Physics vetoes, slope in rise/run units from the upscaled surface.
SLOPE_VEG_MAX = 0.35      # ~19 deg: no vegetation on steeper ground
SLOPE_ROCK_MIN = 0.70     # ~35 deg: bare rock regardless of imagery color
VEG_MIN_SOUTHNESS = 0.05  # north SLOPES never carry anything living...
ASPECT_SLOPE_MIN = 0.08   # ...but flat ground has no aspect; valleys stay green

# Color proposal thresholds on the parent imagery (0-255).
WHITE_MIN_LUMINANCE = 190.0
DARK_MAX_LUMINANCE = 55.0
GREEN_MIN_EXCESS = 10.0

# Detail energy per class: rock carries the roughness, vegetation softens
# it, snow and water stay calm. Slope sharpens everything on top.
_CLASS_AMPLITUDE = np.asarray([1.0, 0.45, 0.8, 0.25, 0.0], dtype=np.float32)
_CLASS_CHARACTER_CAP = np.asarray([0.9, 0.3, 0.75, 0.25, 0.0], dtype=np.float32)


def surface_channels(heightmap, tile_size_m, output_size):
    """Slope and southness of a south-first surface, image-oriented."""
    surface = np.asarray(heightmap, dtype=np.float64)
    spacing = float(tile_size_m) / (surface.shape[0] - 1)
    gy, gx = np.gradient(surface, spacing)
    slope = np.hypot(gx, gy)
    southness = gy / np.sqrt(gx * gx + gy * gy + 1.0)
    slope = _resize_bilinear(np.flipud(slope), output_size, output_size)
    southness = _resize_bilinear(np.flipud(southness), output_size, output_size)
    return slope, southness


def classify_cooked_quad(
    parent_rgb,
    upscaled_heightmap,
    bbox,
    water_mask=None,
    output_size=512,
):
    """Classify a cooked parent quad; returns (labels, amplitude, character).

    parent_rgb: HxWx3 uint8, image orientation (the parent's final texture).
    upscaled_heightmap: south-first surface covering bbox (the DEM cook
    output — the same array served as the child meshes).
    water_mask: south-first bool array on the parent grid, or None.

    labels are coarse_v1 uint8 at output_size^2; amplitude and character are
    float32 fields in [0, ~1.3] / [0, 0.9] that drive the texture painter's
    detail energy and smooth-vs-ridged blend per pixel.
    """
    rgb = np.asarray(
        Image.fromarray(np.asarray(parent_rgb, dtype=np.uint8), "RGB").resize(
            (output_size, output_size), Image.Resampling.BILINEAR
        ),
        dtype=np.float32,
    )
    tile_size_m = float(bbox[2]) - float(bbox[0])
    slope, southness = surface_channels(
        upscaled_heightmap, tile_size_m, output_size
    )

    luminance = rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722
    green_excess = rgb[..., 1] - 0.5 * (rgb[..., 0] + rgb[..., 2])

    labels = np.full((output_size, output_size), np.uint8(GREY))
    labels[luminance < DARK_MAX_LUMINANCE] = np.uint8(DARK)
    labels[green_excess > GREEN_MIN_EXCESS] = np.uint8(GREEN)
    labels[luminance > WHITE_MIN_LUMINANCE] = np.uint8(WHITE)

    # Physics vetoes outrank every color proposal.
    living_banned = (slope > SLOPE_VEG_MAX) | (
        (slope > ASPECT_SLOPE_MIN) & (southness < VEG_MIN_SOUTHNESS)
    )
    labels[(labels == GREEN) & living_banned] = np.uint8(GREY)
    labels[slope > SLOPE_ROCK_MIN] = np.uint8(GREY)

    if water_mask is not None:
        water = _resize_bilinear(
            np.flipud(np.asarray(water_mask, dtype=np.float64)),
            output_size,
            output_size,
        ) >= 0.5
        labels[water] = np.uint8(WATER)

    slope_norm = np.clip(slope, 0.0, 1.0)
    amplitude = (
        _CLASS_AMPLITUDE[labels] * (0.55 + 0.9 * slope_norm)
    ).astype(np.float32)
    character = np.minimum(
        np.float32(0.2) + np.float32(1.2) * slope_norm.astype(np.float32),
        _CLASS_CHARACTER_CAP[labels],
    ).astype(np.float32)
    return labels, amplitude, character
