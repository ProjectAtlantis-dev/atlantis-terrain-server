"""Hierarchical ground classification on Google reference imagery.

Two stages, one per tile-depth band (see CLASSIFICATION.md):

  classify_field  depth <= 11   the FIELD classes — hillside-scale facts
                                (rock / lichen / grass / snow / water / semi),
                                pseudo-labels for train_color.py
  refine_rock     depth 12-13   splits inherited `rock` into hard bedrock vs
                                loose scree at a FIXED physical scale; never
                                touches non-rock pixels (children refine,
                                never re-decide)

Bushes are deliberately NOT a class at either stage: LAAS synthesizes bush
instances client-side, so the instance track (guide_assets.py) measures their
statistics instead. Strong green ground — meadow or thicket alike — is `grass`
("lush") in the field map, and the bush generator's density stats decide what
grows there.

Labels are heuristic pseudo-ground-truth — tune thresholds by eyeballing the
field.png overlays in the sample/training gallery, same loop as LAAS_ASSETS.md.
"""
from typing import cast

import numpy as np
from PIL import Image
from scipy import ndimage

# ---- field stage (depth <= 11) ---------------------------------------------
# index order matters — train_color checkpoints bake it in. `semi` (olive
# blue-depleted vegetation, see below) is APPENDED so the original five keep
# their indices; checkpoints trained before it have no logits for it.
FIELD_NAMES = ["rock", "lichen", "grass", "snow", "water", "semi"]

# ---- refined stage (depth 12-13): field map with rock split in place --------
# `boulder` is an instance marker, not ground: it flags detected object+shadow
# footprints so they're visible in overlays and countable by the instance
# track. The ground beneath stays whatever the field said around it.
REFINED_NAMES = ["rock_hard", "rock_loose", "lichen", "grass", "snow", "water",
                 "boulder", "semi"]

TINTS = {  # debug overlay colors (sRGB) — rock is violet, NOT gray: gray tint
  # over gray rock imagery is invisible at overlay alpha
  "rock": (150, 105, 210),
  "rock_hard": (150, 105, 210),
  "rock_loose": (205, 170, 90),
  "lichen": (215, 125, 45),
  "grass": (150, 225, 60),
  "semi": (70, 190, 140),   # teal-green: apart from grass AND lichen orange
  "snow": (255, 255, 255),
  "water": (40, 90, 255),
  "boulder": (235, 45, 45),
  # coarse stage buckets (grey/water reuse the rock/water colors)
  "grey": (150, 105, 210),
  "green": (150, 225, 60),
  "dark": (255, 140, 0),    # orange — must stay visible over near-black pixels
  "white": (255, 255, 255),
}

# ---- coarse stage (the d12 contract, see CLASSIFICATION.md) -----------------
# Five buckets. This map is the entire semantic contract between real imagery
# and the below-d12 procedural synthesis — everything finer is invented.
# Deliberately SIMPLE: ordered steps, each traceable (pass trace={} and every
# decision's mask is recorded; regression_cases.py bakes them to PNGs).
COARSE_NAMES = ["grey", "green", "dark", "white", "water"]

COARSE_DARK_LUM = 60         # below this = dark bucket (shadow / dark slope)
COARSE_WHITE_LUM = 190       # bright...
COARSE_WHITE_MAX_SAT = 30    # ...and colorless = white stuff
COARSE_GREEN_EG = 0.05       # excess green above this = green stuff


