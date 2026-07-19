# Atlantis LAAS recovery log

This is the additive engineering record for restoring the proven LAAS visual
runtime to the streamed Atlantis game client. Existing entries are historical
evidence: append corrections and later measurements instead of rewriting an
older result in place.

## Goal and reference

- Runtime under repair: Atlantis WebGPU client on port 5173.
- Executable visual/performance reference: `greenland-laas-backup-2026-07-10-1845`
  on port 5174.
- Required outcome: preserve the reference's procedural ground cover, plants,
  rocks, materials, wind and LOD quality while supporting sustained vehicle and
  aircraft motion over streamed ArcticDEM terrain.
- Performance proof must cover controlled motion, not only a stationary camera.

## Working rules

- Preserve unrelated dirty vehicle/asset work in the shared checkout.
- Keep standalone synthetic LAAS behavior unchanged unless a change is
  explicitly measured in both clients.
- Separate correctness, streaming, scene rendering, vegetation, shadows and
  post-processing measurements. Do not infer one bucket from combined FPS.
- Record source changes, test results, live counters and known limitations for
  every recovery step.
- Do not call a result fixed until it survives a repeatable ground-level case
  and a controlled flight case.

## Verified baseline before recovery

### Port 5174 reference

- Free flight is smooth with the full procedural scene active.
- The reference uses one shared terrain patch geometry in an `InstancedMesh`,
  with per-tile origin/size/LOD data in a GPU buffer.
- Its terrain source is one generated 4096 x 4096 heightfield covering a fixed
  4 x 4 km world. It does not run Atlantis's geographic tile transport or
  per-tile mesh construction while flying.
- Its vegetation path uses deterministic GPU scatter, GPU culling/compaction,
  indirect instance draws and camera-following GroundRing cells.

### Port 5173 failure

- Reproduced at latitude 64.15738, longitude -51.75971, camera altitude 44 m.
- Terrain loaded, but live diagnostics reported grass 0, plants 0 and rocks 0.
- The clipmap allocated 96 vegetation library pools and hundreds of mesh nodes
  despite producing no visible instances.
- The same scene selected about 2,000 terrain heightmap tiles.
- The Atlantis terrain response embeds all selected 65 x 65 float32
  heightmaps as base64 JSON. At about 2,000 tiles this is approximately 34 MB
  raw or 45 MB after base64 expansion, before JSON overhead.
- Atlantis constructs separate CPU geometry and a material for each terrain
  tile, and its texture streamer permits up to 120 concurrent requests.
- Stationary 2560 x 1440 compile-out measurements already recorded in
  `PERF_REWORK.md`: cloud god-ray march about 10.7 ms, all LAAS vegetation
  about 9.8 ms, GTAO plus contact about 6.7 ms, vegetation casters about 5.8 ms.

## Root-cause boundary

The working port 5174 result proves that full procedural generation is not
inherently too expensive. The Atlantis-only regression boundary contains:

1. A real-terrain correctness error: synthetic `LAKE_LEVEL = 142` absolute
   elevation rejection was retained in scatter while Atlantis supplies real
   ArcticDEM elevations.
2. A 768 m external-heightfield adapter that completely rebuilds all Forests
   scatter buffers/materials whenever its center advances by 96 m.
3. A streamed terrain renderer made from up to thousands of independent
   geometries/materials rather than the reference's shared instanced patch.
4. Repeated whole-selection heightmap transport rather than page deltas.
5. Atlantis-only CSM, GTAO/contact and god-ray costs layered onto the graft.

## Additive work log

### 2026-07-18 - External heightfield contract and synthetic lake exclusion

Status: implemented; production build and unit tests pass; live WebGPU
verification in progress.

Changes:

- Added `Heightfield.external` to identify streamed geographic heightfields.
- `Heightfield.generate()` retains synthetic-world behavior (`external=false`).
- `Heightfield.fromExternal()` marks the real ArcticDEM adapter
  (`external=true`).
- Scatter applies the fixed synthetic `LAKE_LEVEL` checks only to generated
  LAAS worlds. External heightfields use their classifier-backed standing-water
  field instead.

Files:

- `webserver/laas/world/Heightfield.ts`
- `webserver/laas/gpu/passes/Scatter.ts`

Verification completed:

- `git diff --check` passed for both files.
- `node --test webserver/procgen/chunk-window.test.js webserver/terrain-priority.test.js`
  passed: 59 tests, 0 failures.
