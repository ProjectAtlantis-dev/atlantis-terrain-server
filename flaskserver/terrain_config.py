"""Shared terrain runtime configuration constants."""

# Maximum terrain tile depth and subdivision ceiling.
# Depth 12 ≈ 659 m tiles — Sentinel-2 z14 (~2.4 m/px) and ArcticDEM 10 m
# still have headroom.
MAX_TILE_DEPTH = 12

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
