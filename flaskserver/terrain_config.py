"""Shared terrain runtime configuration constants."""

import os


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}

# Master switch for SUPIR upscaling via ComfyUI. Keep the default off: the
# endpoint consumes expensive GPU work and must not become a public anonymous
# queue merely because COMFY_URL is configured. Local/deployment configuration
# opts in with COMFY_ENHANCE_ENABLED=1 after access control is in place.
ENHANCE_ENABLED = _env_bool("COMFY_ENHANCE_ENABLED", False)

# Tile depth processed by the optional ComfyUI enhancement workflow.
# Depth 12 ≈ 659 m tiles — Sentinel-2 z14 (~2.4 m/px) and ArcticDEM 10 m
# still have headroom.
ENHANCE_DEPTH = 12

# Terrain and imagery residency have a different ceiling from AI enhancement.
# At depth 13 a 256px tile is about 1.3 m/px, which resolves the 1.6 m SPOT
# source. Finer levels would only oversample that imagery (and the 10 m DEM).
TERRAIN_MAX_DEPTH = 13

# Initial skeleton depth used on a brand-new DB at server startup.
# Keep this shallow so Flask becomes responsive quickly; deeper levels
# are created lazily by traversal as real data arrives.
BOOTSTRAP_SEED_DEPTH = 8