def classify_coarse(rgb, slope=None, elev=None, trace=None):
  """Five-bucket coarse class map (COARSE_NAMES order) from google RGB uint8.

  Steps, in order (each records its mask into `trace` when given):
    10_white           bright + colorless
    20_green           excess green
    30_dark            luminance floor — shadows and dark north slopes
    40_water_color     blue-tinted pixels (bright-blue or dark-blue rules)
    50_water_seed      water color on FLAT ground — confident water (sea,
                       lakes); water color on slopes alone is shadow-suspect
    55_water_flood     water = flood-fill from the seeds through 40's mask.
                       Water bleeding over fake DEM shoreline skirts stays
                       water (connected to the sea); isolated water-colored
                       patches on slopes have no seed -> reclassified dark
                       ("sloping lakes" are shadows, not water)
    60_seamount_water  fake DEM seamounts (above-sea blobs where google shows
                       no confident land) forced to water — shore-shadowed
                       ones are too black even for the color rules
    90_classes         final assembly (paint order: grey < green < dark <
                       white < water — google is the water authority)

  slope (rise/run) and elev (m) are optional aligned DEM channels; without
  them the color rules stand alone.
  """
  def _t(name, mask):
    if trace is not None:
      trace[name] = mask.copy()

  a = rgb.astype(np.float32)
  r, g, b = a[..., 0], a[..., 1], a[..., 2]
  lum = a.mean(-1)
  sat = a.max(-1) - a.min(-1)

  white = (lum >= COARSE_WHITE_LUM) & (sat < COARSE_WHITE_MAX_SAT)
  _t("10_white", white)

  eg = (2 * g - r - b) / 255
  green = (eg > COARSE_GREEN_EG) & ~white
  _t("20_green", green)

  dark = lum < COARSE_DARK_LUM
  _t("30_dark", dark)

  # water color: bright blue, or dark-but-still-blue (fjord water in shade)
  water = ((b > r + 12) & (b > g + 6)) | (dark & (b >= g - 4) & (b > r))
  _t("40_water_color", water)

  if slope is not None:
    seed = water & (slope < WATER_MAX_SLOPE)
    _t("50_water_seed", seed)
    # SciPy's return annotation includes non-boolean array variants even
    # though binary_propagation returns a boolean mask for boolean inputs.
    flooded = np.asarray(
      ndimage.binary_propagation(seed, mask=water),
      dtype=bool,
    )
    _t("55_water_flood", flooded)
    dark |= water & ~flooded
    water = flooded
    if elev is not None:
      # fake-seamount test: DEM blobs rising above sea level that google
      # shows essentially no confident land on are DEM artifacts over water —
      # force their ambiguous pixels to water. Confident land = neither
      # water-colored nor shadow-dark.
      labels, n = cast(
        tuple[np.ndarray, int],
        ndimage.label(elev >= WATER_SEA_LEVEL_M),
      )
      forced = np.zeros_like(water)
      if n:
        ids = np.arange(1, n + 1)
        conf_land = water | (lum >= COARSE_DARK_LUM)
        land_frac = ndimage.mean((conf_land & ~water).astype(np.float32),
                                 labels, ids)
        fake = np.zeros(n + 1, dtype=bool)
        fake[1:] = land_frac <= SEAMOUNT_MAX_LAND_FRAC
        forced = fake[labels] & ~conf_land
      _t("60_seamount_water", forced)
      water |= forced
      dark &= ~forced

  cls = np.full(rgb.shape[:2], COARSE_NAMES.index("grey"), dtype=np.uint8)
  cls[green] = COARSE_NAMES.index("green")
  cls[dark] = COARSE_NAMES.index("dark")
  cls[white] = COARSE_NAMES.index("white")
  cls[water] = COARSE_NAMES.index("water")
  _t("90_classes", cls)
  return cls