- Vite production build passed: 365 modules transformed.

Verification still required:

- Confirm nonzero plant and rock counts at the reproduced coastal coordinate.
- Isolate GroundRing's separate zero-grass classifier/water rejection.
- Capture moving-camera frame time and recenter hitch before changing the
  recenter architecture.

Live verification update:

- At the reproduced coastal window (`center=-1824:-2880`, AGL about 16 m),
  rocks changed from 0 to 3,007 accepted, with about 590 drawn and about
  238,000 vegetation triangles. This confirms the external-heightfield branch
  is active and removes the synthetic lake-level rejection for real terrain.
- The same coastal window still reports grass 0 and plants 0. These layers use
  stronger vegetation/biome gates than rocks and require classifier-input
  diagnosis; this is not counted as fixed yet.
- A separate live window (`center=2112:768`, AGL about 672 m) reported grass
  11,648, plants 9,831, rocks 18,164, plants drawn 133, rocks drawn 3,357 and
  about 2.39 million vegetation triangles. The graft is therefore capable of
  generating and drawing all three categories; the remaining zero result is
  specific to the coastal window/input fields.
- Existing WebGPU warnings remain: four vegetation geometries request a
  missing `vdata` attribute. This is tracked separately from the acceptance
  counters because it may hide specific pools even after scatter succeeds.

### 2026-07-18 - Preview-seed correction and live classifier proof

Status: implemented and verified for correctness; not a performance closure.

- The patch previously initialized from the first depth-10 preview response
  and stayed `ready` when the full terrain pass arrived. It therefore retained
  coarse parent height/classifier data indefinitely.
- Initial construction now waits for terrain pass 2 to settle. Resident parent
  tiles remain valid fallback, and a finer source arriving at the same patch
  center triggers a reseed without requiring another 96/192 m camera crossing.
- Field diagnostics now record min/mean/max, dry and vegetated fractions, and
  the exact height/classifier source tile IDs for every build/recenter.
- Coastal proof at `center=-1824:-2880`: height 28.156-28.172 m, vegetation
  0.000, water 0.847, dry fraction 0.000, sources `10-342-197` and
  `10-343-197`; plants 0 and stones 3,007 are consistent with that input.
- Inland/Osprey proof at latitude 64.19094, longitude -51.67814, altitude
  150 m: varied height 59.383-156.509 m, vegetation max 0.281, water mean
  0.004, dry fraction 1.000; plants 5,781, extras 5,233 and stones 20,108.
- CORRECTION to the earlier open item: understory/plants and rocks are not zero
  everywhere. The synthetic absolute lake rejection plus coarse preview seed
  explained the observed false zeroes; truly wet coastal classifier windows
  can still correctly produce no plants.

### 2026-07-18 - Recenter allocation and shader-invalidation work

Status: partial improvement; controlled motion still fails acceptance.

- Increased the snap step from 96 m to 192 m. With a 384 m patch half-width
  and GroundRing's 265 m far radius, worst camera offset is 96 m and leaves a
  23 m valid-data guard. The old step rebuilt twice as often with no added
  coverage.
- Added a 500 m AGL micro-detail LOD. Above it, streamed terrain/material LOD
  remains active while individual grass/plants/rocks do not build or run their
  approximately 3.2 million-candidate GroundRing cull. This is a normal
  altitude LOD, not the final moving-window architecture.
- A warmed 5 s high-altitude free-flight probe improved from 1.50 fps,
  3,302 ms worst frame, to 18.18 fps, 451 ms worst frame. The latter crossed
  10.2 km because the free camera permits approximately 5,000 m/s. This is a
  useful cost attribution result, not a playable result.
- Scatter output buffers, counters, placement kernels, Forests materials,
  geometry, indirect buffers and cull kernels now persist across reseeds.
  Height/classifier upload attributes and compute graphs also persist.
- Added recenter stage timing. One measured recenter was 318.8 ms:
  classifier 171.9 ms, heightfield/window 124.0 ms, scatter 22.9 ms. Another
  contended sample was 1,037.3 ms: 769.3/104.7/163.3 ms respectively.
- A separate 14.5-14.8 s movement frame remained. Source inspection found
  `refreshProcgenTerrainMaterials()` embedded each new patch center as shader
  constants and marked intersecting materials for recompilation. Patch center
  is now carried by stable shared uniforms; only tiles entering/leaving the
  footprint may change material graphs. Post-change acceptance measurement is
  still pending and the hitch is not declared fixed.

