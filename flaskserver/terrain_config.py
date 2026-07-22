"""Shared terrain runtime configuration constants."""

import os


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


# Optional local ComfyUI enhancement is never enabled implicitly.
ENHANCE_ENABLED = _env_bool("COMFY_ENHANCE_ENABLED", False)
ENHANCE_DEPTH = 12

# Maximum terrain tile depth and subdivision ceiling. Depth 12 is the default
# measured-quality ceiling. A future Atlantis upscaler may opt into deeper
# render tiles without silently changing the data used for procedural flora.
TERRAIN_MAX_DEPTH = max(0, min(20, _env_int("TERRAIN_MAX_DEPTH", 12)))
# Compatibility name used by the modular Flask server and traversal modules.
MAX_TILE_DEPTH = TERRAIN_MAX_DEPTH

# DEM and satellite field depth used to seed procedural vegetation and rocks.
# Keep this independent from the render ceiling: deeper visual tiles must not
# affect placement until their upscaling method is explicitly approved.
PROCGEN_SOURCE_DEPTH = max(
    0,
    min(TERRAIN_MAX_DEPTH, _env_int("PROCGEN_SOURCE_DEPTH", 12)),
)

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