# color thresholds (google imagery — no SPOT olive cast). Nuuk google greens
# are DARK (strong-green median lum ~54), so no brightness gate.
EG_VEG = 0.05        # excess green above this = vegetated at all
EG_STRONG = 0.10     # decisively green (grass/lush) vs lichen mat
# most Nuuk-area vegetation is OLIVE, not green: on tile 14-5508-3138 the
# clearly-vegetated valley floors have median rgb (74,64,55) — green BELOW
# red, eg negative — so absolute excess-green never sees them. What separates
# olive veg from rock there is blue depletion: (g-b)/lum is +0.12..0.14 on
# veg, +0.01..0.02 on bare rock (dark or pale alike), negative in shadow.
# The decision is RELATIVE, not an absolute cutoff (0.08 then 0.11 tried:
# both sweep up mixed pixels / warm rock on some tiles and paint subtle
# texture flat) — a patch is `semi` when it is clearly greener than the grey
# it sits in: blue depletion above the local (water-excluded) neighborhood
# mean by the delta. The window must be larger than a vegetation patch so
# the patch can't dominate its own background.
GB_SEMI_DELTA = 0.06   # blue depletion above local background = semi
GB_BG_WINDOW_M = 40.0  # neighborhood the "surrounding grey" is measured over
# vegetation is a south-slope fact (north and south aspects are never
# interchangeable), and ALL cast shadows face north here — so a green reading
# on north-facing ground is shade tint, not ground cover. The DEM aspect mask
# comes FIRST, before any color rule: every vegetation tier (grass, lichen,
# semi) is masked out against north slopes and falls back to rock. Color from
# the imagery never overrides aspect. Small negative margin so flat ground
# (southness ~ 0, gradient noise) keeps its vegetation.
VEG_MIN_SOUTHNESS = -0.05
# water-colored pixels also fire on cast shadows — BOTH clauses: deep
# mountain shade lit only by skylight is dark BLUE (tile 12-1379-788: the
# north-flank shadow reads rgb ~(7,7,36), slope p50 1.0), so the blue rule
# needs the slope gate every bit as much as the dark rule. Water is FLAT:
# measured on the Nuuk fjord tile, true water sits at slope ~0 (87-100%
# under 0.20, the rest coastline DEM bleed) while shadow false-positives sit
# far above. The one place the DEM must not get authority over water is its
# fake-seamount artifacts — spiky noise over fjord/ocean surfaces (mounds
# reach ~18 m and slope 0.3+ on open water). The defining property of a
# fake seamount is that it NEVER TOUCHES LAND: it is a DEM blob rising off
# the sea surface, enclosed by sea level on all sides (a bounding polygon
# around it sits entirely at ~0 m). So the test runs on the DEM, not on the
# water-color bodies: label connected components of ground rising above the
# sea surface (WATER_SEA_LEVEL_M, just over the DEM's flat ~-0.5 m sea — a
# higher cutoff was tried and orphaned the mounds' steep SKIRTS outside
# every blob) — the labeling itself is the enclosure test — and a blob is
# fake when google (the water authority) shows essentially no land anywhere
# on it. Real terrain always fails that: a coastal cliff or a mountain
# flank belongs to a blob that runs on into sunlit land-colored ground, and
# even a sea-level-enclosed ISLAND shows its own rock. The DEM's steep veto
# stands ONLY on blobs that pass — sea-level ground outside every blob is
# by definition where color wins over the DEM. Body size was tried and
# never separated anything (a depth-14 tile is smaller than any fjord-scale
# cutoff, killing the rescue on open water, while a flank shadow at
# altitude IS fjord-sized). Lakes at altitude are flat, so they survive the
# slope gate without any rescue.
WATER_MAX_SLOPE = 0.20
WATER_SEA_LEVEL_M = 1.0      # DEM ground above this rises out of the sea
WATER_DARK_LUM = 55          # darker than this = shadow-ambiguous ground
# "touches land" means CONFIDENT land — pixels that are neither water-colored
# nor shadow-dark (WATER_DARK_LUM). Along a fjord's SOUTH shore the shore's
# cast shadow falls north onto the water (grid-south sun), and fake seamounts
# sitting in it are black like the shadow around them — sometimes so black
# the water color rules miss them too (b ~ r, no blue signature), which
# would paint them rock with the DEM backing it up. A shadowed blob shows no
# confident land, so it stays fake and is FORCED to water outright. The
# deliberate trade: a real island wholly inside a shore shadow is erased —
# always preferable, islands almost never happen inside fjords.
# The frac tolerance: sun glint / whitecap speckles on open water read
# bright (the snow rule), so a strict zero would declare real every mound
# with a few sparkle pixels; any sunlit coast or island carries far more
# confident land than this.
SEAMOUNT_MAX_LAND_FRAC = 0.05
# vegetation never touches water: fjord edges have a barren tidal band (Nuuk
# tides run ~4-5 m), so any vegetation reading within this distance of water
# — grass, lichen, semi alike — is a shoreline artifact (wet rock, algae,
# coarse-imagery bleed) and demotes to rock. Google labels won't show
# vegetation at the waterline; this bakes that prior into the pseudo-labels
# so the model holds the no-mans land even when the SPOT input shows green.
VEG_SHORE_BUFFER_M = 15.0
# bright low-sat ground near the waterline is white SAND (beach / outwash
# delta), not snow — snow doesn't survive at the high-tide line in the
# capture-season imagery. Wider than the veg buffer: sand flats run further
# inland than the tidal band. Demotes to rock (sand has no class yet).
SNOW_SHORE_BUFFER_M = 40.0

# rock refinement — all texture is measured at REF_MPP, never at the tile's
# native m/px (thresholds tuned at one scale silently break at another).
# Talus = granular at the fine scale AND homogeneous at the coarse scale;
# fractured Greenland bedrock is granular at BOTH (joint/block structure
# survives the coarse window), which is what a single scale cannot separate.
REF_MPP = 0.5
FINE_WINDOW_M = 2.5
COARSE_WINDOW_M = 12.5
# Tuned so loose lands in the measured scree share (5-17% of rock ground,
# LAAS_ASSETS.md instance track): fine>15 & coarse<20 gives ~13% over the Nuuk
# SE headlands set. The coarse window also sees hillside shading gradients, so
# it cannot be tight; final say is the eyeball gallery.
FINE_LOOSE_STD = 15.0    # local lum std above this = granular
COARSE_HARD_STD = 20.0   # std of fine-window means above this = structured rock
HARD_SLOPE = 0.85        # rise/run above this -> bedrock regardless of texture

# boulder instances — resolvable objects at REF_MPP, anchored on their CAST
# SHADOW: a boulder (bright white or dark grey alike) casts a discrete dark
# patch on its NORTH side (grid-south sun, same convention as vegetation.js /
# training_data.py); snow patches are bright but cast nothing. The shadow blob
# plus the object zone just south of it is masked out of the texture field so
# boulder-strewn ground doesn't read as scree — boulders belong to the
# instance track, never to pixel classes.
BG_WINDOW_M = 7.5           # local background estimate window
SHADOW_DARK_DELTA = 12      # lum below local background = shadow-dark
SHADOW_MIN_M2 = 0.5         # discrete cast-shadow blob size window
SHADOW_MAX_M2 = 40.0        # bigger dark areas = terrain shade / water, not a boulder
BOULDER_MAX_DIAM_M = 8.0    # shadow wider (E-W) than this = a RIDGE, not a
                            # line of boulders — ridges stay in the texture
                            # field (they're banding/bedrock structure)