### 2026-07-18 - Terrain transport architecture rejection

Status: verified primary blocker; replacement world-partition path required.

- Direct measurement of one normal 20 km, depth-13 `/api/tiles` response at
  the Osprey location: **43,164,335 JSON bytes**, **1,884 tiles**, approximately
  two minutes locally. Depths: 8=8, 9=16, 10=61, 11=371, 12=1,428.
- The response retransmits every selected 65 x 65 float32 heightmap as base64
  on each movement refetch, including unchanged resident tiles. This confirms
  the earlier 34 MB raw/45 MB base64 estimate with a real payload.
- The server budget is 2,500 tiles and the client can build 200 new independent
  mesh/material objects in one reconciliation. Those are offline-viewer-scale
  budgets, not game streaming budgets.
- `_traverse()` also appends a real coarse tile when its bounding box lies
  entirely beyond `max_range`; this defeats strict player-centered residency
  and must be corrected in the replacement path.
- Required replacement: metadata-only manifest, bounded balanced quadtree
  cover, binary height payloads only for newly resident IDs, retained client
  cache, atomic parent-to-child swaps, cancellation/generation IDs, and
  velocity-ahead aircraft prefetch. The legacy `/api/tiles` path stays intact
  until the additive path passes visual and controlled-flight acceptance.

### 2026-07-18 - Bounded manifest and binary height pages

Status: implemented additively and live-verified; cache-delta flight validation
continues.

- Added manifest mode to `/api/tiles` and enabled it only in the WebGPU client.
  The legacy embedded-heightmap response remains available to the WebGL client
  and as a rollback/comparison path.
- Corrected the range traversal: a cached tile whose bbox lies wholly outside
  `max_range` is excluded instead of being appended as coarse global coverage.
- Replaced the old over-budget behavior, which simply dropped deepest/farthest
  leaves and could create holes, with repeated farthest-first sibling collapse.
  Four complete real children become one real parent, preserving a balanced
  coverage set down to the requested 384-tile game budget.
- Added versioned `/api/height/<tile>.bin` pages: raw 65 x 65 little-endian
  float32, immutable cache URL, exact 16,900-byte payload.
- Added client height-page hydration with 12-request concurrency and a
  tile-id/version memory cache. Unchanged manifest entries reuse their existing
  typed arrays; only new or changed IDs issue height requests.
- `decodeTerrainHeightmap()` accepts the binary `Float32Array` directly, so the
  new path avoids base64 decode and a second byte-copy.
- Live result at the same 20 km Osprey query: **192,550-byte manifest**, exactly
  **384 tiles**, zero embedded heightmaps, **133 ms** response. Depths:
  9=1, 10=137, 11=220, 12=26. This is about **224x smaller** than the measured
  43,164,335-byte snapshot before counting binary pages; subsequent movement
  retains unchanged pages.
- One live binary height page returned 16,900/16,900 expected bytes in 6 ms.
- Corrected manifest texture availability lookup to use `has_heightmap` metadata
  rather than requiring an embedded heightmap array.

### 2026-07-18 - Shadow failure isolation and flight LOD

Status: major playability recovery; final hitch target not yet met.

- Controlled 5 s motion, 15 s warmup, 1280 x 720 headless at the inland test
  site produced the following same-scene isolations:
  - full broken procedural CSM path: about 0.45 fps, repeating 3.2-3.3 s frames;
  - all procedural casters disabled: 21.35 fps, 33.4 ms median, 250 ms worst;
  - entire procedural patch disabled: 60.16 fps, 16.7 ms median, 17.7 ms worst;
  - GroundRing only: 44.15 fps, 16.7 ms median, 150.5 ms worst;
  - Forests/plants/rocks only: 24.34 fps, 33.4 ms median, 150.3 ms worst.
- A near-cascade-only large-rock caster experiment improved full motion to
  10.15 fps but still produced a 2,551 ms worst frame. It was rejected.
- Production procedural-ground shadow policy is now GTAO + contact + terrain
  lighting. Ground objects do not enter CSM. Terrain, vehicles, structures and
  god-ray terrain occlusion retain their shadow systems. Tree proxy CSM remains
  available for a future forested world; current Greenland scatter is treeless.
