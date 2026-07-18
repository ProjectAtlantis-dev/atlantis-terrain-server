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