OBJECT_CONTRAST = 22        # object just south must beat its shadow by this much
BOULDER_MIN_ZOOM = 18       # rock shadows only resolve at google z18 — below
                            # that the detector finds noise, so it must not run
BOULDER_MIN_DEPTH = 12      # boulders live in the refined band (depth 12-13,
                            # see module header) and finer — 14 was tried and
                            # silently killed the detector for the whole
                            # refined view; z18 imagery (BOULDER_MIN_ZOOM) is
                            # the real quality gate
# dense boulder cover is ITSELF the loose signal. The background fill above
# protects sparse erratics on scoured bedrock from flipping it to scree, but
# in a boulder FIELD it erases exactly the granularity that says talus — the
# ground between boulders then measures smooth and lands rock_hard, so the
# densest boulder zones read as the hardest ground. Where boulder+shadow
# cover in the window exceeds the fraction, the rock is talus regardless of
# what the filled texture field says.
BOULDER_FIELD_WINDOW_M = 15.0
BOULDER_FIELD_FRAC = 0.10


def _local_std(lum, size):
  mean = ndimage.uniform_filter(lum, size)
  sq = ndimage.uniform_filter(lum * lum, size)
  return np.sqrt(np.maximum(0.0, sq - mean * mean)), mean


def _odd_px(window_m, mpp):
  return max(3, int(round(window_m / mpp)) | 1)


