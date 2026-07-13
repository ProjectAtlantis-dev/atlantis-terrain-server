"""Terrain channels derived directly from a tile heightmap.

These channels are used by the tile inspector and are independent of any
external reference imagery or classifier training pipeline.
"""
import math

import numpy as np

from database import GRID_N


SUN_EL = 25 * math.pi / 180
SUN_SIN = math.sin(SUN_EL)
SUN_COS = math.cos(SUN_EL)
SUN_TAN = math.tan(SUN_EL)
SHADOW_MARCH_M = (8, 20, 50, 120, 300)


def _smoothstep(a, b, x):
  t = np.clip((x - a) / (b - a), 0.0, 1.0)
  return t * t * (3 - 2 * t)


def terrain_channels(hm, tile_size_m):
  """Return elev/slope/southness/sun arrays in DB row orientation."""
  spacing = tile_size_m / (GRID_N - 1)
  gy, gx = np.gradient(hm, spacing)
  slope = np.hypot(gx, gy)
  norm = np.sqrt(gx * gx + gy * gy + 1.0)
  southness = gy / norm
  insol = (gy * SUN_COS + SUN_SIN) / (norm * SUN_SIN)

  rows = np.arange(GRID_N, dtype=np.float32)
  horizon = np.zeros_like(hm)
  for distance_m in SHADOW_MARCH_M:
    sampled_row = np.clip(rows - distance_m / spacing, 0.0, GRID_N - 1)
    row0 = np.floor(sampled_row).astype(int)
    row1 = np.minimum(row0 + 1, GRID_N - 1)
    blend = (sampled_row - row0).astype(np.float32)[:, None]
    sampled_height = hm[row0, :] * (1 - blend) + hm[row1, :] * blend
    np.maximum(horizon, (sampled_height - hm - 1.0) / distance_m, out=horizon)
  shade = 1.0 - _smoothstep(SUN_TAN * 0.7, SUN_TAN * 1.3, horizon)

  return {
    "elev": hm.astype(np.float32),
    "slope": slope.astype(np.float32),
    "southness": southness.astype(np.float32),
    "sun": (insol * shade).astype(np.float32),
  }


def _gray(values, low, high):
  normalized = np.clip((values - low) / (high - low), 0, 1)
  return (np.stack([normalized, normalized, normalized], -1) * 255).astype(np.uint8)


def _diverging(values):
  normalized = np.clip((values + 1) / 2, 0, 1)
  red = np.where(normalized > 0.5, 1.0, 2 * normalized)
  blue = np.where(normalized < 0.5, 1.0, 2 * (1 - normalized))
  green = 1.0 - np.abs(2 * normalized - 1) * 0.85
  return (np.stack([red, green, blue], -1) * 255).astype(np.uint8)


def render_channel(channels, channel):
  """Render one terrain channel as an RGB uint8 image."""
  if channel == "southness":
    return _diverging(channels["southness"])
  if channel == "slope":
    return _gray(channels["slope"], 0.0, 1.0)
  if channel == "sun":
    return _gray(channels["sun"], 0.0, 1.3)
  elevation = channels["elev"]
  return _gray(
    elevation,
    float(np.nanmin(elevation)),
    float(np.nanmax(elevation)) + 1e-6,
  )