- Persistent Forests cull kernels now use Three's runtime dispatch-count
  override with the current accepted instance count. They no longer dispatch
  the theoretical candidate ceiling every frame.
- Added traversal-speed hysteresis: full micro-detail is active below 30 m/s,
  disables above 45 m/s, and remains disabled during fast travel. The system
  stops culling, drawing and recentering the patch while fast; it does not hide
  detail while continuing its regeneration cost. The separate altitude cutoff
  remains 500 m AGL.
- Production result with bounded manifest + ground-object CSM policy + speed
  LOD: **50.07 fps average**, 16.7 ms median, 33.3 ms p95, 83.4 ms p99 and
  200.1 ms worst while crossing 1.69 km. The prior equivalent path was about
  0.45 fps with repeating 3.3-second frames.
- This is not final acceptance: the 200 ms worst frame exceeds the 50 ms hitch
  budget, Forests steady cost remains high at low traversal speeds, and the
  final chunk/incremental procedural resident set remains open.

### 2026-07-19 - Live visual correctness recovery at Nuuk/coastal spawn

Status: root causes fixed and fresh-page verified; user hard refresh required
to discard the old tab's in-memory field blobs and shader graph.

- Screenshot coordinates: latitude 64.15293, longitude -51.76181, altitude
  35 m. The reported missing plants, moving rocks, crawling rock texture and
  black terrain band were separate defects.
- The field-cache key contained only tile ID and resolution. It did not include
  classifier algorithm, terrain version, texture version or water-mask version.
  Consequently stale blobs survived source changes indefinitely. The cache is
  now algorithm/source-versioned and automatically recomputes stale entries.
- The no-SAM water fallback treated any dark, flat satellite surface as water.
  At the screenshot site this yielded water=0.847 over visibly dry, 28 m-high
  terrain. Dark-grey water evidence is now sea-level-gated; blue water remains
  valid at elevation, and a cached SAM mask overrides the heuristic when one
  exists. The exact source tiles fell from mean water 0.719-0.847 to
  0.070-0.118.
- Concurrent first-load `/api/fields` calls exposed a schema-migration race:
  requests could both observe the old schema and one returned 500 on duplicate
  `ALTER TABLE`. The migration is serialized. A repeated three-tile concurrent
  request returned 200/200/200.
- Fresh-page procedural proof at the exact screenshot site: dryFraction=1,
  6,377 generated plants, 12,143 generated rocks, and 10,172 drawn grass
  instances after counters settled. Before the correction, plants and grass
  were zero because `standing water` was a hard scatter rejection.
- Rigid-object LOD used screen-coordinate interleaved-gradient noise. Merely
  rotating the camera therefore changed which rock fragments survived the LOD
  mask, reading as popping and paused-VCR shimmer. Forest/impostor LOD now uses
  a stable per-instance slot hash shared by both rings.
- Rock procedural/triplanar shading used ECEF `positionWorld` at approximately
  Earth-radius coordinates. High-frequency float operations lose precision at
  that magnitude. Rock shading now uses the instance-transformed local clipmap
  coordinate (hundreds of metres), keeping texture/noise spatially stable.
- A ray through the black band hit a duplicate `ShadowMaterial` terrain mesh at
  423 m before the real terrain at the same depth. Legacy vehicle/house shadow
  receiver tiles and directional shadow lights were active alongside the new
  scene CSM. Those duplicate receiver systems are now WebGL-only; WebGPU
  vehicles/houses remain normal casters in the scene CSM.
- A later hit at 2,137 m identified the remaining narrow dark strip as actual
  ocean. The old GLSL water surface was explicitly disabled under WebGPU. A
  WebGPU-native animated-normal water material is active, with a restrained
  blue reflection floor until an environment reflection probe is available.
- Added a low-cost hemisphere ambient floor so CSM-shadowed land cannot fall to
  black. It adds no shadow pass.
- Verification: four new classifier/cache regression tests pass, Python compile
  passes, Vite production build passes (365 modules), and the fresh raycast no
  longer contains a `ShadowMaterial` hit.
- Instrumented browser-console verification then caught eight vegetation
  pipelines at 17 vertex-output locations; WebGPU permits 16. The first stable
  rock-LOD fix had put its slot hash in a new scalar varying while tint already
  occupied a `vec2` varying. The three instance-stable hashes now share one
  `vec3` interpolator. This keeps camera-independent, complementary LOD masks
  without adding a vertex-output location.
