"""Shared terrain runtime configuration constants."""

# Maximum terrain tile depth and subdivision ceiling.
# Depth 12 ≈ 659 m tiles — Sentinel-2 z14 (~2.4 m/px) and ArcticDEM 10 m
# still have headroom.
MAX_TILE_DEPTH = 12

# Initial skeleton depth used on a brand-new DB at server startup.
# Keep this shallow so Flask becomes responsive quickly; deeper levels
# are created lazily by traversal as real data arrives.
BOOTSTRAP_SEED_DEPTH = 8
