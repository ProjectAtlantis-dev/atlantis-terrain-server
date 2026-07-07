# Greenland Upscaler

## The goal

This project already has good Greenland terrain data from Sentinel but not
upscaled enough to place vehicles and roads.

We are looking at both infinite diffusion (~/work/terrain-diffusion) and LAAS procedural generation (~/work/fable5-world-demo) as upscaler approaches, with LAAS assets as the final goal.


**LAAS procedurally generates the assets that make the terrain feel real** —
boulders, slabs, scree fields, shrubs (see LAAS_ASSETS.md). It's deterministic
proc-gen: nothing is stored per-instance, everything is synthesized
client-side from a location seed. To do its job it needs two things we don't
hand-author:

1. **What the ground is, everywhere** — a per-pixel field saying rock /
   grass / lichen / water / snow, so the generators know *where* to place
   *what* (scree on loose rock, shrubs on lush ground, nothing on bedrock).
2. **Truthful generator parameters** — how dense, how big, how clumped, what
   color — measured from real imagery instead of guessed.

Google satellite tiles are the measurement reference for both (sharper and
truer-color than our SPOT textures) but Google pixels are a guide only: we
extract numbers and train models on them, we never ship them. The Sentinel data
is clearly summer and Google was take in spring (more snpw, less visible foliage).

Everything below exists to feed those two needs.

## Classify each thing at its natural scale

The core lesson from the training experiments: one flat classification at one
depth fails, because every ground class has a natural scale where its
signature lives. A grass meadow is a hillside-scale fact; a bush is a 2 m
object that vanishes below 0.5 m/px. So the work splits into three tracks:

| Scale | Track | Feeds LAAS how |
|-------|-------|----------------|
| depth ≤ 11 (≥ 1.3 m/px) | **field classes** (water, snow, rock, lichen mat, grass) — learned model, SPOT + DEM in, class map out | placement field: which generator runs where |
| depth 12–13 (~0.3–0.6 m/px) | **rock refinement** (hard bedrock vs loose scree) — fixed-scale texture rule | slab/boulder generators vs talus generator |
| Google z17–18 (~0.26–0.5 m/px) | **instance statistics** (bushes, boulders) — `guide_assets.py` | generator parameters: density, size p25/p75, Clark-Evans clumping, palettes |

Bushes and boulders are deliberately *not* pixel classes: LAAS synthesizes
individual instances itself, so it needs their statistics, not their
positions. The instance track measures those from Google refs and publishes
them to `webserver/public/laas_guide.json`, which `vegetation.js` applies at
init.

## Rules that keep it consistent

1. **Children refine, never re-decide.** A depth-12 tile may split its
   parent's `rock` into hard/loose; it may never flip `grass` to `rock`.
   Classes carry down through subdivision like ancestor-crop textures — so
   there's no class flicker while flying in.
2. **Measure texture at a fixed physical scale.** Thresholds tuned at one
   m/px silently break at another (this bit us twice in one day). Resample to
   a 0.5 m/px reference first. Corollary: talus = granular at 2.5 m AND
   homogeneous at 12.5 m — single-scale texture cannot separate scree from
   fractured Greenland bedrock.
3. **Label each stage from imagery at that stage's own scale.** Depth-11
   pairs labeled from 1.3 m/px imagery lose bushes and blur the rock split —
   the labels, not the model, become the ceiling.
4. **DEM conditioning is not optional.** Slope, aspect (north/south are never
   interchangeable in Greenland) and a sun/shadow term are first-class inputs
   — worth ~+20 pts class accuracy at depth 14, still +4 pts at depth 11.
   The sun math mirrors `vegetation.js` so the client can recompute it.

## Where it stands (July 2026, Nuuk SE headlands)

- Field model PoC (`flaskserver/training_data.py` + `train_color.py`): tiny
  UNet, SPOT + DEM channels → color + class map. Depth 11 confirmed as the
  field scale; class-weighted CE fixed veg collapse (grass recall 0.00 →
  0.62); snow trains the color head only (its labels are capture-date noise).
- First instance measurements: boulders ~2–3 per 100 m² of rock, ø 1–2 m,
  R ≈ 1.1 (near-random); bushes R ≈ 0.6–0.7 (clumped); scree 5–17% of rock
  ground. Eyeball gallery: `sample/laas_guide/index.html`.

## Next

Restructure `biomes.py` into the n-class field labeler + fixed-scale rock
refinement, retrain the depth-11 field model, carry the field map down
through tile subdivision, and grow the rock asset set in `veg_assets.js`
from the measured stats. Google tiles are the final authority for water as
the Sentinel heighmaps in fjords often have defects due to refection of the bottoms
of unusually clear water.
