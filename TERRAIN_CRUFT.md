# Terrain Cruft Removal

This checklist tracks the terrain redundancy audit. Items are completed in
order, with the focused regression test recorded before work starts on the
next item.

- [x] Retire the unused in-memory quadtree in `flaskserver/tiles.py`; give the
  canonical Greenland tile extent a configuration owner.
  - Checkpoint: `python -m unittest test.test_terrain_config
    test.test_database_retirement` — 4 passed.
- [x] Remove the inactive single-tile and bulk DEM fetch implementations from
  `flaskserver/serve.py`; retain one scheduler-driven materialization path.
  - Checkpoint: `python -m unittest test.test_cog_fetch_scheduler
    test.test_terrain_demand` — 26 passed.
- [x] Centralize browser tile-address parsing, formatting, ancestry, and bbox
  math; migrate the independent implementations.
  - Checkpoint: focused tile-address, fly-to, cliff-graft, terrain-priority,
    and WebGL/WebGPU water tests — 116 passed.
- [x] Centralize the browser's explicitly approximate local ENU/latitude-
  longitude conversion and migrate camera, vehicle, restore, and fly-to uses.
  - Checkpoint: focused coordinate, camera/fetch, vehicle, and fly-to tests —
    104 passed.
- [x] Consolidate texture-streamer request cleanup and debug-mode cache
  invalidation.
  - Checkpoint: focused streamer cleanup plus existing streaming/lifecycle
    tests — 90 passed.
- [x] Define and test the shared contract for intentionally separate WebGL and
  WebGPU terrain/water implementations.
  - Checkpoint: render-contract, WebGL water, WebGPU water, and shared terrain
    tests — 96 passed.
- [x] Fix the shared bathymetry layer migration and guard both render backends
  against references to the retired local constant.
  - Checkpoint: focused render tests — 9 passed; production build passed;
    live WebGL startup reached two canvases with no uncaught runtime exception.
- [x] Centralize Python terrain tile-ID parsing and formatting; migrate every
  production parser to the shared module.
  - Checkpoint: tile-address and affected terrain/database/classifier tests —
    71 passed.
- [x] Remove the unused latitude/longitude `query_tiles` wrapper and its sole
  coordinate-conversion import; retain the stereo-coordinate entry point used
  by the application.
  - Checkpoint: serve-cruft, terrain-demand, tile-address, and classifier
    hierarchy tests — 25 passed; focused Pyright check passed.
- [x] Consolidate the duplicate browser percentile implementation used by CPU
  profiling and WebGPU bathymetry diagnostics.
  - Checkpoint: full browser suite — 175 passed.
- [x] Give terrain visibility and fog policies one Earth-horizon calculation
  while retaining their deliberately different distance caps.
  - Checkpoint: tile-runtime and affected priority tests — 90 passed.
- [x] Retire the unused application priority-color ramp; retain the live,
  higher-contrast tile-inspector canvas palette.
- [x] Remove the unused procedural cook-classifier island. Its only callers
  were its own tests, while the live classifier verifier already treats its
  persisted source names as stale.
  - Checkpoint: classifier, texture, and database-retirement tests — 37 passed.
- [x] Remove the retired fixed Flask road-color palette. The live painter
  samples the underlying imagery; only the still-used road-width policy remains.
  - Checkpoint: asset-catalog tests — 8 passed; focused Pyright check passed.
- [x] Remove zero-reader terrain helpers left behind in coordinates,
  environment parsing, official-water classification, seam resampling, and LOD
  coverage.
  - Checkpoint: affected server suites — 57 passed; focused Pyright and GPU
    profile follow-up — 6 passed.
- [x] Retire browser terrain surfaces with no production caller: the old
  vector-road runtime, standalone availability controller, tile-reconciler
  wrapper, and client-side cliff-water inpainting superseded by Flask.
  - Checkpoint: cliff-graft, retirement, and terrain reconciliation tests —
    91 passed.
- [x] Remove the unused procgen debris builders/materials, dormant leaf
  material, and the last test-only tile-subtree wrapper.
  - Checkpoint: focused retirement/address tests — 6 passed; production Vite
    build passed.
- [x] Retire the unreferenced 1,038-line Flask asset/vehicle implementation;
  the live terrain integration is `asset_catalog.py`, while the standalone
  service remains owned by `assetserver/src/server.ts`.
  - Checkpoint: asset-catalog and server-startup tests — 11 passed.
- [x] Remove the final zero-reader request parser and logging constants found
  by the Python symbol sweep.
  - Checkpoint: focused retirement tests — 4 passed.
- [x] Run the full browser and Flask regression suites.
  - Browser: 173 passed.
  - Flask: 146 passed.
  - Production Vite build: passed.
  - Live WebGL startup: two canvases, no uncaught runtime errors, no console
    errors.
  - Focused Pyright checks for every changed Python path: passed. The
    pre-existing whole-project baseline still reports 39 diagnostics in
    untouched classifier, ingest, calibration, and test code.
- [x] Make Flask terrain demand stateless. Each response is only the latest
  camera heatmap; Flask retains no previous-LOD set and owns no browser
  residency or retirement state.
- [x] Centralize browser mesh retirement in one heatmap residency sweep.
  Response reconciliation and asynchronous texture arrivals may invoke the
  sweep, but cannot independently evict ancestors or descendants.
- [x] Keep a stale parent or fine tile rendered until the replacement requested
  by the latest heatmap has textured coverage. Reversing direction immediately
  protects every tile in the newest heatmap, including `12-1398-779`.
