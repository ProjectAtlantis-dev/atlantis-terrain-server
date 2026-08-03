"""Geometry-aware superpixel segmentation for terrain imagery.

The output is deliberately not a semantic class map.  It partitions an RGB
terrain texture into small contiguous regions whose boundaries follow both
appearance and DEM geometry.  A later classifier can predict one semantic
label per region (or use the region statistics as additional features).

Input orientation matters: ``heightmap`` uses the database/mesh convention
(row zero is south), while ``rgb`` and the returned labels use image convention
(row zero is north).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import cast

import numpy as np
from PIL import Image
from scipy import ndimage


SEGMENTER_VERSION = "terrain_slic_v2"


@dataclass(frozen=True)
class SegmentationConfig:
    """Physical scales and feature weights for terrain superpixels."""

    target_segment_m: float = 40.0
    color_weight: float = 1.0
    geometry_weight: float = 1.25
    elevation_scale_m: float = 100.0
    slope_scale_degrees: float = 30.0
    relief_scale_m: float = 30.0
    relief_radius_m: float = 80.0
    sea_level_m: float = 1.0
    image_blur_pixels: float = 0.8
    compactness: float = 0.35
    iterations: int = 6


@dataclass(frozen=True)
class SegmentationResult:
    """Image-oriented region raster and classifier-friendly measurements."""

    labels: np.ndarray
    regions: tuple[dict, ...]
    channels: dict[str, np.ndarray]


def _validate_inputs(rgb, heightmap, tile_size_m, config):
    rgb = np.asarray(rgb)
    heightmap = np.asarray(heightmap, dtype=np.float32)
    if rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError("rgb must have shape (height, width, 3)")
    if rgb.shape[0] < 2 or rgb.shape[1] < 2:
        raise ValueError("rgb must be at least 2x2 pixels")
    if heightmap.ndim != 2 or min(heightmap.shape) < 2:
        raise ValueError("heightmap must be a 2D array at least 2x2")
    if not np.isfinite(tile_size_m) or tile_size_m <= 0:
        raise ValueError("tile_size_m must be positive")
    if config.target_segment_m <= 0:
        raise ValueError("target_segment_m must be positive")
    return np.clip(rgb, 0, 255).astype(np.uint8), heightmap


def _fill_heightmap(heightmap):
    """Replace sparse DEM holes without turning them into artificial edges."""
    valid = np.isfinite(heightmap)
    if valid.all():
        return heightmap.astype(np.float32, copy=False)
    if not valid.any():
        raise ValueError("heightmap contains no finite samples")
    nearest = cast(
        np.ndarray,
        ndimage.distance_transform_edt(
            ~valid, return_distances=False, return_indices=True
        ),
    )
    return heightmap[tuple(nearest)].astype(np.float32)


def _resize_float(array, width, height):
    image = Image.fromarray(np.asarray(array, dtype=np.float32), mode="F")
    return np.asarray(
        image.resize((width, height), Image.Resampling.BILINEAR),
        dtype=np.float32,
    )


def _rgb_to_lab(rgb):
    """Convert sRGB uint8 to CIE Lab (D65), without another dependency."""
    srgb = rgb.astype(np.float32) / 255.0
    linear = np.where(
        srgb <= 0.04045,
        srgb / 12.92,
        ((srgb + 0.055) / 1.055) ** 2.4,
    )
    xyz = linear @ np.asarray(
        (
            (0.4124564, 0.3575761, 0.1804375),
            (0.2126729, 0.7151522, 0.0721750),
            (0.0193339, 0.1191920, 0.9503041),
        ),
        dtype=np.float32,
    ).T
    xyz /= np.asarray((0.95047, 1.0, 1.08883), dtype=np.float32)
    delta = 6.0 / 29.0
    f = np.where(
        xyz > delta ** 3,
        np.cbrt(xyz),
        xyz / (3 * delta * delta) + 4.0 / 29.0,
    )
    return np.stack(
        (116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]),
         200 * (f[..., 1] - f[..., 2])),
        axis=-1,
    ).astype(np.float32)


def terrain_feature_channels(
    rgb, heightmap, tile_size_m, config=None, *, water_mask=None
):
    """Build image-aligned appearance and DEM channels used by segmentation.

    ``water_mask`` is the official north-first image mask. Elevation is used
    only as a backwards-compatible fallback when no authoritative mask exists.
    """
    config = config or SegmentationConfig()
    rgb, heightmap = _validate_inputs(rgb, heightmap, tile_size_m, config)
    heightmap = _fill_heightmap(heightmap)
    out_h, out_w = rgb.shape[:2]

    # Geometry is calculated at native DEM resolution before interpolation.
    # The database grid includes both tile edges, hence N-1 intervals.
    spacing_y = tile_size_m / (heightmap.shape[0] - 1)
    spacing_x = tile_size_m / (heightmap.shape[1] - 1)
    gy, gx = np.gradient(heightmap, spacing_y, spacing_x)
    gradient = np.hypot(gx, gy)
    slope_degrees = np.degrees(np.arctan(gradient)).astype(np.float32)
    normal_length = np.sqrt(gx * gx + gy * gy + 1.0)
    # Positive gy means the surface rises northward, so its normal faces
    # south. Keep aspect components independent: the trained model learns
    # their interaction with color instead of a hand-written product gate.
    southness_native = (gy / normal_length).astype(np.float32)
    eastness_native = (-gx / normal_length).astype(np.float32)
    sun_elevation = np.deg2rad(25.0)
    insolation_native = np.clip(
        (gy * np.cos(sun_elevation) + np.sin(sun_elevation))
        / (normal_length * np.sin(sun_elevation)),
        0.0,
        2.0,
    ).astype(np.float32)
    relief_sigma = max(
        0.5,
        config.relief_radius_m / max(spacing_x, spacing_y),
    )
    local_relief = heightmap - ndimage.gaussian_filter(
        heightmap, relief_sigma, mode="nearest"
    )

    # Flip south-first DEM rows into north-first image rows exactly once.
    elevation = _resize_float(heightmap[::-1], out_w, out_h)
    slope = _resize_float(slope_degrees[::-1], out_w, out_h)
    relief = _resize_float(local_relief[::-1], out_w, out_h)
    southness = _resize_float(southness_native[::-1], out_w, out_h)
    eastness = _resize_float(eastness_native[::-1], out_w, out_h)
    insolation = _resize_float(insolation_native[::-1], out_w, out_h)
    if water_mask is None:
        water = (elevation <= config.sea_level_m).astype(np.float32)
    else:
        water = np.asarray(water_mask, dtype=bool)
        if water.shape != (out_h, out_w):
            raise ValueError(
                f"water_mask shape {water.shape} must match RGB shape "
                f"{(out_h, out_w)}"
            )
        water = water.astype(np.float32)
    valid_rgb = (rgb.max(axis=2) > 3).astype(np.float32)
    lab = _rgb_to_lab(rgb)

    return {
        "lab": lab,
        "elevation": elevation,
        "slope_degrees": slope,
        "local_relief": relief,
        "southness": southness,
        "eastness": eastness,
        "insolation": insolation,
        "water": water,
        "valid_rgb": valid_rgb,
    }


def _boundary_cost(channels, config):
    lab = channels["lab"]
    features = (
        (lab[..., 0] / 100.0, config.color_weight),
        (lab[..., 1] / 128.0, config.color_weight),
        (lab[..., 2] / 128.0, config.color_weight),
        (channels["elevation"] / config.elevation_scale_m,
         config.geometry_weight * 0.65),
        (channels["slope_degrees"] / config.slope_scale_degrees,
         config.geometry_weight),
        (channels["local_relief"] / config.relief_scale_m,
         config.geometry_weight * 0.8),
        (channels["water"], config.geometry_weight * 2.0),
        (channels["valid_rgb"], config.color_weight * 2.0),
    )
    cost = np.zeros(lab.shape[:2], dtype=np.float32)
    for feature, weight in features:
        dx = ndimage.sobel(feature, axis=1, mode="nearest") / 8.0
        dy = ndimage.sobel(feature, axis=0, mode="nearest") / 8.0
        cost += weight * np.hypot(dx, dy)

    nonzero = cost[cost > 0]
    if not nonzero.size:
        return np.zeros(cost.shape, dtype=np.uint8)
    scale = float(np.percentile(nonzero, 98))
    if scale <= 0:
        return np.zeros(cost.shape, dtype=np.uint8)
    return np.clip(cost * (255.0 / scale), 0, 255).astype(np.uint8)


def _feature_stack(channels, config):
    """Normalized features; weights express appearance/geometry importance."""
    lab = channels["lab"]
    return np.stack(
        (
            lab[..., 0] / 100.0 * config.color_weight,
            lab[..., 1] / 128.0 * config.color_weight,
            lab[..., 2] / 128.0 * config.color_weight,
            channels["elevation"] / config.elevation_scale_m
            * config.geometry_weight * 0.65,
            channels["slope_degrees"] / config.slope_scale_degrees
            * config.geometry_weight,
            channels["local_relief"] / config.relief_scale_m
            * config.geometry_weight * 0.8,
            channels["water"] * config.geometry_weight * 2.0,
            channels["valid_rgb"] * config.color_weight * 2.0,
        ),
        axis=-1,
    ).astype(np.float32)


def _enforce_connectivity(labels, minimum_size):
    """Split disconnected labels and absorb only genuinely tiny fragments."""
    connected = np.full(labels.shape, -1, dtype=np.int32)
    tiny_masks = []
    next_id = 0
    structure = ndimage.generate_binary_structure(2, 1)
    for old_id in range(int(labels.max()) + 1):
        components, count = cast(
            tuple[np.ndarray, int],
            ndimage.label(labels == old_id, structure=structure),
        )
        for component_id in range(1, count + 1):
            mask = components == component_id
            if int(mask.sum()) >= minimum_size:
                connected[mask] = next_id
                next_id += 1
            else:
                tiny_masks.append(mask)
    if next_id == 0:
        # Possible only for very small images/configurations.
        return np.zeros(labels.shape, dtype=np.int32)
    nearest = cast(
        np.ndarray,
        ndimage.distance_transform_edt(
            connected < 0, return_distances=False, return_indices=True
        ),
    )
    for mask in tiny_masks:
        connected[mask] = connected[tuple(axis[mask] for axis in nearest)]
    _, inverse = np.unique(connected, return_inverse=True)
    return inverse.reshape(labels.shape).astype(np.int32)


def _slic_labels(features, tile_size_m, config):
    """Small dependency-free SLIC implementation with physical seed spacing."""
    height, width, _ = features.shape
    spacing_x = max(3, int(round(config.target_segment_m * width / tile_size_m)))
    spacing_y = max(3, int(round(config.target_segment_m * height / tile_size_m)))
    xs = np.arange(spacing_x // 2, width, spacing_x, dtype=np.int32)
    ys = np.arange(spacing_y // 2, height, spacing_y, dtype=np.int32)
    if not xs.size:
        xs = np.asarray([width // 2], dtype=np.int32)
    if not ys.size:
        ys = np.asarray([height // 2], dtype=np.int32)
    centers_y, centers_x = np.meshgrid(ys, xs, indexing="ij")
    center_y = centers_y.ravel().astype(np.float32)
    center_x = centers_x.ravel().astype(np.float32)
    center_features = features[centers_y.ravel(), centers_x.ravel()].copy()
    labels = np.full((height, width), -1, dtype=np.int32)

    yy, xx = np.mgrid[:height, :width]
    for _ in range(max(1, config.iterations)):
        distance = np.full((height, width), np.inf, dtype=np.float32)
        labels.fill(-1)
        for center_id in range(center_y.size):
            y0 = max(0, int(center_y[center_id]) - spacing_y)
            y1 = min(height, int(center_y[center_id]) + spacing_y + 1)
            x0 = max(0, int(center_x[center_id]) - spacing_x)
            x1 = min(width, int(center_x[center_id]) + spacing_x + 1)
            feature_delta = (
                features[y0:y1, x0:x1] - center_features[center_id]
            )
            feature_distance = np.sum(feature_delta * feature_delta, axis=2)
            spatial_distance = (
                ((yy[y0:y1, x0:x1] - center_y[center_id]) / spacing_y) ** 2
                + ((xx[y0:y1, x0:x1] - center_x[center_id]) / spacing_x) ** 2
            )
            candidate = feature_distance + config.compactness ** 2 * spatial_distance
            better = candidate < distance[y0:y1, x0:x1]
            distance[y0:y1, x0:x1][better] = candidate[better]
            labels[y0:y1, x0:x1][better] = center_id

        for center_id in range(center_y.size):
            mask = labels == center_id
            if not mask.any():
                continue
            center_y[center_id] = float(yy[mask].mean())
            center_x[center_id] = float(xx[mask].mean())
            center_features[center_id] = features[mask].mean(axis=0)

    if np.any(labels < 0):
        raise RuntimeError("segmentation left pixels unassigned")
    minimum_size = max(2, spacing_x * spacing_y // 8)
    return _enforce_connectivity(labels, minimum_size)


def _region_statistics(labels, rgb, channels):
    regions = []
    for region_id in range(int(labels.max()) + 1):
        ys, xs = np.nonzero(labels == region_id)
        pixels = rgb[ys, xs].astype(np.float32)
        regions.append({
            "id": region_id,
            "pixel_count": int(xs.size),
            "centroid_x": float(xs.mean()),
            "centroid_y": float(ys.mean()),
            "bbox": [int(xs.min()), int(ys.min()), int(xs.max()) + 1,
                     int(ys.max()) + 1],
            "mean_rgb": [float(v) for v in pixels.mean(axis=0)],
            "std_rgb": [float(v) for v in pixels.std(axis=0)],
            "mean_lab": [
                float(v) for v in channels["lab"][ys, xs].mean(axis=0)
            ],
            "std_lab": [
                float(v) for v in channels["lab"][ys, xs].std(axis=0)
            ],
            "mean_elevation_m": float(channels["elevation"][ys, xs].mean()),
            "std_elevation_m": float(channels["elevation"][ys, xs].std()),
            "mean_slope_degrees": float(
                channels["slope_degrees"][ys, xs].mean()
            ),
            "std_slope_degrees": float(
                channels["slope_degrees"][ys, xs].std()
            ),
            "mean_local_relief_m": float(
                channels["local_relief"][ys, xs].mean()
            ),
            "std_local_relief_m": float(
                channels["local_relief"][ys, xs].std()
            ),
            "mean_southness": float(channels["southness"][ys, xs].mean()),
            "std_southness": float(channels["southness"][ys, xs].std()),
            "mean_eastness": float(channels["eastness"][ys, xs].mean()),
            "std_eastness": float(channels["eastness"][ys, xs].std()),
            "mean_insolation": float(channels["insolation"][ys, xs].mean()),
            "std_insolation": float(channels["insolation"][ys, xs].std()),
            "water_fraction": float(channels["water"][ys, xs].mean()),
            "valid_rgb_fraction": float(
                channels["valid_rgb"][ys, xs].mean()
            ),
        })
    return tuple(regions)


def segment_terrain_tile(
    rgb, heightmap, tile_size_m, config=None, *, water_mask=None
):
    """Return geometry-aware contiguous superpixels and region statistics."""
    config = config or SegmentationConfig()
    rgb, heightmap = _validate_inputs(rgb, heightmap, tile_size_m, config)
    channels = terrain_feature_channels(
        rgb, heightmap, tile_size_m, config, water_mask=water_mask
    )
    cost = _boundary_cost(channels, config)
    if config.image_blur_pixels > 0:
        cost = ndimage.gaussian_filter(
            cost.astype(np.float32), config.image_blur_pixels
        ).astype(np.uint8)
    labels = _slic_labels(_feature_stack(channels, config), tile_size_m, config)
    regions = _region_statistics(labels, rgb, channels)
    channels = {**channels, "boundary_cost": cost}
    return SegmentationResult(labels=labels, regions=regions, channels=channels)


def render_boundaries(rgb, labels, color=(255, 40, 220)):
    """Overlay region boundaries on RGB for tile-inspector/debug output."""
    rgb = np.asarray(rgb, dtype=np.uint8)
    labels = np.asarray(labels)
    if labels.shape != rgb.shape[:2]:
        raise ValueError("labels must match the RGB image dimensions")
    boundary = np.zeros(labels.shape, dtype=bool)
    boundary[1:, :] |= labels[1:, :] != labels[:-1, :]
    boundary[:, 1:] |= labels[:, 1:] != labels[:, :-1]
    boundary[:-1, :] |= boundary[1:, :]
    boundary[:, :-1] |= boundary[:, 1:]
    rendered = rgb.copy()
    rendered[boundary] = np.asarray(color, dtype=np.uint8)
    return rendered
