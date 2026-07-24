"""Hierarchical coarse terrain classification — the classification ladder.

Each rung only refines what the rung above established, and every rung is a
small, inspectable step (dump with ``debug_dir`` to get ``step_NN_name.png``
per stage — no heuristic monolith).

Rung 0 — physics, DEM only. Slope, aspect (southness) and a horizon-marched
    sun channel are facts about the surface, available before any pixel of
    imagery is read. A north-facing slope under the low southern sun is
    shadow-prone terrain *immediately*, even though nothing downstream knows
    what to do with shadow yet.
Rung 1 — hierarchy priors. D10 establishes whether inferred lake water exists
    at all, D11 localizes that support, and D12 may only refine a candidate
    that survives both parents. Official water remains authoritative and
    bypasses this inferred-lake gate. D8 macro grain separately records the
    regional ridge/fjord strike for later structural refinement.
Rung 2 — joint color × surface proposals. The heightmap is a CO-PROPOSER,
    not just a veto: a DEM vegetation prior (gentle slope × south aspect ×
    lit × below the greenline) promotes ambiguous green color where the
    ground physically supports growth, and large connected flat sheets at
    constant elevation that read darker than their surroundings become
    LAKE — the DEM catching the lakes the official blue dataset is
    missing, in a bucket distinct from authority WATER. Luminance
    is exposure-normalized against a measured source-wide reference (never
    per-tile percentiles: those force a fixed fraction of every tile into
    DARK/WHITE whether or not any snow or dark ground exists — the failure
    that made the rock channel undisputable-live and got rocks removed
    from scatter).
Rung 3 — physics vetoes. Steep ground and north faces carry nothing living,
    whatever color the imagery has; imagery lies under cloud shadow, the
    surface does not.
Rung 4 — shadow resolution. Dark pixels the sun channel says are unlit are
    SHADOW, a first-class bucket — honestly unknown ground, never "dark
    soil where bushes grow". Dark pixels on lit ground stay DARK.
Rung 5 — authority overlay. Official water (Åbent Land) outranks everything.
Rung 6 — coastline prior. Every non-snow land pixel within the DEM-shaped
    6–15 m reach of WATER/LAKE becomes SAND or SHORE_ROCK. Their
    deterministic patchwork follows imagery brightness, bank slope, and
    world-anchored coherent variation, so no vegetation survives at the
    water edge and the result is not one uniform ring.

Orientation contract: heightmap inputs are south-first (database rows),
outputs are image-oriented (row 0 = north) to match classifier storage.
All thresholds are absolute against the calibrated source reference, so
labels are deterministic and consistent across tile borders.
"""
from __future__ import annotations

import math

import numpy as np
from PIL import Image

from terrain_upscale import _resize_bilinear

LADDER_SOURCE = "ladder_d12_v9"

# coarse_v4 label indices (classifier.storage.CLASS_SCHEMAS order).
# 0-4 match coarse_v1 exactly so every index-based consumer keeps working;
# SHADOW, LAKE, SAND and SHORE_ROCK are purely additive.
GREY, GREEN, DARK, WHITE, WATER, SHADOW, LAKE, SAND, SHORE_ROCK = range(9)
# Compatibility name for callers that only need "the sandy shoreline label".
BEACH = SAND

# --- Rung 0: physics ---------------------------------------------------------
# Sun model matches classifier/terrain_channels.py: low southern sun.
SUN_ELEVATION_RAD = 25 * math.pi / 180
SHADOW_MARCH_M = (8, 20, 50, 120, 300)

