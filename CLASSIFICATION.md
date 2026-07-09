# Terrain Classification

## The goal

Depth 12 is the last level where "what goes where" matters. By d12 the coarse
class map — water, grey stuff, dark slopes & shadows, green stuff, white
stuff — tells the renderer everything it needs to know semantically. That map
is the **entire contract** between real-world data and the synthesized world.

Below depth 12 there is no fidelity requirement at all. Procedural generation
invents every detail — boulder placement, scree gradients, grass, shoreline
texture — from the d12 class map + DEM + a world-coordinate seed. The only
requirements down there are **gorgeous** and **deterministic** (same tile,
same pixels, every visit). Accuracy vs Google below d12 is irrelevant by
design.

Google satellite tiles are the labeling authority (sharper and truer-color
than our SPOT textures, and the authority on water — Sentinel/ArcticDEM
fjord heightmaps have defects from bottom reflections in clear water). Google
pixels are a guide only: we derive class maps and statistics from them, we
never ship them. Note the capture-season mismatch: our SPOT is summer, Google
is spring (more snow, less foliage).

## The zoom-gated ladder

Classification is hierarchical and zoom-dependent. Each stage only subdivides
its parent's buckets, and only where the imagery actually resolves the
evidence:

1. **Coarse (the d12 contract)** — five buckets:
   water | grey stuff | **dark slopes & shadows** | green stuff | white stuff.
   Dark is a first-class bucket, NOT disambiguated into water/rock by
   heuristics — that disambiguation is exactly what used to flip fjords to
   rock at Google exposure seams and paint glaciers as rock.
2. **When shadows resolve** (shadows always fall north in Greenland):
   grey → hard rock / scrabble (scree) / ridges;
   white → snow vs beach (white *without* shadows).
3. **Deep zoom (Google z17–18, its best data)**:
   green → grass / bushes / lichen.

## Rules that keep it consistent

1. **Children refine, never re-decide.** A deeper stage may split its
   parent's `grey` into hard/scrabble/ridge; it may never flip `green` to
   `grey`. Classes carry down through subdivision like ancestor-crop
   textures — no class flicker while flying in.
2. **Measure texture at a fixed physical scale.** Thresholds tuned at one
   m/px silently break at another (this bit us twice in one day). Resample to
   a reference m/px before applying texture rules.
3. **DEM conditioning is not optional.** Slope, aspect and a sun/shadow term
   are first-class inputs; north and south slopes are never interchangeable
   in Greenland.

## What's dead (July 2026)

- **The learned models** (`train_color.py`, `colorize.py`, the `gcls`
  conditioning, `?stage=colorized` serving). The color head imitated Google
  pixels and produced unstable garbage (unlearned water, exposure-seam
  blocks); the class head's 99.9% accuracy was fake — its label was also fed
  to it as an input channel. There is nothing to train: d12 classes come from
  the heuristic ladder.
- **SUPIR/ComfyUI enhance.** Never worked right.
- **The vegetation.js classifier-heuristic pipeline** (see LAAS_ASSETS.md
  status note).

## What stands

- `flaskserver/biomes.py` (`classify_field` / `refine_rock`) — the heuristic
  labeler, but it needs restructuring to the ladder above: today it has no
  dark/shadow bucket, splits green too early, and lacks ridge and beach.
- `flaskserver/google_ref.py` + the `google_refs` cache — Google refs warped
  pixel-aligned onto our EPSG:3413 tile bboxes.
- `pipeline.html` buckets stage — the label audit. If that card looks wrong
  on a tile, the contract is wrong there; flag it as a regression case.
- Instance statistics (`guide_assets.py`): densities, size distributions,
  Clark-Evans clumping, palettes measured from Google refs. Proc gen places
  instances itself, so it needs their *statistics*, never their positions.

## Regression tiles

Broken under the old scheme; the ladder must get these right at d12 scale:

- `12-1373-784` — coastal; fjord flipped to rock along a Google
  exposure-block seam.
- `13-2770-1562` — glacier; shadowed snow/ice classified as rock, painted
  near-black.

## Next

Restructure `biomes.py` into the ladder (coarse 5 buckets first), verify at
d12 on the regression tiles in pipeline.html, then prototype the seeded
per-class proc-gen infill and put it in the final pane.