- Local-detail vegetation, canopy/impostor and clipmap terrain factories no
  longer request the full physical node-material variant. They use the leaner
  standard PBR pipeline; the WebGPU ocean uses Lambert lighting until a real
  environment reflection probe exists. This preserves the relevant albedo,
  normal, AO and direct-light response without paying for unused physical
  features in thousands of local-detail instances.
- Final fresh-page browser-console verification at the screenshot coordinates
  produced no shader, render-pipeline, command-buffer or WebGPU validation
  error. The earlier 51.83 fps movement sample was rejected after the log
  exposed invalid pipelines. Repeated on the validation-clean shader set, the
  5 s sample covered 834.8 m at 37.79 fps average (17.1 ms p50, 34.2 ms p95,
  200.1 ms p99, 250 ms worst). This confirms the catastrophic 3.3 s stalls are
  gone but does not close the remaining frame/hitch budget.
- A separate high-altitude test coordinate did not make the procedural patch
  ready inside 120 s. That startup/coverage case remains open and is not hidden
  by the successful coastal movement sample.

### 2026-07-19 - Rock grounding and camera-motion follow-up

Status: reported stationary rock defects corrected and live-probed; patch
recenter continuity remains open.

- Evidence was taken from the user's 01:21:26, 01:21:54 and 01:27:14 captures.
  The first pair is the same camera position at latitude 64.17685, longitude
  -51.71100 and altitude 48 m, with headings 117 and 127. This rules out
  wholesale tile streaming as the cause of that pair's apparent rock changes.
- The working standalone LAAS backup was checked as an executable/reference
  implementation. It grounds its terrain and scatter against one heightfield.
  Atlantis instead renders streamed DEM quads as two triangles but sampled
  prop heights with bilinear interpolation. A bilinear saddle can sit above or
  below either rendered plane on a rugged cell. Atlantis now samples the exact
  `(a,b,d) / (b,f,d)` triangle split used by `terrain-mesh-builder`.
- The triangle sampler is isolated in `terrain-height-sampling.js` with edge,
  split and malformed-input tests, so terrain and prop grounding cannot
  silently drift back to different surface equations.
- The first camera-stability repair used one stable threshold per instance.
  That removed screen-space VCR crawl, but an opaque rock could still switch
  as a whole when crossing a ring threshold. Rigid rock rings now share a
  camera-independent object-surface dither. Camera motion changes a stable
  spatial crossfade instead of blinking the entire boulder. Living vegetation
  retains the cheaper per-instance threshold.
- The screen-space contact march now spans 3.0 m rather than 1.7 m, with a
  2.6 m depth acceptance rather than 1.4 m. This covers the 2-5 m scaled
  boulders while retaining the same 12 texture taps; it is a range correction,
  not another post-process pass.
- Exact-area fresh-page probe after the changes: clipmap center `576:-768`,
  3,340 large extras and 16,694 stones generated. After asynchronous counter
  readback settled, headings 5 and 355 both reported exactly 3,128 rock/extra
  draws and 2,651,663 triangles. No shader, pipeline or WebGPU validation error
  was emitted. Sampled large-rock origins were normally 0.2-0.7 m below the
  source surface, intentionally embedding their bases rather than hovering.
- Relevant automated tests pass (67/67), the Vite production build passes at
  366 modules, the fields regression tests pass under the repository venv, and
  Python compilation passes. The separate legacy cloud test is not part of
  this result: its installed package does not export the subpath that test
  imports.
- **Still open:** the current speed LOD hides the complete procedural root at
  45 m/s and a 192 m recenter hides it while scatter buffers are rewritten.
  Logs prove these state changes during flight. That is a distinct streaming
  continuity defect and needs a resident old/new patch handoff or a dedicated
  macro-rock tier; raising a threshold would only move the pop elsewhere.
- **Still open:** a direct cold start at a separate high-altitude coordinate
  can leave `greenlandPatch.ready=false` because the build gate depends on the
  terrain-derived AGL sample. It is tracked separately from rock grounding.

### 2026-07-19 - Cruise satellite tier and safe procgen return

Status: implemented and live-probed; continuous cell residency remains open.

- The user confirmed the intended current design: cruise/fast flight and high
  altitude render the cached 12 m satellite/DEM terrain without paying for the
  complete GroundRing/Forests patch. Full procedural grass/plants/rocks return
  below 30 m/s and 500 m AGL; speed disables above 45 m/s, and altitude may
  prewarm below 650 m.
