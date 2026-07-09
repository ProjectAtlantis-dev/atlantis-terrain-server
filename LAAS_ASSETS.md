# LAAS Asset Guide Workflow

> **Status (July 2026): the graduation path into `vegetation.js` is retired**
> — the classifier-heuristic vegetation PoC is dead. What survives is the
> measurement loop (steps 1–3): grounding proc-gen parameters (densities,
> sizes, clumping, palettes) in real imagery is still exactly how the new
> below-d12 procedural synthesis stage gets its numbers (see
> CLASSIFICATION.md). Read step 4 and the asset inventory as historical.

Ground the procedural vegetation/rock assets (`webserver/vegetation.js`, LAAS
builders) in real imagery instead of guessed constants. Google satellite tiles
are the measurement reference — sharper than our SPOT textures and free of the
olive cast. **Google pixels are a guide only: we extract numbers (palettes,
densities, sizes), never ship the imagery. `sample/` is gitignored.**

## The loop

1. **Scout** — fly the map (M), right-click a tile → *Compare vs Google*, or
   open `http://localhost:5173/compare.html?tile=<id>` directly. Arrow keys
   step neighbors, `[`/`]` change depth, hold Space to blink for alignment.
   Note tile ids with representative ground (heath slope, drainage, scree...).

2. **Extract** — analyze those tiles (zoom 17/18 = whatever looked sharp):

       cd flaskserver
       venv/bin/python guide_assets.py 14-5511-3145 14-5542-3157 --zoom 17

   Per tile this classifies the Google reference (rock/heath/lush/snow/water),
   k-means a palette per class, and detects discrete bush instances
   (connected lush blobs ≤ 8 m across) to measure density per 100 m²,
   diameter distribution, nearest-neighbor spacing and Clark-Evans clumping R
   (R < 1 = clumped, ≈ 1 = random).

3. **Eyeball** — open `sample/laas_guide/index.html`. Each tile shows our
   texture vs Google vs class overlay vs detected bushes, plus swatches and
   stats. Re-run step 2 with different tiles/zoom until the detections look
   truthful. Deep shadow can misread as water (dark blue) — judge by eye.

4. **Graduate** — automatic. Every `guide_assets.py` run also publishes the
   aggregate manifest to `webserver/public/laas_guide.json` (derived numbers
   only, committable). `vegetation.js` fetches it at init and applies:
   - bush density per m² of lush ground → shrub-cone share of the plant gate
     (expected shrubs per cell = density × cell area × lushness),
   - diameter p25/p75 → shrub instance scale range,
   - Clark-Evans R → clump-field parent-cell occupancy (`CLUMP_PROB`),
   - heath / lush palette top swatches → plant tint anchors (replaces the
     orange debug tint).
   Builds hold until the fetch settles, so scatter stays deterministic per
   manifest. Delete `laas_guide.json` to fall back to the hand-tuned PoC
   defaults. To reject a tile's influence, delete its `sample/laas_guide/<id>/`
   dir and re-run `guide_assets.py` with no args (rebuilds gallery + manifest).

## Asset inventory

Prototypes live in `webserver/veg_assets.js` (deterministic fixed-seed
geometry, baked vertex-color shading, one InstancedMesh per kind per tile).
Greenland is mostly rock, so the set is rock-first:

| Kind | What | Placement driver |
|------|------|-----------------|
| `boulder` | faceted glacial erratic, heavy-tailed sizes to ~3 m | moderate rocky ground |
| `slab` | tilted fractured bedrock plate | rocky ground, rarer |
| `scree` | talus patch (14 clasts, one instance) | steep pale slopes |
| `stone` | small cobble (original PoC rock) | everywhere rocky |
| `shrub`/`tussock` | plant stand-ins — simple until rocks look right | lush/heath ground |

## Tools

| Tool | What it does |
|------|--------------|
| `webserver/public/compare.html` | Browser side-by-side viewer, ours vs Google, keyboard nav |
| `GET /api/google/<tile_id>.jpg?res=&z=&refresh=1` | Google ref warped to the tile's exact EPSG:3413 bbox (cached in `google_refs` table) |
| `flaskserver/google_ref.py` (CLI) | Batch side-by-side PNGs, e.g. harvest into `sample/google_textures/` |
| `flaskserver/guide_assets.py` (CLI) | Palette + scatter-stat extraction, gallery, manifest |

Run `guide_assets.py` with no tile ids to just rebuild the gallery/manifest
after deleting a tile dir you don't want in the aggregate.
