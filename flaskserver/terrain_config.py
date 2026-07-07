"""Shared terrain runtime configuration constants."""

# Master switch for SUPIR upscaling via ComfyUI. When False, the server
# skips the startup ComfyUI recovery check and rejects /enhance requests.
# Flip back to True when a ComfyUI instance is reachable at COMFY_URL.
ENHANCE_ENABLED = False

# Maximum tile depth for enhancement / subdivision ceiling.
# Depth 12 ≈ 659 m tiles — Sentinel-2 z14 (~2.4 m/px) and ArcticDEM 10 m
# still have headroom.
ENHANCE_DEPTH = 12

# Initial skeleton depth used on a brand-new DB at server startup.
# Keep this shallow so Flask becomes responsive quickly; deeper levels
# are created lazily by traversal as real data arrives.
BOOTSTRAP_SEED_DEPTH = 8
