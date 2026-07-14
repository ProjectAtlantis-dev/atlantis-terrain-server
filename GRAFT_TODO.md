# Greenland WebGPU — vegetation graft: progress & TODO

Living checklist. Check items off as they land. (Companion: `PROCGEN_SCATTER_DESIGN.md`
for the physics/networking architecture.)

## Goal
Real Greenland map (ArcticDEM tiles) in the **WebGPU client**, with the **backup's
full vegetation** (30 species, dense grass carpet, trample, seasons, TSL-quality
materials) placed by the **satellite classifier** (`/api/fields`).

## Locked decisions
- **BOTH clients do procedural generation.** Nobody loses procgen. The difference is
  only WHICH veg library each uses:
  - **WebGL** (`main.terrain.js`, `localhost:5173/`) uses the OLD stripped library in the
    `webserver/procgen/` folder (GLSL, ~3 species). **LEAVE THIS FOLDER ALONE** — it works,
    keep it as a resource. ("procgen" = that folder's name, NOT the concept.)
  - **WebGPU** (`main.webgpu.terrain.js`, `localhost:5173/webgpu.html`) uses the **FULL
    backup vegetation system** in `webserver/laas/` — 30 species, TSL materials, dense
    grass, trample. This is the fuller procedural generation. **This graft is the whole point.**
- The backup (`greenland-laas`) is **NOT nanite** — it's standard Three.js `WebGPURenderer`
  + TSL. That's the target renderer family.
- Terrain map = **real ArcticDEM tiles** (unchanged). Vegetation/materials render on top.
- Placement driven by **`/api/fields`** (classifier: veg/rock/water/moisture). Water
  hard-excluded. Greenland is **treeless**.
- The blend/materials are **visual only** — gameplay (physics/collision/targeting) uses
  geometry + fields, never the material. Safe for drone/aircraft warfare.

## Done
- [x] `/api/fields/<tile>` endpoint — classifier per tile (veg/rock/snow/water/slope/
      southness/sun/altitude/moisture), packed + cached. flaskserver `:5180`.
- [x] `fields.py` field generator (texture veg/rock/water + DEM), validated on real tiles.
- [x] Scatter enabled; wired `/api/fields` into `buildTileScatter` (both clients):
      `water>0.45` hard-exclude, `veg` gates plants, `rock` gates stones.
- [x] Removed trees/log/stump from scatter (Greenland treeless).
- [x] WebGL client restored to working GLSL materials (left alone).
- [x] Started graft: copied backup `src/{core,gpu,render,world,vegetation}` → `webserver/laas/`.

## Graft TODO — WebGPU client

### Tier 1 — VegLibrary (the 30 species + TSL materials) ← IN PROGRESS
- [x] Copy backup veg subsystem → `webserver/laas/` (69 files: core/gpu/render/world/vegetation/sky).
- [x] `webserver/laas/` transpiles through vite (VegLibrary, VegMaterials, BarkSynth,
      NoiseTSL, GreenlandFlora all 200; no vite errors). three@0.182 compatible so far.
- [x] Adapter `laas-scatter-adapter.js`: `buildVegLibrary(renderer, seed)` async pools →
      `scatter.ts` AssetLibrary. Maps VegClass → categories (Greenland shrubs/flowers/rocks;
      skips trees/logs). Uses mid-LOD ring + hero leaf crown, node materials via `make()`.
- [x] Wired `main.webgpu.terrain.js` `scatterLibrary()` → async backup build (memoized);
      `attachTileScatter` awaits it. Transpiles clean.
- [ ] **MOMENT OF TRUTH**: reload `webgpu.html`, check client log — does the backup
      `buildVegLibrary` complete under the terrain-server WebGPU renderer? (Risk: BarkSynth /
      RockSynth / captureFoliageAtlas / captureImpostor GPU ops may need fixes like the
      readback one.) Then verify species render non-black.
- [ ] VegLibrary world deps: only `AUTUMN` (season constant) at runtime — low risk.
- [ ] Wire `GreenlandFlora` composition (which species where, abundance) into scatter.

- [x] **PERF: camera-following near-field scatter** (`updateNearFieldScatter` in
      main.webgpu). Tiles store scatter input on build; per-frame we build plants only
      inside NEAR_BUILD (850 m) and dispose past NEAR_DROP (1300 m). Fixes the "rendering
      plants for miles → insane FPS drop". ~1–2 tiles of plants around the camera, like the backup.
- [ ] If FPS still stalls: the one-time `buildVegLibrary` build (bark/rock synth + foliage
      atlases + **impostors for 30 species**) is heavy — impostors aren't even used by the
      scatter (we use r1/r2 rings), so trimming the impostor bake is the next perf lever.

### Density fix (2026-07-13) — scatter was 100× too sparse
- [x] Root cause of "only rocks, sooo far apart": scatter CATEGORIES density was ~1/1500 per
      m² cap 100 → ~1 plant / 66 m. Shrubs WERE built (library = 80 kinds incl. BushHazel/
      CushionCampion) but placed so sparsely only the bigger rocks read. Cranked to shrub 1/12
      cap 12000, cobble 1/120 cap 4000, etc. Tightened near ring 650/950 m to offset FPS.
- NOTE: scale is NOT distorted (EXAG=1.0, scale 0.8–1.25× real mesh). "Wrong scale" was the
  sparse-boulder illusion — should read correct once shrubs fill in.

### Tier 2 — GroundRing (dense grass carpet + trample) ← the "comes alive" part
> KEYSTONE FINDING (2026-07-13): the lush density is the grass CARPET (`GroundRing`, ≥800k
> blades), NOT scattered shrubs. GroundRing samples a **single GPU-resident `Heightfield`**:
> it calls `hf.sampleHeight`, `hf.normalTex`, `hf.fieldsTex`, `hf.biomeTex`,
> `hf.sampleWaterYNearest` — all TSL nodes over ONE continuous clipmap. The terrain-server is
> a QUADTREE of separate CPU-heightmap tiles. **That mismatch is why the carpet hasn't grafted.**
> `canopyTex` → empty (treeless), `gi` → null (patchGI early-returns) — both trivial.
> ⇒ Build a **`Heightfield` adapter** (GPU clipmap around camera, filled from tile DEMs +
>   `/api/fields` → fieldsTex). It's THE keystone: unlocks GroundRing + Forests + TerrainMaterial.
- [x] **Keystone: `Heightfield.fromExternal(renderer, seed, {res, sampleDEM, ...})`** (added to
      laas/world/Heightfield.ts). Seeds the height buffer from real ArcticDEM via a CPU sampler,
      reuses `rebuildDerivedMaps` for normals/heightTex, fills MINIMAL fields/biome/dry-water so
      GroundRing lays grass everywhere non-water. Reuses the real class's sampling verbatim.
- [x] **Mount module `laas-terrain-patch.js`** — `GreenlandPatch`: builds the Heightfield from
      loaded terrainRoot tile hm, instantiates `GroundRing(hf, emptyCanopy, seed, null)`, mounts
      it as a ROTATION ISLAND (vegRoot, +90° about X: y-up→z-up) under terrainRoot, drives
      GroundRing via a PROXY CAMERA in the veg frame. Wired into main.webgpu render loop.
      > FRAME MATH (island = rot +90° X ⇒ GR(x,y,z)→terrainRoot(x,-z,y)):
      >   sampleDEM(wx,wz) reads terrain at terrainRoot-local (wx, **-wz**) [north flip].
      >   proxy.projectionMatrix = cam.projectionMatrix;
      >   proxy.matrixWorldInverse = cam.matrixWorldInverse · vegRoot.matrixWorld;
      >   proxy.position = inverse(vegRoot.matrixWorld) · camWorldPos.
      >   Materials use real ECEF cameraPosition/positionWorld → correct unchanged.
- [ ] **RUNTIME TEST (next):** reload webgpu.html near spawn; client log should show
      `patch.hf` progress then `patch.ready {tiles,res}`; grass carpet should appear on the
      ground near the camera. Risks: proxy-cam frustum/camU wrong → grass culled/misplaced;
      grass unlit/dark (VegMaterials sun uniforms not yet fed per-frame).
- [ ] Then layer: real erosion (`runErosion`, light iters) + hydrology (`runFlowRivers`) on the
      seeded DEM; fuse `/api/fields` classifier into fieldsTex/biomeTex (replace the minimal fill).
- [ ] Feed VegMaterials sun/season uniforms per-frame (lighting).
- [ ] Forests (GPU-culled dense plants + LOD + impostors) on the same hf → REPLACES procgen scatter.
- [ ] Trample (`render/Trample`) — needs vehicle ENU pos → veg-frame transform.
- [ ] Wind (`render/Wind`) + seasons (`render/Season`).
- [ ] Phase 2: make the 4096 m patch ROAM with the camera (rebuild/clipmap) for full-map low-alt detail.

### Terrain material — distance blend
- [ ] Port laas `TerrainMaterial`: satellite far → procedural grass/rock detail near,
      crossfade by camera distance, gated by `/api/fields`. (Fixes blurry ground textures.)

## Open issues / risks
- Backup veg is coupled to the backup's world/render pipeline (Heightfield, ProbeGI,
  compute Scatter, frame loop). Adapting to the terrain-server's EPSG:3413/ECEF tile
  system is the hard part — especially **GroundRing** (Tier 2, biggest risk).
- Backup three version vs webserver `three@0.182` — verify compatibility.

## Later — gameplay (from PROCGEN_SCATTER_DESIGN.md)
- [ ] Collision: analytic ground + capsule-vs-proxy; three-mesh-bvh for rays; Rapier for dynamics.
- [ ] Destruction: three-pinata (seeded fracture) → Rapier chunks.
- [ ] Networking: authoritative server memory + Redis (live) + Postgres (persist); track
      only deltas from the deterministic world.
