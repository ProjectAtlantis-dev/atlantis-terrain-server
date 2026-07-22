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
# Classification of a contract-depth tile from its own final texture and
# measured heightmap — no cook involved. Same proposal/veto physics; d12 is
# "good enough to get the general idea" and everything deeper derives from it.
LIVE_D12_CLASS_SOURCE = "coarse_d12_live_v1"

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


# Per-class multiplicative detail strength for the cook-time texture bake.
# Indexed by coarse_v1 label. Water stays untouched; snow nearly calm.
_BAKE_STRENGTH = np.asarray([0.16, 0.12, 0.12, 0.05, 0.0], dtype=np.float32)
# Ridged (creased rock) vs smooth (soft tuft) blend per class.
_BAKE_RIDGED = np.asarray([0.85, 0.15, 0.7, 0.2, 0.0], dtype=np.float32)


def bake_texture_detail(rgb, labels, bbox, seed=0x41544C41):
    """Bake one octave of class-conditioned detail into a cooked texture.

    Not a Lanczos pass-through: each cook level adds exactly the frequency
    band its enlargement created headroom for — wavelength ~3 output pixels
    in world meters — so successive cooks stack disjoint octaves instead of
    double-applying. The noise is a pure function of absolute EPSG:3413
    coordinates (deterministic, continuous across every tile border), the
    modulation is multiplicative (dark imagery stays dark — no grey-splotch
    artifacts on shadowed ground), and per-class strength/character comes
    from the classifier: ridged creases on rock, fine stipple on
    vegetation, near-calm snow, silent water.

    rgb: HxWx3 uint8 (image orientation, north row 0) covering bbox.
    labels: coarse_v1 uint8 map, same orientation, any square size.
    Returns a new uint8 array; the input is not modified.
    """
    from terrain_upscale import _value_noise

    source = np.asarray(rgb, dtype=np.float32)
    size = source.shape[0]
    label_map = np.asarray(labels, dtype=np.uint8)
    if label_map.shape[0] != size:
        label_map = np.asarray(
            Image.fromarray(label_map, mode="L").resize(
                (size, size), Image.Resampling.NEAREST
            ),
            dtype=np.uint8,
        )
    pixel_m = (float(bbox[2]) - float(bbox[0])) / size
    wavelength = 3.0 * pixel_m
    x = np.linspace(float(bbox[0]), float(bbox[2]), size, dtype=np.float64)[None, :]
    # Image row 0 is north = bbox y_max.
    y = np.linspace(float(bbox[3]), float(bbox[1]), size, dtype=np.float64)[:, None]
    smooth = _value_noise(x, y, wavelength, seed ^ 0x42414B45)
    ridged = 1.0 - 2.0 * np.abs(
        _value_noise(x, y, wavelength * 0.75, seed ^ 0x52494447)
    )
    # Center with a CONSTANT (the field's approximate global mean), never a
    # per-tile mean — per-tile statistics would break world continuity at
    # every tile border.
    ridged -= 0.3
    character = _BAKE_RIDGED[label_map]
    detail = smooth * (1.0 - character) + ridged * character
    modulation = 1.0 + _BAKE_STRENGTH[label_map] * detail.astype(np.float32)
    return np.clip(source * modulation[..., None], 0.0, 255.0).astype(np.uint8)


def classify_tile_surface(rgb, heightmap, bbox, water_mask=None, output_size=256):
    """Classify one tile from its own texture and measured heightmap.

    The proposal/veto logic is depth-agnostic — classify_cooked_quad only
    ever needed an rgb image and a surface covering the same bbox. This
    wrapper names the non-cook use: live classification of a contract-depth
    (d12) tile so masks exist before any deep cook has run.
    """
    labels, _amplitude, _character = classify_cooked_quad(
        rgb, heightmap, bbox, water_mask=water_mask, output_size=output_size,
    )
    return labels


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
    # Yellow-green (dry/autumn tundra: R and G both elevated, B low) has a
    # much smaller green_excess than pure green despite reading as living
    # ground cover — gate on hue shape (G the max or near-max channel, and
    # clearly ahead of B) instead of excess magnitude alone.
    yellow_green = (
        (rgb[..., 1] >= rgb[..., 0] * 0.85)
        & (rgb[..., 1] > rgb[..., 2] * 1.08)
        & (rgb[..., 1] >= rgb[..., 2])
    )

    labels = np.full((output_size, output_size), np.uint8(GREY))
    labels[luminance < DARK_MAX_LUMINANCE] = np.uint8(DARK)
    labels[(green_excess > GREEN_MIN_EXCESS) | yellow_green] = np.uint8(GREEN)
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