# --- Rung 2: color, exposure-normalized --------------------------------------
# MEASURED live luminance across 8 real served d12 tiles (524,288 px,
# 2026-07-22): median 94.5, p90 117.6, p95 124.0, p99 142.6, max 254.6.
# The tile's lit-land median is pulled toward this reference median before
# any threshold applies — that corrects per-tile exposure drift without
# forcing a fixed fraction of every tile into DARK/WHITE the way per-tile
# percentiles did. A perfectly uniform tile normalizes to ~94.5 and stays
# entirely GREY.
REFERENCE_LIT_MEDIAN = 94.5
EXPOSURE_GAIN_RANGE = (0.65, 1.6)
DARK_MAX_LUMINANCE = 58.0    # ≈ the old absolute DARK_MAX=55's ~3% hit rate
WHITE_MIN_LUMINANCE = 132.0  # above p95 of the source: bright bare rock
                             # (p90≈118) stays GREY; snow/bright sand fire
GREEN_MIN_EXCESS = 10.0

# --- Rung 3: terrain-physics vetoes -----------------------------------------
SLOPE_VEG_MAX = 0.35      # ~19 deg: no vegetation on steeper ground
SLOPE_ROCK_MIN = 0.70     # ~35 deg: bare rock regardless of imagery color
VEG_MIN_SOUTHNESS = 0.05  # north SLOPES never carry anything living...
ASPECT_SLOPE_MIN = 0.08   # ...but flat ground has no aspect; valleys stay green

# --- Rung 2: DEM vegetation prior --------------------------------------------
# The surface proposes alongside the imagery: growth wants gentle slopes,
# a south-ish aspect (flat valleys have no aspect and stay eligible), lit
# ground, and elevation below the greenline. Where the prior is strong,
# weak green color is still believed; where it is zero, no color reading
# can propose GREEN (the veto in rung 3 then never even sees it).
VEG_PRIOR_STRONG = 0.6    # DEM confident enough to promote ambiguous color
VEG_PRIOR_MIN = 0.15      # below this, GREEN cannot be proposed at all
GREEN_WEAK_EXCESS = 4.0   # ambiguous green, believed only on strong prior
GREENLINE_FADE_M = (450.0, 800.0)  # vegetation fades out over this band

# Lakes the official blue dataset is missing (only SOME lakes are in it):
# the DEM knows them anyway — a lake is a LARGE CONNECTED FLAT SHEET at
# near-constant elevation. Dark flat pixels seed the candidates; only
# components big enough and level enough (a sheet, not a bog patch) become
# LAKE after D10 and D11 both support their existence — a first-class bucket,
# never silently merged into official WATER (rendering/ingest decides what to
# do with it later). Everything else stays honest DARK ground.
LAKE_SLOPE_MAX = 0.03
LAKE_MIN_FRACTION = 0.01   # component ≥1% of the tile: a sheet, not a puddle
LAKE_MIN_AREA_M2 = 4300.0  # same physical floor when evaluating D10/D11
LAKE_ELEV_STD_MAX = 1.5    # meters: water is level
LAKE_EDGE_ELEV_TOLERANCE_M = 1.0
LAKE_EDGE_SLOPE_MAX = 0.30
LAKE_PRIOR_MIN_OVERLAP = 0.05

# Old coastline prior: foliage-like imagery right beside water is wet rock,
# algae or coarse-imagery bleed, not living cover. Flat banks use the full
# historic 15 m reach; steep banks taper toward 6 m so the mask does not
# read as a mechanically constant ring.
BEACH_BUFFER_M = 15.0
BEACH_MIN_BUFFER_M = 6.0
SHORE_NOISE_FINE_M = 36.0
SHORE_NOISE_COARSE_M = 108.0

# Ridge crests: a convex break (negated surface laplacian, positive at
# crests) on sloped ground. Long shadow streaks aligned with these crests
# are ridge-line shadows.
RIDGE_CURVATURE_MIN = 0.015   # 1/m, negated laplacian
RIDGE_SLOPE_MIN = 0.15

