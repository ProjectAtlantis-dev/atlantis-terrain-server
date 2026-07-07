"""Hierarchical ground classification on Google reference imagery.

Two stages, one per tile-depth band (see CLASSIFICATION.md):

  classify_field  depth <= 11   the FIELD classes — hillside-scale facts
                                (rock / lichen / grass / snow / water),
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
import numpy as np
from PIL import Image
from scipy import ndimage

# ---- field stage (depth <= 11) ---------------------------------------------
# index order matters — train_color checkpoints bake it in
FIELD_NAMES = ["rock", "lichen", "grass", "snow", "water"]

# ---- refined stage (depth 12-13): field map with rock split in place --------
# `boulder` is an instance marker, not ground: it flags detected object+shadow
# footprints so they're visible in overlays and countable by the instance
# track. The ground beneath stays whatever the field said around it.
REFINED_NAMES = ["rock_hard", "rock_loose", "lichen", "grass", "snow", "water", "boulder"]

TINTS = {  # debug overlay colors (sRGB) — rock is violet, NOT gray: gray tint
  # over gray rock imagery is invisible at overlay alpha
  "rock": (150, 105, 210),
  "rock_hard": (150, 105, 210),
  "rock_loose": (205, 170, 90),
  "lichen": (215, 125, 45),
  "grass": (150, 225, 60),
  "snow": (255, 255, 255),
  "water": (40, 90, 255),
  "boulder": (235, 45, 45),
}

# color thresholds (google imagery — no SPOT olive cast). Nuuk google greens
# are DARK (strong-green median lum ~54), so no brightness gate.
EG_VEG = 0.05        # excess green above this = vegetated at all
EG_STRONG = 0.10     # decisively green (grass/lush) vs lichen mat

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
OBJECT_CONTRAST = 22        # object just south must beat its shadow by this much
BOULDER_MIN_ZOOM = 18       # rock shadows only resolve at google z18 — below
                            # that the detector finds noise, so it must not run


def _local_std(lum, size):
  mean = ndimage.uniform_filter(lum, size)
  sq = ndimage.uniform_filter(lum * lum, size)
  return np.sqrt(np.maximum(0.0, sq - mean * mean)), mean


def _odd_px(window_m, mpp):
  return max(3, int(round(window_m / mpp)) | 1)


def classify_field(rgb):
  """Per-pixel field class map (FIELD_NAMES order) from google RGB uint8.

  Pure color rules — the field classes are what survives any m/px, so this
  stage is deliberately scale-free. Google is the authority on water (fjord
  DEM artifacts must not label as land, see CLASSIFICATION.md).
  """
  a = rgb.astype(np.float32)
  r, g, b = a[..., 0], a[..., 1], a[..., 2]
  lum = a.mean(-1)
  sat = a.max(-1) - a.min(-1)
  eg = (2 * g - r - b) / 255

  snow = (lum > 190) & (sat < 30)
  water = ((b > r + 12) & (b > g + 6)) | ((lum < 55) & (b >= g - 4) & (b > r))
  veg = (eg > EG_VEG) & ~snow & ~water
  strong = (eg > EG_STRONG) & veg

  cls = np.zeros(rgb.shape[:2], dtype=np.uint8)      # rock
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
  labels, n = ndimage.label(dark)
  if not n:
    return np.zeros_like(dark), np.zeros_like(dark), 0, bg
  px_area = REF_MPP * REF_MPP
  ids = np.arange(1, n + 1)
  sizes = ndimage.sum_labels(np.ones_like(labels), labels, ids)
  keep = (sizes * px_area >= SHADOW_MIN_M2) & (sizes * px_area <= SHADOW_MAX_M2)

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
  slices = ndimage.find_objects(labels)
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


def refine_rock(rgb, mpp, field, slope=None, google_zoom=None):
  """Refine a field map's `rock` pixels into hard bedrock vs loose scree.

  rgb: uint8 (H, W, 3) imagery at mpp meters/px; field: uint8 (H, W) map in
  FIELD_NAMES order (aligned with rgb); slope: optional float (H, W) rise/run;
  google_zoom: the imagery's native google zoom — boulder detection needs
  z18+ (shadows don't resolve below that) and is skipped otherwise; None
  means "trust the caller", the detector runs.
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
  if google_zoom is None or google_zoom >= BOULDER_MIN_ZOOM:
    boulders, paint, _, bg = detect_boulders(lum_ref)
    lum_ref = np.where(boulders, bg, lum_ref)
  else:
    paint = np.zeros(lum_ref.shape, dtype=bool)

  fine_std, fine_mean = _local_std(lum_ref, _odd_px(FINE_WINDOW_M, REF_MPP))
  coarse_std, _ = _local_std(fine_mean, _odd_px(COARSE_WINDOW_M, REF_MPP))
  loose_ref = (fine_std > FINE_LOOSE_STD) & (coarse_std < COARSE_HARD_STD)
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
# joint sets are PARALLEL families, not a swirling flow field: snap local
# orientations to the tile's dominant modes (up to two — Nuuk gneiss often
# carries two joint sets) and drop everything off-mode
BAND_SNAP_DEG = 16        # max deviation from a mode to count as that band
BAND_MODE2_MIN = 0.35     # secondary mode must carry this share of the primary


def band_structure(rgb, mpp):
  """Band orientation + coherence from imagery via the structure tensor.

  Returns (theta, coh) float arrays on a BAND_MPP grid (image-oriented):
  theta in [0, pi) is the direction ALONG the bands (perpendicular to the
  luminance gradient's dominant axis), coh in [0, 1] is anisotropy strength.

  Ridge cast-shadows are part of the banding signal, so nothing is masked —
  do NOT background-fill boulders here (tried: it halved coherence on a
  visibly banded tile). Sun-artifact sanity check is downstream instead: a
  dominant orientation hugging N-S (sun-aligned) is suspect, the measured
  ~150 deg strike on the Nuuk tiles is not.
  """
  lum = rgb.astype(np.float32).mean(-1)
  h, w = lum.shape
  bw = max(9, int(round(w * mpp / BAND_MPP)))
  bh = max(9, int(round(h * mpp / BAND_MPP)))
  lum_b = np.array(Image.fromarray(lum, mode="F")
                   .resize((bw, bh), Image.Resampling.BILINEAR))
  lum_b = ndimage.gaussian_filter(lum_b, 1.0)
  gy, gx = np.gradient(lum_b)
  sig = BAND_TENSOR_M / BAND_MPP
  jxx = ndimage.gaussian_filter(gx * gx, sig)
  jxy = ndimage.gaussian_filter(gx * gy, sig)
  jyy = ndimage.gaussian_filter(gy * gy, sig)
  # dominant gradient axis; bands run perpendicular to it
  theta_grad = 0.5 * np.arctan2(2 * jxy, jxx - jyy)
  theta = (theta_grad + np.pi / 2) % np.pi
  tr = jxx + jyy
  det_rt = np.sqrt(np.maximum(0.0, (jxx - jyy) ** 2 + 4 * jxy ** 2))
  coh = np.where(tr > 1e-6, det_rt / (tr + 1e-6), 0.0)

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
      r, g, b = hue.convert("RGB").getpixel((0, 0))
      a = int(60 + 195 * min(1.0, (c - BAND_MIN_COH) / (1 - BAND_MIN_COH)))
      cx, cy = bx * sx, by * sy
      dx, dy = np.cos(t) * seg, -np.sin(t) * seg  # image y grows southward
      draw.line([(cx - dx, cy - dy), (cx + dx, cy + dy)], fill=(r, g, b, a), width=2)
  return np.array(Image.alpha_composite(base, layer).convert("RGB"))


def class_overlay(rgb, cls, names=FIELD_NAMES, alpha=0.55):
  """Dimmed google + class tints, for eyeballing label quality."""
  tint = np.zeros_like(rgb)
  for i, name in enumerate(names):
    tint[cls == i] = TINTS[name]
  return (rgb * (1 - alpha) + tint * alpha).astype(np.uint8)