- The previous gate could reveal a procedural patch centered at the old flight
  position as soon as speed fell. Visibility now also requires that the active
  window covers the camera's full 265 m detail radius. Destination fields and
  buffers prepare while hidden, then publish only at the current snapped cell.
- Scatter's five dependent placement passes now use one ordered WebGPU batch,
  preventing an animation frame from observing cleared-but-not-refilled rock
  and plant counters during a recenter.
- At 141 m/s, deliberately forcing full procgen produced seven recenters over
  835.5 m and 33.3/50.9/167.6 ms p50/p95/worst. The satellite cruise tier
  produced no procedural recenter work. A 531.3 m cruise-to-slow test restored
  exact cell `-2304:-3264` in 990.6 ms with no stale-root frame; warm fields
  took 4.5 ms and buffer preparation 159.1 ms.
- The grounding mask now runs at half resolution, matching the LAAS post-stack
  architecture while retaining full-resolution scene color/depth. Cruise
  improved from 32.5/34.2/84.3 ms p50/p95/worst to 16.7/17.6/66.7 ms at
  1961x1062. Production build and live WebGPU validation passed, and the exact
  visual-probe site produced 12,981 plants plus 19,019 rocks without a mask
  halo or black-terrain regression.
- Still open: the warm whole-window rewrite is 163.6 ms, cold classifier field
  generation can take seconds before it becomes a warm cache hit, and the
  long-term retained-cell/macro-rock tier is not implemented. These are not
  hidden by the successful cruise result.

### 2026-07-19 - Procgen disappearance and camera-only population changes

Status: the accidental no-procgen gate is removed; the same-view population
regression is fixed and verified against the live WebGPU client.

- The first surface-readiness experiment required `deferredTiles.size === 0`.
  Runtime instrumentation showed the full pass stabilizing at 382 requested
  heightmaps, 365 scene meshes and 29 deferred texture waits. Those waits are
  legal and may persist, so global queue emptiness is not a local-terrain
  readiness signal. This explains both observed effects: procgen was dead and
  FPS suddenly rose because the complete procedural workload was suppressed.
- The replacement is spatial. The reconciler can immediately build fine,
  untextured height geometry only for tiles overlapping a 512 m half-span
  around the camera. Texture loading remains deferred and the textured stale
  parent continues to cover all other areas. Local height geometry and procgen
  therefore converge without waiting for the 20 km imagery queue.
- Two new reconciler tests prove that stale-parent coverage is overridden only
  inside that callback-selected local window and remains deferred by default.
- The user's 17:04:46 and 17:05:12 images showed identical position, altitude
  and heading but radically different grass/plant populations. The shared
  cause was not random seeds or a tile refetch: both `Forests.update` and
  `GroundRing.update` built their GPU frusta from a previous-frame
  `camera.matrixWorldInverse`. Three refreshed it later in `renderScene`; if
  the demand-driven loop stopped after the last drag event, the wrong frustum
  remained indefinitely. `camera.updateMatrixWorld(true)` now runs after all
  gameplay camera changes and immediately before both procgen culls.
- A headless WebGPU reproduction at 64.18697, -51.68571, altitude 75 m turned
  away and returned to the exact starting yaw. Both settled frames used cell
  `1728:384`, the same four depth-12 sources, 9,498 generated plants and
  24,002 generated rocks, and matched visually. Returned async counters were
  9,501 grass, 70 plants and 3,216 rocks.
- A separate storage-buffer grounding readback at the same site found 4,472
  extras and 19,530 stones. Sampled origins followed the resident depth-12
  triangle surface with the intended 0.2-1.0 m base sink; the settled placement
  data was not floating. The earlier extreme overhead-rock capture occurred
  during coarse/fine startup investigation and is not being used as proof that
  the settled grounding defect remains.
- The hard seven-tap terrain occlusion threshold now applies only to trees.
  Ground rocks remain frustum/distance bounded, avoiding threshold flips as a
  nearest height sample changes. Tundra flora joins rigid props in using
  stable object-surface LOD dissolution so an entire plant no longer crosses a
  single per-instance visibility threshold at once.
- Verification: all 86 Web tests and the Vite production build pass. The live
  probe emitted no WebGPU shader, pipeline, validation or command-buffer error.
  The optional model service on port 8787 remained unavailable and produced
  its existing startup fallback warning.