def classify_field(rgb, southness=None, slope=None, mpp=None, elev=None):
  """Per-pixel field class map (FIELD_NAMES order) from google RGB uint8.

  Color rules — the field classes are what survives any m/px, so this
  stage is deliberately scale-free. Google is the authority on water (fjord
  DEM artifacts must not label as land, see CLASSIFICATION.md).

  southness / slope / elev: optional float (H, W) DEM channels aligned with
  rgb (image-oriented), southness in -1..1, slope in rise/run, elev in
  meters. When given, ALL vegetation tiers (grass, lichen, semi) are confined
  to ground at VEG_MIN_SOUTHNESS or sunnier — north slopes are masked out
  before any color rule — and ALL water-colored pixels are confined to flat ground
  (< WATER_MAX_SLOPE) so cast shadows — dim blue-grey and deep skylight-blue
  alike — don't read as water. elev drives the fake-seamount rescue
  (WATER_SEA_LEVEL_M): above-sea-level DEM blobs showing no confident land
  are artifacts — they can't veto water and are forced to water outright,
  even where shore shadow blacks them out past the color rules; without
  elev the slope gate applies unconditionally. mpp
  (meters/px) scales the shoreline no-mans land where all vegetation demotes
  to rock (VEG_SHORE_BUFFER_M) and waterline "snow" is read as white sand
  (SNOW_SHORE_BUFFER_M). None means "trust the caller" and the color rules
  stand alone.
  """
  a = rgb.astype(np.float32)
  r, g, b = a[..., 0], a[..., 1], a[..., 2]
  lum = a.mean(-1)
  sat = a.max(-1) - a.min(-1)
  eg = (2 * g - r - b) / 255

  snow = (lum > 190) & (sat < 30)
  water_blue = (b > r + 12) & (b > g + 6)
  water_dark = (lum < WATER_DARK_LUM) & (b >= g - 4) & (b > r)
  water = water_blue | water_dark
  if slope is not None:
    steep = water & (slope >= WATER_MAX_SLOPE)
    if elev is not None:
      # fake-seamount rescue (see WATER_SEA_LEVEL_M): the DEM's steep veto
      # stands only on ground that rises out of the sea AND shows confident
      # land. Labeling the above-sea mask IS the enclosure test (every blob
      # is ringed by sea level or the tile edge by construction); sea-level
      # ground outside every blob never vetoes — at sea level color wins
      # over the DEM. Fake blobs are forced to water: in shore shadow their
      # pixels can be too black for the color rules, and rock labels there
      # would be fake islands (see SEAMOUNT_MAX_LAND_FRAC). Only the blob's
      # AMBIGUOUS pixels are forced, never confident land — a shoreline
      # blob can mix a sliver of true sunlit rock into a long run of dark
      # water (DEM/imagery misregistration) and fail the frac test, and the
      # rock must keep its color authority (a wholesale force was tried and
      # erased a sunlit rocky shore).
      labels, n = cast(
        tuple[np.ndarray, int],
        ndimage.label(elev >= WATER_SEA_LEVEL_M),
      )
      real = np.zeros(n + 1, dtype=bool)
      if n:
        ids = np.arange(1, n + 1)
        conf_land = ~water & (lum >= WATER_DARK_LUM)
        land_frac = ndimage.mean(conf_land.astype(np.float32), labels, ids)
        real[1:] = land_frac > SEAMOUNT_MAX_LAND_FRAC
        water |= (labels > 0) & ~real[labels] & ~conf_land
      steep &= real[labels]
    water &= ~steep
  # aspect mask FIRST (see VEG_MIN_SOUTHNESS): north-facing ground grows
  # nothing, whatever color the imagery shows there — shadows all face north
  # and their green/olive cast must not read as ground cover
  south_ok = True if southness is None else southness >= VEG_MIN_SOUTHNESS
  veg = (eg > EG_VEG) & ~snow & ~water & south_ok
  strong = (eg > EG_STRONG) & veg
  # olive vegetation that excess-green cannot see (see GB_SEMI_DELTA):
  # clearly greener than the surrounding grey, not an absolute cutoff.
  # Background = water-excluded neighborhood mean of blue depletion; water
  # (gb strongly negative) would drag shoreline backgrounds down and make
  # plain shore rock read "greener than surround".
  # smoothed lightly first: the delta is a PATCH-vs-surround decision, and
  # raw per-pixel sensor noise in g-b is the same order as the delta
  gb = ndimage.gaussian_filter((g - b) / np.maximum(lum, 1), 1.5)
  win = _odd_px(GB_BG_WINDOW_M, mpp) if mpp is not None else (
    max(9, (min(gb.shape) // 8) | 1))
  land = (~water).astype(np.float32)
  gb_bg = ndimage.uniform_filter(gb * land, win) / np.maximum(
    ndimage.uniform_filter(land, win), 1e-6)
  semi = (gb - gb_bg > GB_SEMI_DELTA) & ~snow & ~water & south_ok
  if mpp is not None and water.any():
    # no-mans land (see VEG_SHORE_BUFFER_M / SNOW_SHORE_BUFFER_M): the tidal
    # band is barren — all vegetation tiers demote to rock, and waterline
    # "snow" is white sand, also rock
    dist_m = ndimage.distance_transform_edt(~water) * mpp
    inland = dist_m > VEG_SHORE_BUFFER_M
    veg &= inland
    strong &= inland
    semi &= inland
    snow &= dist_m > SNOW_SHORE_BUFFER_M

  cls = np.zeros(rgb.shape[:2], dtype=np.uint8)      # rock
  cls[semi] = FIELD_NAMES.index("semi")
  cls[veg] = FIELD_NAMES.index("lichen")
  cls[strong] = FIELD_NAMES.index("grass")
  cls[snow] = FIELD_NAMES.index("snow")
  cls[water] = FIELD_NAMES.index("water")
  return cls


def detect_boulders(lum_ref):
  """Boulder mask at REF_MPP from cast shadows (image-oriented, row 0 = north).

  Returns (mask, paint, n_boulders, bg): `mask` = shadow blobs + rock bodies,
  the pixels to exclude from texture measurement; `paint` = the rock bodies,
  what overlays should color; n_boulders counts distinct shadow blobs for the
  instance track; bg is the local-median background (reused as the fill
  value).

  The SHADOW is the near-certain signal; rock brightness is not (dark grey
  rocks, pale bedrock). So the rock body is derived from shadow geometry
  alone: rocks are roughly round, the body sits tangent to the shadow's south
  edge, and its footprint is a disk with diameter = the shadow's east-west
  width. Snow patches are rejected for free — they cast nothing.
  """
  bg = ndimage.median_filter(lum_ref, size=_odd_px(BG_WINDOW_M, REF_MPP))
  dark = lum_ref < bg - SHADOW_DARK_DELTA
  labels, n = cast(tuple[np.ndarray, int], ndimage.label(dark))
  if not n:
    return np.zeros_like(dark), np.zeros_like(dark), 0, bg
  px_area = REF_MPP * REF_MPP
  ids = np.arange(1, n + 1)
  sizes = ndimage.sum_labels(np.ones_like(labels), labels, ids)
  keep = (sizes * px_area >= SHADOW_MIN_M2) & (sizes * px_area <= SHADOW_MAX_M2)
  # shadow E-W width is the caster's width: wider than any boulder = ridge
  slices = ndimage.find_objects(labels)
  widths = np.array([(s[1].stop - s[1].start) * REF_MPP for s in slices])
  keep &= widths <= BOULDER_MAX_DIAM_M

  # the shadow must have its OBJECT just south of it: mean lum in the 1-2 px
  # band south of the blob must beat the blob's own mean by OBJECT_CONTRAST —
  # this is what separates a cast shadow from plain dark ground mottling
  blob_mean = ndimage.mean(lum_ref, labels, ids)
  band_sum = np.zeros(n)
  band_cnt = np.zeros(n)
  for s in (1, 2):
    lab_n = np.zeros_like(labels)
    lab_n[s:] = labels[:-s]          # label of the blob s px north of here
    band = (lab_n > 0) & ~dark       # south neighbor px, outside any dark blob
    if band.any():
      band_sum += ndimage.sum_labels(lum_ref, lab_n * band, ids)
      band_cnt += ndimage.sum_labels(np.ones_like(lab_n), lab_n * band, ids)
  band_mean = np.divide(band_sum, band_cnt, out=np.zeros(n), where=band_cnt > 0)
  keep &= (band_cnt > 0) & (band_mean - blob_mean > OBJECT_CONTRAST)

  shadow = np.isin(labels, ids[keep])

  # rock body from shadow geometry: a disk tangent to the shadow's south edge
  # (row index grows southward), diameter = the shadow's east-west width
  paint = np.zeros_like(shadow)
  hh, ww = shadow.shape
  for lab in ids[keep]:
    sl = slices[lab - 1]
    sub = labels[sl] == lab
    cols = np.where(sub.any(axis=0))[0]
    rad = max(1.0, (cols[-1] - cols[0] + 1) / 2.0)
    cx = sl[1].start + (cols[0] + cols[-1]) / 2.0
    cy = sl[0].stop - 1 + rad
    r0, r1 = int(max(0, cy - rad)), int(min(hh, cy + rad + 2))
    c0, c1 = int(max(0, cx - rad)), int(min(ww, cx + rad + 2))
    if r0 >= r1 or c0 >= c1:
      continue
    yy, xx = np.ogrid[r0:r1, c0:c1]
    paint[r0:r1, c0:c1] |= (yy - cy) ** 2 + (xx - cx) ** 2 <= rad ** 2
  return shadow | paint, paint, int(keep.sum()), bg


def refine_rock(rgb, mpp, field, slope=None, google_zoom=None, tile_depth=None):
  """Refine a field map's `rock` pixels into hard bedrock vs loose scree.

  rgb: uint8 (H, W, 3) imagery at mpp meters/px; field: uint8 (H, W) map in
  FIELD_NAMES order (aligned with rgb); slope: optional float (H, W) rise/run;
  google_zoom / tile_depth: gates for boulder detection — it needs z18+
  imagery (shadows don't resolve below that) AND a depth >= 14 tile
  (boulders are a close-up fact); None for either means "trust the caller"
  for that gate.
  Returns a uint8 (H, W) map in REFINED_NAMES order. Only rock pixels are
  re-decided; every other class carries through untouched.

  Texture is measured on a copy resampled to REF_MPP so the thresholds mean
  the same thing at every tile depth. Loose = granular in the 2.5 m window
  AND homogeneous across the 12.5 m window; steep ground is always bedrock.
  """
  h, w = field.shape
  lum = rgb.astype(np.float32).mean(-1)
  ref_w = max(3, int(round(w * mpp / REF_MPP)))
  ref_h = max(3, int(round(h * mpp / REF_MPP)))
  lum_ref = np.array(Image.fromarray(lum, mode="F")
                     .resize((ref_w, ref_h), Image.Resampling.BILINEAR))

  # boulders (and their cast shadows) are instances, not texture: fill them
  # with local background so boulder-strewn ground doesn't measure granular
  if ((google_zoom is None or google_zoom >= BOULDER_MIN_ZOOM)
      and (tile_depth is None or tile_depth >= BOULDER_MIN_DEPTH)):
    boulders, paint, _, bg = detect_boulders(lum_ref)
    lum_ref = np.where(boulders, bg, lum_ref)
  else:
    boulders = paint = np.zeros(lum_ref.shape, dtype=bool)

  fine_std, fine_mean = _local_std(lum_ref, _odd_px(FINE_WINDOW_M, REF_MPP))
  coarse_std, _ = _local_std(fine_mean, _odd_px(COARSE_WINDOW_M, REF_MPP))
  loose_ref = (fine_std > FINE_LOOSE_STD) & (coarse_std < COARSE_HARD_STD)
  if boulders.any():
    # boulder-field override (see BOULDER_FIELD_FRAC): the fill above hides
    # talus granularity from the texture measure, so density restores it
    dens = ndimage.uniform_filter(boulders.astype(np.float32),
                                  _odd_px(BOULDER_FIELD_WINDOW_M, REF_MPP))
    loose_ref |= dens > BOULDER_FIELD_FRAC
  loose = np.array(Image.fromarray(loose_ref.astype(np.uint8) * 255, mode="L")
                   .resize((w, h), Image.Resampling.NEAREST)) > 127
  if slope is not None:
    loose &= slope < HARD_SLOPE

  # field -> refined index shift: rock defaults to hard, others move up one
  shift = np.array([REFINED_NAMES.index("rock_hard" if n == "rock" else n)
                    for n in FIELD_NAMES], dtype=np.uint8)
  cls = shift[field]
  cls[(field == FIELD_NAMES.index("rock")) & loose] = REFINED_NAMES.index("rock_loose")
  # paint detected boulders last so they're visible in overlays — the rock
  # bodies only, not their shadows, and they sit ON the ground, whatever
  # class it is (not water: a dark patch next to a bright shoreline pixel is
  # not a boulder shadow)
  boulder_px = np.array(Image.fromarray(paint.astype(np.uint8) * 255, mode="L")
                        .resize((w, h), Image.Resampling.NEAREST)) > 127
  cls[boulder_px & (cls != REFINED_NAMES.index("water"))] = REFINED_NAMES.index("boulder")
  return cls


# rock banding — glacially scoured ridge/joint structure. Boulder clusters and
# outcrops sit on roughly straight parallel bands that read from the air, not
# close up: an aerial-scale fact, measured coarse (depth 11-13) like the field
# classes. Structure tensor at a fixed physical scale gives per-point band
# ORIENTATION and COHERENCE (0 = isotropic, 1 = strongly banded) — instance-
# track stats for LAAS to place boulder/outcrop clusters along, never a class.
# Working scale: bands live at 30-100 m wavelength — at 1 m/px the tensor
# drowns in fine texture clutter (7% coherent on a visibly banded tile);
# 4 m/px + 25 m window sees the banding itself (58% coherent, same tile).
# Banding resolves from google z16 — fetch at z16, no finer needed.
BAND_MPP = 4.0            # working resolution for the tensor
BAND_TENSOR_M = 25.0      # gaussian window the tensor is averaged over
BAND_MIN_COH = 0.25       # below this the ground is isotropic — no band
BAND_ZOOM = 16            # google zoom the banding is measured at
BAND_MAX_DEPTH = 11       # banding is an aerial-scale fact measured ONCE, at
                          # this depth — every deeper tile crops its quadrant
                          # out of the ancestor's band field, never remeasures.
                          # This is what makes band count monotone under zoom:
                          # N formations at depth 11 can only shrink to the
                          # subset crossing a deeper tile, never grow — a
                          # deeper tensor pass would imagine bands from noise
                          # (tiles smaller than a few 30-100 m wavelengths)
# joint sets are PARALLEL families, not a swirling flow field: snap local
# orientations to the tile's dominant modes (up to two — Nuuk gneiss often
# carries two joint sets) and drop everything off-mode
BAND_SNAP_DEG = 16        # max deviation from a mode to count as that band
BAND_MODE2_MIN = 0.35     # secondary mode must carry this share of the primary
BAND_MIN_EXTENT_M = 100   # a formation must span at least one full band
                          # wavelength; shorter coherent specks are texture
                          # noise (measured: real formations 130-530 m,
                          # specks < 80 m — this is what keeps the band
                          # count in the single digits per tile)


def band_structure(rgb, mpp):
  """Band orientation + coherence from imagery via the structure tensor.

  Returns (theta, coh) float arrays on a BAND_MPP grid (image-oriented):
  theta in [0, pi) is the direction ALONG the bands (perpendicular to the
  luminance gradient's dominant axis), coh in [0, 1] is anisotropy strength.

  Ridge cast-shadows are part of the banding signal, so terrain is not
  masked — do NOT background-fill boulders here (tried: it halved coherence
  on a visibly banded tile). WATER is masked: the land/water luminance edge
  is one long coherent gradient along the coast, strong enough to force the
  dominant mode to follow the shoreline instead of the geology. Sun-artifact
  sanity check is downstream instead: a dominant orientation hugging N-S
  (sun-aligned) is suspect, the measured ~150 deg strike on the Nuuk tiles
  is not.
  """
  lum = rgb.astype(np.float32).mean(-1)
  h, w = lum.shape
  bw = max(9, int(round(w * mpp / BAND_MPP)))
  bh = max(9, int(round(h * mpp / BAND_MPP)))
  lum_b = np.array(Image.fromarray(lum, mode="F")
                   .resize((bw, bh), Image.Resampling.BILINEAR))
  lum_b = ndimage.gaussian_filter(lum_b, 1.0)
  gy, gx = np.gradient(lum_b)
  # water mask at band scale (same color rule as classify_field), dilated to
  # cover the gradient + blur support of the shoreline edge
  rgb_b = np.array(Image.fromarray(rgb).resize((bw, bh),
                                               Image.Resampling.BILINEAR)
                   ).astype(np.float32)
  rb, gb, bb = rgb_b[..., 0], rgb_b[..., 1], rgb_b[..., 2]
  lb = rgb_b.mean(-1)
  water = (((bb > rb + 12) & (bb > gb + 6))
           | ((lb < 55) & (bb >= gb - 4) & (bb > rb)))
  water = np.asarray(ndimage.binary_dilation(water, iterations=3), dtype=bool)
  land = (~water).astype(np.float32)
  gx *= land
  gy *= land
  sig = BAND_TENSOR_M / BAND_MPP
  # normalized masked smoothing: plain smoothing would dilute near-shore
  # land tensors with the masked zeros and crush their coherence
  norm = np.maximum(ndimage.gaussian_filter(land, sig), 1e-6)
  jxx = ndimage.gaussian_filter(gx * gx, sig) / norm
  jxy = ndimage.gaussian_filter(gx * gy, sig) / norm
  jyy = ndimage.gaussian_filter(gy * gy, sig) / norm
  # dominant gradient axis; bands run perpendicular to it
  theta_grad = 0.5 * np.arctan2(2 * jxy, jxx - jyy)
  theta = (theta_grad + np.pi / 2) % np.pi
  tr = jxx + jyy
  det_rt = np.sqrt(np.maximum(0.0, (jxx - jyy) ** 2 + 4 * jxy ** 2))
  coh = np.where(tr > 1e-6, det_rt / (tr + 1e-6), 0.0)
  coh = np.where(water, 0.0, coh)  # water never draws, never enters stats

  # snap to the dominant orientation modes: coherence-weighted circular
  # histogram over 2*theta, primary peak + optional secondary; off-mode
  # pixels get coherence 0 so they never draw and never enter guide stats
  nbins = 36
  sel = coh > BAND_MIN_COH
  if not sel.any():
    return theta.astype(np.float32), np.zeros_like(coh, dtype=np.float32)
  hist, _ = np.histogram((2 * theta[sel]) % (2 * np.pi), bins=nbins,
                         range=(0, 2 * np.pi), weights=coh[sel])
  k = np.array([0.25, 0.5, 1.0, 0.5, 0.25])
  hist = np.convolve(np.r_[hist[-2:], hist, hist[:2]], k, "same")[2:-2]
  modes = [np.pi * np.argmax(hist) / nbins]  # back to theta in [0, pi)
  masked = hist.copy()
  i0 = np.argmax(hist)
  for d in range(-3, 4):
    masked[(i0 + d) % nbins] = 0
  if masked.max() >= BAND_MODE2_MIN * hist[i0]:
    modes.append(np.pi * np.argmax(masked) / nbins)
  dev = np.stack([np.abs((theta - m + np.pi / 2) % np.pi - np.pi / 2) for m in modes])
  nearest = np.argmin(dev, axis=0)
  theta = np.choose(nearest, np.array(modes, dtype=np.float32)[:, None, None])
  coh = np.where(np.min(dev, axis=0) <= np.radians(BAND_SNAP_DEG), coh, 0.0)

  # extent gate: a formation must span at least a band wavelength
  # SciPy's overload also permits returning only the label array when an
  # output buffer is supplied; no buffer is supplied here, so this is always
  # the (labels, feature_count) form.
  lbl, n = cast(
    tuple[np.ndarray, int],
    ndimage.label(coh > BAND_MIN_COH),
  )
  min_cells = int(BAND_MIN_EXTENT_M / BAND_MPP)
  for i, sl in enumerate(ndimage.find_objects(lbl)):
    if max(sl[0].stop - sl[0].start, sl[1].stop - sl[1].start) < min_cells:
      coh[sl][lbl[sl] == i + 1] = 0.0
  return theta.astype(np.float32), coh.astype(np.float32)


def band_overlay(rgb, theta, coh, step_m=20.0, seg_m=70.0):
  """Dimmed imagery + oriented segments where coherence clears BAND_MIN_COH.

  Segment direction follows the band, hue encodes orientation (parallel bands
  share a color), opacity encodes coherence — for eyeballing whether measured
  banding matches what the eye sees from the air.
  """
  from PIL import ImageDraw
  h, w = rgb.shape[:2]
  base = Image.fromarray((rgb * 0.75).astype(np.uint8)).convert("RGBA")
  layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
  draw = ImageDraw.Draw(layer)
  bh, bw = theta.shape
  sx, sy = w / bw, h / bh
  step = max(2, int(round(step_m / BAND_MPP)))
  seg = seg_m / BAND_MPP * sx / 2
  for by in range(step // 2, bh, step):
    for bx in range(step // 2, bw, step):
      c = float(coh[by, bx])
      if c < BAND_MIN_COH:
        continue
      t = float(theta[by, bx])
      # hue from orientation: 0..pi -> 0..360 on the wheel, doubled so theta
      # and theta+pi (same band) share a color
      hue = Image.new("HSV", (1, 1), (int(t / np.pi * 255) % 256, 230, 255))
      r, g, b = cast(tuple[int, int, int], hue.convert("RGB").getpixel((0, 0)))
      a = int(60 + 195 * min(1.0, (c - BAND_MIN_COH) / (1 - BAND_MIN_COH)))
      cx, cy = bx * sx, by * sy
      # theta is measured in image coords (y = row, grows southward), so the
      # canvas dy takes +sin — the -sin "map orientation" form mirrored every
      # segment vertically, drawing real NE-SW formations as NW-SE noise
      dx, dy = np.cos(t) * seg, np.sin(t) * seg
      draw.line([(cx - dx, cy - dy), (cx + dx, cy + dy)], fill=(r, g, b, a), width=2)
  return np.array(Image.alpha_composite(base, layer).convert("RGB"))


def class_overlay(rgb, cls, names=FIELD_NAMES, alpha=0.55):
  """Dimmed google + class tints, for eyeballing label quality."""
  tint = np.zeros_like(rgb)
  for i, name in enumerate(names):
    tint[cls == i] = TINTS[name]
  return (rgb * (1 - alpha) + tint * alpha).astype(np.uint8)