# --- Rung 4: shadow ----------------------------------------------------------
# sun channel = insolation * horizon shade, ~1.0 on flat lit ground.
SUN_SHADOW_MAX = 0.35       # geometry says this ground is unlit
# CALIBRATED on 14.6M mapped mountain-lake pixels (shadow_calibration.py,
# 2026-07-23): lakes are known-albedo flat surfaces, so their brightness
# variation is pure illumination. Shadowed lake median 19 vs lit lake 64
# (normalized), equal-error 48; scaled from lake albedo to the lit-land
# reference (94.5/64) → 72. The old hand-picked 85 over-claimed shadow on
# lit-but-dark ground. Sun-model AUC 0.74 — geometry alone is NOT enough,
# keep the darkness conjunct.
SHADOW_MAX_LUMINANCE = 72.0  # ...and the imagery agrees it reads dark


def _smoothstep(edge0, edge1, x):
    t = np.clip((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def _detect_lake_sheets(
    slope, elev, luminance, *, min_component_pixels=None,
):
    """Seed level lake interiors, then flood-fill their noisy shore edges.

    The DEM is cleanest over the middle of a lake. At the shoreline its
    samples blend water and land, so a strict low-slope component stops short
    and leaves a green ring that downstream scatter mistakes for vegetation.
    Grow only through connected DEM pixels that remain close to the seed's
    water level and moderately gentle. Imagery decides whether the initial
    flat sheet is plausibly water; it does not control where the flood stops.
    """
    from scipy import ndimage

    flat = slope < LAKE_SLOPE_MAX
    lake = np.zeros_like(flat)
    components, count = ndimage.label(flat)
    if min_component_pixels is None:
        min_component_pixels = LAKE_MIN_FRACTION * flat.size
    land_reference = float(np.median(luminance[~flat])) if np.any(
        ~flat
    ) else float(np.median(luminance))
    structure = np.ones((3, 3), dtype=bool)
    for index in range(1, count + 1):
        component = components == index
        if np.count_nonzero(component) < min_component_pixels:
            continue
        if float(np.std(elev[component])) > LAKE_ELEV_STD_MAX:
            continue
        if float(np.median(luminance[component])) >= land_reference:
            continue
        water_level = float(np.median(elev[component]))
        floodable = (
            (np.abs(elev - water_level) <= LAKE_EDGE_ELEV_TOLERANCE_M)
            & (slope < LAKE_EDGE_SLOPE_MAX)
        )
        lake |= ndimage.binary_propagation(
            component,
            mask=floodable | component,
            structure=structure,
        )
    return lake


def _gate_inferred_lakes(lake_candidates, lake_prior):
    """Keep only D12 lake components supported by the D10∩D11 prior.

    The prior is deliberately component-level rather than a final mask: coarse
    parents decide whether a water body may exist, while D12 retains authority
    over its precise shoreline.
    """
    from scipy import ndimage

    candidates = np.asarray(lake_candidates, dtype=bool)
    if lake_prior is None:
        return np.zeros_like(candidates)
    prior = np.asarray(lake_prior, dtype=bool)
    if prior.shape != candidates.shape:
        raise ValueError("lake prior must match classifier output")
    gated = np.zeros_like(candidates)
    components, count = ndimage.label(candidates)
    for index in range(1, count + 1):
        component = components == index
        pixels = int(np.count_nonzero(component))
        overlap = int(np.count_nonzero(component & prior))
        if overlap >= max(1, math.ceil(pixels * LAKE_PRIOR_MIN_OVERLAP)):
            gated |= component
    return gated


def lake_support_mask(rgb, heightmap, bbox, output_size=256):
    """Coarse visual/DEM evidence that an inferred lake may exist.

    Used on D10 and D11 before D12 classification. The minimum component size
    is expressed in square metres so the coarse parents do not accidentally
    require a lake to occupy the same *fraction* of their much larger tiles.
    """
    image = np.asarray(
        Image.fromarray(np.asarray(rgb, dtype=np.uint8), "RGB").resize(
            (output_size, output_size), Image.Resampling.BILINEAR
        ),
        dtype=np.float32,
    )
    tile_size_m = float(bbox[2]) - float(bbox[0])
    channels = physics_channels(heightmap, tile_size_m, output_size)
    luminance = (
        image[..., 0] * 0.2126 + image[..., 1] * 0.7152
        + image[..., 2] * 0.0722
    )
    pixel_size_m = tile_size_m / max(1, output_size - 1)
    minimum_pixels = max(
        4, math.ceil(LAKE_MIN_AREA_M2 / max(pixel_size_m ** 2, 1e-9)),
    )
    return _detect_lake_sheets(
        channels["slope"], channels["elev"], luminance,
        min_component_pixels=minimum_pixels,
    )


def _detect_beach(labels, waterish, slope, tile_size_m):
    """All exposed land in the DEM-shaped water reach becomes shoreline."""
    from scipy import ndimage

    waterish = np.asarray(waterish, dtype=bool)
    if not np.any(waterish):
        return np.zeros_like(waterish)
    pixel_size_m = float(tile_size_m) / max(1, waterish.shape[0] - 1)
    distance_m = ndimage.distance_transform_edt(~waterish) * pixel_size_m
    flatness = 1.0 - _smoothstep(0.08, 0.35, np.maximum(slope, 0.0))
    reach_m = BEACH_MIN_BUFFER_M + (
        BEACH_BUFFER_M - BEACH_MIN_BUFFER_M
    ) * flatness
    return (
        (labels != WATER)
        & (labels != LAKE)
        & (labels != WHITE)
        & (distance_m > 0.0)
        & (distance_m <= reach_m)
    )


def _world_value_noise(bbox, shape, period_m, seed):
    """Smooth deterministic value noise anchored in EPSG:3413 meters.

    Unlike per-tile RNG, the lattice coordinates come from the real world,
    so adjacent tiles sample the same variation at their shared edge.
    """
    height, width = shape
    x = np.linspace(float(bbox[0]), float(bbox[2]), width)
    # Class maps are image-oriented: row zero is the north/max-y edge.
    y = np.linspace(float(bbox[3]), float(bbox[1]), height)
    xx, yy = np.meshgrid(x / period_m, y / period_m)
    x0 = np.floor(xx)
    y0 = np.floor(yy)
    tx = _smoothstep(0.0, 1.0, xx - x0)
    ty = _smoothstep(0.0, 1.0, yy - y0)

    def lattice(ix, iy):
        phase = ix * 127.1 + iy * 311.7 + float(seed) * 74.7
        value = np.sin(phase) * 43758.5453123
        return (value - np.floor(value)) * 2.0 - 1.0

    south = lattice(x0, y0) * (1.0 - tx) + lattice(x0 + 1, y0) * tx
    north = lattice(x0, y0 + 1) * (1.0 - tx) + lattice(
        x0 + 1, y0 + 1,
    ) * tx
    return south * (1.0 - ty) + north * ty


def _split_shore_surfaces(beach, luminance, slope, bbox):
    """Split shoreline candidates into coherent sand and exposed-rock patches.

    Imagery and DEM supply the physical bias: bright/flat banks lean sand,
    darker/steeper banks lean rock. World-anchored two-scale value noise
    prevents either material becoming a continuous artificial ring while
    remaining identical on every run.
    """
    beach = np.asarray(beach, dtype=bool)
    if not np.any(beach):
        return np.zeros_like(beach), np.zeros_like(beach)
    fine = _world_value_noise(
        bbox, beach.shape, SHORE_NOISE_FINE_M, seed=0x53414E44,
    )
    coarse = _world_value_noise(
        bbox, beach.shape, SHORE_NOISE_COARSE_M, seed=0x524F434B,
    )
    # Fine patches own most of the choice so one dark/bright lake quadrant
    # cannot collapse into a single material; the coarse octave keeps
    # neighbouring runs related.
    variation = 0.80 * fine + 0.20 * coarse
    brightness = _smoothstep(70.0, 125.0, np.asarray(luminance))
    flatness = 1.0 - _smoothstep(0.04, 0.28, np.maximum(slope, 0.0))
    sand_score = (
        0.75 * variation
        + 0.17 * (brightness * 2.0 - 1.0)
        + 0.08 * (flatness * 2.0 - 1.0)
    )
    sand = beach & (sand_score >= -0.03)
    return sand, beach & ~sand


def physics_channels(heightmap, tile_size_m, output_size):
    """Rung 0: slope / southness / sun from a south-first surface.

    Returns image-oriented (row 0 = north) float32 arrays at output_size².
    The horizon march runs on the native heightmap grid so the shadow
    lengths stay physical, then everything is resampled once.
    """
    surface = np.asarray(heightmap, dtype=np.float64)
    grid = surface.shape[0]
    spacing = float(tile_size_m) / (grid - 1)
    gy, gx = np.gradient(surface, spacing)
    slope = np.hypot(gx, gy)
    norm = np.sqrt(gx * gx + gy * gy + 1.0)
    southness = gy / norm

    sun_sin = math.sin(SUN_ELEVATION_RAD)
    sun_cos = math.cos(SUN_ELEVATION_RAD)
    sun_tan = math.tan(SUN_ELEVATION_RAD)
    insolation = (gy * sun_cos + sun_sin) / (norm * sun_sin)

    # Horizon march southward (row 0 = south): ground is shaded when
    # terrain to its south rises above the sun line.
    rows = np.arange(grid, dtype=np.float64)
    horizon = np.zeros_like(surface)
    for distance_m in SHADOW_MARCH_M:
        sampled = np.clip(rows - distance_m / spacing, 0.0, grid - 1)
        row0 = np.floor(sampled).astype(int)
        row1 = np.minimum(row0 + 1, grid - 1)
        blend = (sampled - row0)[:, None]
        height = surface[row0, :] * (1 - blend) + surface[row1, :] * blend
        np.maximum(horizon, (height - surface - 1.0) / distance_m, out=horizon)
    shade = 1.0 - _smoothstep(sun_tan * 0.7, sun_tan * 1.3, horizon)
    sun = np.clip(insolation, 0.0, None) * shade

    # Plan curvature (surface laplacian): convex breaks are ridge crests.
    curvature = np.gradient(gx, spacing, axis=1) + np.gradient(
        gy, spacing, axis=0
    )

    def to_image(field):
        return _resize_bilinear(
            np.flipud(field), output_size, output_size
        ).astype(np.float32)

    return {
        "elev": to_image(surface),
        "slope": to_image(slope),
        "southness": to_image(southness),
        "sun": to_image(sun),
        "curvature": to_image(-curvature),  # positive = convex crest
    }


def macro_grain(heightmap, tile_size_m):
    """Rung 1: dominant structural orientation from a (d8) heightmap.

    Structure tensor of the height gradient: the principal eigenvector is
    the across-ridge direction, so the strike (ridge/fjord run) is its
    perpendicular. Returns compass strike in degrees [0, 180) — NE-SW reads
    as ~45 — plus anisotropy in [0, 1] (0 = isotropic, no meaningful grain).
    Grid frame is canonical EPSG:3413 (+x east, row index north): no
    convergence correction, matching every other view of the world.
    """
    surface = np.asarray(heightmap, dtype=np.float64)
    spacing = float(tile_size_m) / (surface.shape[0] - 1)
    gy, gx = np.gradient(surface, spacing)
    jxx = float(np.mean(gx * gx))
    jyy = float(np.mean(gy * gy))
    jxy = float(np.mean(gx * gy))
    trace = jxx + jyy
    if trace <= 1e-12:
        return {"strike_deg": None, "anisotropy": 0.0}
    diff = math.hypot(jxx - jyy, 2 * jxy)
    anisotropy = diff / trace
    # Principal (across-ridge) direction angle from +x east, CCW.
    across = 0.5 * math.atan2(2 * jxy, jxx - jyy)
    # Strike = perpendicular; convert math angle to compass (from north, CW).
    strike = (90.0 - math.degrees(across) + 90.0) % 180.0
    return {"strike_deg": strike, "anisotropy": anisotropy}


def _mask_orientation(mask):
    """Compass orientation [0,180) + elongation of a boolean mask, or None.

    Image-oriented input (row 0 = north). Long thin shadow masks aligned
    with the macro grain are ridge-line shadows — this is the measurement
    that links Rung 4 back to Rung 1.
    """
    ys, xs = np.nonzero(mask)
    if xs.size < 64:
        return None
    x = xs - xs.mean()
    y = ys.mean() - ys  # +y north
    cxx = float(np.mean(x * x))
    cyy = float(np.mean(y * y))
    cxy = float(np.mean(x * y))
    trace = cxx + cyy
    if trace <= 1e-9:
        return None
    diff = math.hypot(cxx - cyy, 2 * cxy)
    lam1 = (trace + diff) / 2
    lam2 = max((trace - diff) / 2, 1e-9)
    angle = 0.5 * math.atan2(2 * cxy, cxx - cyy)
    return {
        "orientation_deg": (90.0 - math.degrees(angle)) % 180.0,
        "elongation": math.sqrt(lam1 / lam2),
    }


def classify_ladder(
    rgb,
    heightmap,
    bbox,
    water_mask=None,
    output_size=256,
    grain=None,
    lake_prior=None,
    debug_dir=None,
):
    """Run the full ladder on one tile. Returns (labels, stats).

    rgb: HxWx3 uint8, image orientation (the tile's served texture).
    heightmap: south-first surface covering bbox.
    water_mask: south-first bool array on the heightmap grid, or None.
    grain: optional dict from macro_grain(d8 ancestor) — conditioning
    context recorded in stats (nothing labels from it yet).
    lake_prior: D10∩D11 support raster, image-oriented and matching
    output_size. D12 may refine only lake components with coarse support;
    omitting the prior prohibits inferred lakes. Official water is independent
    and remains authoritative.
    debug_dir: when set, every rung dumps a step_NN_*.png there.

    labels are coarse_v4 uint8; stats is a JSON-able dict of everything a
    verification gallery wants to show (fractions, thresholds, exposure
    gain, grain, shadow orientation).
    """
    image = np.asarray(
        Image.fromarray(np.asarray(rgb, dtype=np.uint8), "RGB").resize(
            (output_size, output_size), Image.Resampling.BILINEAR
        ),
        dtype=np.float32,
    )
    tile_size_m = float(bbox[2]) - float(bbox[0])
    channels = physics_channels(heightmap, tile_size_m, output_size)
    elev, slope, southness, sun = (
        channels["elev"], channels["slope"], channels["southness"],
        channels["sun"],
    )

    water = None
    if water_mask is not None:
        water = _resize_bilinear(
            np.flipud(np.asarray(water_mask, dtype=np.float64)),
            output_size,
            output_size,
        ) >= 0.5

    luminance = (
        image[..., 0] * 0.2126 + image[..., 1] * 0.7152 + image[..., 2] * 0.0722
    )

    # Lake sheets, DEM-first: large connected flat components at
    # near-constant elevation. The imagery only breaks ties — a sheet is a
    # lake when it reads darker than the surrounding lit land (a bright
    # flat gravel plain is not water). Runs BEFORE exposure normalization
    # because an unmapped lake dominating a tile would otherwise drag the
    # lit-land median down and poison the gain for the whole tile (seen
    # live on 12-1380-791: gain pinned at max, pale rock inflated to
    # WHITE).
    lake_candidates = _detect_lake_sheets(slope, elev, luminance)
    lake = _gate_inferred_lakes(lake_candidates, lake_prior)

    # Rung 2 exposure normalization: lit land only — shadow, authority
    # water and lake sheets would drag the median and mis-gain the tile.
    lit = sun > SUN_SHADOW_MAX
    lit_land = lit & ~lake
    if water is not None:
        lit_land &= ~water
    if np.any(lit_land):
        tile_median = float(np.median(luminance[lit_land]))
    else:
        tile_median = REFERENCE_LIT_MEDIAN  # fully unlit/water: no correction
    gain = REFERENCE_LIT_MEDIAN / max(tile_median, 1.0)
    gain = float(np.clip(gain, *EXPOSURE_GAIN_RANGE))
    lum = luminance * gain

    green_excess = image[..., 1] - 0.5 * (image[..., 0] + image[..., 2])
    # Yellow-green (dry/autumn tundra: R and G both elevated, B low) has a
    # much smaller green_excess than pure green despite reading as living
    # ground cover — gate on hue shape instead of excess magnitude alone.
    yellow_green = (
        (image[..., 1] >= image[..., 0] * 0.85)
        & (image[..., 1] > image[..., 2] * 1.08)
        & (image[..., 1] >= image[..., 2])
    )

    # Rung 2: joint color × surface proposals. The DEM vegetation prior —
    # gentle slope, south-ish aspect (flat valleys have no aspect and stay
    # eligible), lit, below the greenline — decides how much color evidence
    # GREEN needs. Strong prior believes weak color; zero prior believes
    # none.
    aspect_ok = np.where(
        slope < ASPECT_SLOPE_MIN,
        1.0,
        _smoothstep(VEG_MIN_SOUTHNESS - 0.05, 0.2, southness),
    )
    veg_prior = (
        (1.0 - _smoothstep(0.25, SLOPE_VEG_MAX, slope))
        * aspect_ok
        * _smoothstep(SUN_SHADOW_MAX, 0.6, sun)
        * (1.0 - _smoothstep(*GREENLINE_FADE_M, elev))
    )
    green_color_strong = (green_excess > GREEN_MIN_EXCESS) | yellow_green
    green_color_weak = green_excess > GREEN_WEAK_EXCESS
    green = (
        (green_color_strong & (veg_prior > VEG_PRIOR_MIN))
        | (green_color_weak & (veg_prior > VEG_PRIOR_STRONG))
    )
    labels = np.full((output_size, output_size), np.uint8(GREY))
    labels[lum <= DARK_MAX_LUMINANCE] = np.uint8(DARK)
    labels[green] = np.uint8(GREEN)
    labels[lum >= WHITE_MIN_LUMINANCE] = np.uint8(WHITE)
    proposals = labels.copy() if debug_dir else None

    # Ridge crests, pure DEM: convex break on sloped ground. Long shadow
    # streaks aligned with these (and with the d8 grain) are ridge-line
    # shadows — measured now, consumed by the grey→ridges refinement later.
    ridge = (
        (channels["curvature"] > RIDGE_CURVATURE_MIN)
        & (slope > RIDGE_SLOPE_MIN)
    )

    # Rung 3: physics vetoes outrank every color proposal.
    living_banned = (slope > SLOPE_VEG_MAX) | (
        (slope > ASPECT_SLOPE_MIN) & (southness < VEG_MIN_SOUTHNESS)
    )
    labels[(labels == GREEN) & living_banned] = np.uint8(GREY)
    labels[slope > SLOPE_ROCK_MIN] = np.uint8(GREY)
    vetoed = labels.copy() if debug_dir else None

    # Rung 4: shadow — geometry says unlit AND imagery reads dark. First-
    # class bucket: honestly unknown ground, never "soil where bushes grow".
    shadow = (
        ((labels == GREY) | (labels == DARK))
        & (sun < SUN_SHADOW_MAX)
        & (lum < SHADOW_MAX_LUMINANCE)
    )
    labels[shadow] = np.uint8(SHADOW)

    # DEM lake sheets outrank every color proposal (dark lake water often
    # reads green enough to propose GREEN — bushes on the lake), but stay
    # a DISTINCT bucket from official WATER: rendering/ingest decides what
    # a lake dropout becomes; the classifier only refuses to call it land.
    labels[lake] = np.uint8(LAKE)

    # Rung 5: official water outranks everything.
    if water is not None:
        labels[water] = np.uint8(WATER)

    # Rung 6: the old coastline prior at classifier resolution. Every exposed
    # land pixel in the variable DEM-shaped reach resolves to sand or rock,
    # so vegetation cannot survive directly against water. The split remains
    # imagery/slope/noise-driven rather than a single painted material ring.
    waterish = lake.copy()
    if water is not None:
        waterish |= water
    beach = _detect_beach(labels, waterish, slope, tile_size_m)
    sand, shore_rock = _split_shore_surfaces(beach, lum, slope, bbox)
    labels[sand] = np.uint8(SAND)
    labels[shore_rock] = np.uint8(SHORE_ROCK)

    total = labels.size
    shadow_shape = _mask_orientation(labels == SHADOW)
    ridge_shape = _mask_orientation(ridge)
    stats = {
        "exposure_gain": gain,
        "lit_median": tile_median,
        "fractions": {
            name: float(np.count_nonzero(labels == index)) / total
            for name, index in (
                ("grey", GREY), ("green", GREEN), ("dark", DARK),
                ("white", WHITE), ("water", WATER), ("shadow", SHADOW),
                ("lake", LAKE), ("sand", SAND),
                ("shore_rock", SHORE_ROCK),
            )
        },
        "veg_prior_mean": float(veg_prior.mean()),
        "ridge_fraction": float(np.count_nonzero(ridge)) / total,
        "lake_candidate_fraction": (
            float(np.count_nonzero(lake_candidates)) / total
        ),
        "lake_prior_applied": lake_prior is not None,
        "grain": grain,
        "shadow_shape": shadow_shape,
        "ridge_shape": ridge_shape,
    }

    def alignment(shape):
        if not (grain and shape and grain.get("strike_deg") is not None):
            return None
        delta = abs(shape["orientation_deg"] - grain["strike_deg"])
        return min(delta, 180.0 - delta)

    # Long dark streaks aligned with the macro grain are ridge shadows,
    # not ground cover — both alignments quantify that reading.
    stats["shadow_grain_alignment_deg"] = alignment(shadow_shape)
    stats["ridge_grain_alignment_deg"] = alignment(ridge_shape)

    if debug_dir:
        _dump_debug_steps(
            debug_dir, image, channels, lum, veg_prior, lake, ridge,
            proposals, vetoed, labels,
        )
    return labels, stats


def _dump_debug_steps(
    debug_dir, image, channels, lum, veg_prior, lake, ridge,
    proposals, vetoed, labels,
):
    """One inspectable image per rung: step_NN_name.png."""
    import os

    from classifier.storage import COARSE_V4_SCHEMA, colorize_class_map

    os.makedirs(debug_dir, exist_ok=True)

    def gray(values, low, high):
        scaled = np.clip((values - low) / (high - low), 0, 1)
        return (np.stack([scaled] * 3, -1) * 255).astype(np.uint8)

    def save(name, array):
        Image.fromarray(array, "RGB").save(
            os.path.join(debug_dir, f"{name}.png")
        )

    elev = channels["elev"]
    save("step_01_texture", image.astype(np.uint8))
    save("step_02_elev", gray(elev, float(elev.min()), float(elev.max()) + 1e-6))
    save("step_03_slope", gray(channels["slope"], 0.0, 1.0))
    save("step_04_southness", gray(channels["southness"], -1.0, 1.0))
    save("step_05_sun", gray(channels["sun"], 0.0, 1.3))
    save("step_06_luminance_normalized", gray(lum, 0.0, 255.0))
    save("step_07_veg_prior", gray(veg_prior, 0.0, 1.0))
    save("step_08_ridge_crests", gray(ridge.astype(np.float32), 0.0, 1.0))
    save("step_09_lake_sheets", gray(lake.astype(np.float32), 0.0, 1.0))
    save("step_10_proposals", colorize_class_map(proposals, COARSE_V4_SCHEMA))
    save("step_11_vetoed", colorize_class_map(vetoed, COARSE_V4_SCHEMA))
    save("step_12_final", colorize_class_map(labels, COARSE_V4_SCHEMA))
