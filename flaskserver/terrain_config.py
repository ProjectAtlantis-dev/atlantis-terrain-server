"""Shared terrain runtime configuration constants."""

# Maximum terrain tile depth and subdivision ceiling.
# Depth 13 ≈ 330 m tiles. Past WMS_CONTRACT_DEPTH the provider imagery may
# be a plain blowup of the level above; fetched metatiles are inspected and
# fall back to the deterministic fractal upscaler when they carry no new
# detail (source "fractal_upscale").
# Upscaling is DISABLED for verification (2026-07-22): ceiling held at the
# WMS contract depth and all depth-13 rows purged from the DB. Restore to
# 13 to re-enable the fractal cooks.
MAX_TILE_DEPTH = 12

# Deepest level where provider imagery is trusted at face value.
# Depth 12 ≈ 659 m tiles — Sentinel-2 z14 (~2.4 m/px) and ArcticDEM 10 m
# still have headroom there.
WMS_CONTRACT_DEPTH = 12

# Initial skeleton depth used on a brand-new DB at server startup.
# Keep this shallow so Flask becomes responsive quickly; deeper levels
# are created lazily by traversal as real data arrives.
BOOTSTRAP_SEED_DEPTH = 8

# Asiaq Teknisk Grundkort settlements the server keeps downloaded and
# ingested (folder names from kortforsyning.asiaq.gl/files/). The default
# camera starts over Nuuk, so a fresh clone gets its buildings/roads with
# no manual steps. Add folders here to cover more settlements.
GRUNDKORT_SETTLEMENTS = ["0600NUK_Nuuk"]

# Åbent Land GL50 vector blocks (100 km GR96/UTM-24N ids) the server keeps
# downloaded for exact fjord coastline masks. Downloading needs the
# Dataforsyningen account login in .env; without it the server logs a loud
# startup error and coastline masks fall back to the rendered-WMS decoder.
GTK50_BLOCKS = ["71_-1", "71_-2"]
