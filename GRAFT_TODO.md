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

### Tier 1 — VegLibrary (Greenland species + TSL materials)
- [x] Copy backup veg subsystem → `webserver/laas/` (69 files: core/gpu/render/world/vegetation/sky).
- [x] `webserver/laas/` transpiles through vite (VegLibrary, VegMaterials, BarkSynth,
      NoiseTSL, GreenlandFlora all 200; no vite errors). three@0.182 compatible so far.
- [x] Adapter `laas-scatter-adapter.js`: `buildVegLibrary(renderer, seed)` async pools →
      `scatter.ts` AssetLibrary. Maps VegClass → categories (Greenland shrubs/flowers/rocks;
      skips trees/logs). Uses mid-LOD ring + hero leaf crown, node materials via `make()`.
- [x] Wired `main.webgpu.terrain.js` `scatterLibrary()` → async backup build (memoized);
      `attachTileScatter` awaits it. Transpiles clean.
- [x] `buildVegLibrary` completes under the terrain-server WebGPU renderer: 96 Greenland
      pools, 6 foliage atlases, 2 bark texture sets, and the shared RockSynth maps. The
      treeless build skips unused tree pools/impostors instead of blocking Greenland startup.
- [x] Runtime season uniforms are connected to every material factory.
- [x] `GreenlandFlora` composition drives the GPU understory scatter.

- [x] **PERF: camera-following LAAS clipmap.** Production WebGPU scatter owns one snapped
      768 m square (384 m half-width: the 265 m lush ring plus a guard band), recentres every
      96 m, and regenerates only that local deterministic domain. The old per-tile adapter is
      retained as a fallback but does not own production rendering.
- [x] Treeless library build skips the unused six tree pools and octahedral impostor bake.

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
      reuses `rebuildDerivedMaps` for normals/heightTex, and now accepts the real classifier
      sampler used by the production field fuse below. Reuses the class's sampling verbatim.
- [x] **Mount module `laas-terrain-patch.js`** — `GreenlandPatch`: builds the Heightfield from
      loaded terrainRoot tile hm, instantiates `GroundRing(hf, emptyCanopy, seed, null)`, mounts
      it as a ROTATION ISLAND (vegRoot, +90° about X: y-up→z-up) under terrainRoot, drives
      GroundRing via a PROXY CAMERA in the veg frame. Wired into main.webgpu render loop.
      > FRAME MATH (island = rot +90° X ⇒ GR(x,y,z)→terrainRoot(x,-z,y)):
      >   sampleDEM(wx,wz) reads terrain at terrainRoot-local (wx, **-wz**) [north flip].
      >   proxy.projectionMatrix = cam.projectionMatrix;
      >   proxy.matrixWorldInverse = cam.matrixWorldInverse · vegRoot.matrixWorld;
      >   proxy.position = inverse(vegRoot.matrixWorld) · camWorldPos.
      >   LOD/fade distance uses the proxy-camera `vegViewPos` in LAAS-local space;
      >   Three still transforms normals/lighting through the real ECEF scene frame.
- [x] Runtime reaches `patch.ready`: 9 chunks / 288² / 1.98 km, 75,603 grass cells,
      35,665 Greenland plants and 58,347 rock/stone instances in the live GPU run.
- [x] Replaced that oversized 3×3 scatter domain with the 256² / 768 m camera clipmap:
      current live field produced 7,704 plants and 10,463 rocks before instance culling;
      115 plants and 2,847 rocks survived the measured ground-level view.
- [ ] Then layer: real erosion (`runErosion`, light iters) + hydrology (`runFlowRivers`) on the
      seeded DEM.
- [x] **Production classifier pipeline:** WebGPU mounts `GreenlandPatch` by default;
      cached/retried `/api/fields` rasters are mosaicked with the streamed ArcticDEM and
      uploaded into stable LAAS `fieldsTex`/`biomeTex`/`waterY` resources. Re-centering
      updates DEM + classifier resources together; water hard-excludes vegetation.
- [x] Feed VegMaterials sun/season uniforms per-frame (lighting).
- [x] Forests GPU renderer mounted on the external heightfield; every Greenland plant/rock
      pool instantiates its real TSL material factory and generated texture dependencies.
- [x] Every Greenland understory pool now has r0/r1/r2 geometry (full / 45% / 15%) and
      complementary dithered near→mid→far transitions through the existing indirect culler.
- [x] Fixed GroundRing coordinate-space regression: material LOD fades now use the LAAS
      proxy-camera uniform, not ECEF `cameraPosition` (which hid the inner grass rings).
- [x] GroundRing candidate scan reduced from 9.4 M to 2.36 M five-blade clumps while
      preserving aggregate coverage with 2× clump width.
- [ ] Trample (`render/Trample`) — needs vehicle ENU pos → veg-frame transform.
- [x] Wind (`render/Wind`) + seasons (`render/Season`).
- [x] Camera-roaming clipmap: 96 m snapped recentres update stable Heightfield resources and
      rebuild only the compact local scatter buffers.

### Terrain material — distance blend
- [x] Port laas `TerrainMaterial`: satellite far → procedural grass/rock detail near,
      crossfade by camera distance, gated by `/api/fields`. (Fixes blurry ground textures.)
      The terrain splat is the final grass/plant LOD, stays solid through the 265 m geometry
      handoff, and carries the same live spring/autumn/winter uniforms. Greenland external
      shading disables the synthetic LAAS macro geography/lake assumptions.

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
