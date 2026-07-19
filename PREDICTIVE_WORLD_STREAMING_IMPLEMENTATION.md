# Predictive World Streaming Implementation

Created: 2026-07-19

Pre-implementation revert point: `e65dc11`

## Record discipline

The proposal between **PROPOSAL START** and **PROPOSAL END** is frozen after
its initial commit. It must not be rewritten to match later implementation.
Corrections, rejected assumptions, implementation results, measurements and
remaining work are appended chronologically after **IMPLEMENTATION LOG**.

## PROPOSAL START

### Outcome

Atlantis must support continuous high-speed aircraft flight without removing
terrain, rocks or all procedural vegetation because of speed. Terrain already
acquired by the server remains durable; each client maintains a bounded,
velocity-predicted CPU/GPU working set. Procedural placement is derived from an
authoritative world identity and absolute EPSG:3413 cells so clients agree on
object identity and position independently of their camera-following window.

The Google Maps navigator is a separate teleport workflow. It may prewarm a
destination and use a transition, but normal aircraft flight may not.

### Facts at the baseline

- `terrain.db` is the durable development cache, not the GPU working set. At
  baseline it is 385 MB with 100,049 tile records, 11,427 populated heightmaps,
  10,427 textures and 3,288 classifier-field pages.
- The local `origin/main`/`origin/webgpu` code selects error-based leaves within
  range and embeds all selected heightmaps. It does not render the whole DB.
  The measured Osprey request selected 1,884 leaves and returned 43,164,335
  JSON bytes.
- The recovery branch uses a hole-free balanced manifest capped at 384 leaves,
  then hydrates versioned binary height pages. At the same location the
  manifest was 192,550 bytes. The cap is a safety ceiling, not a claim that 384
  is the universally correct final residency.
- Current terrain prediction is incomplete: heading affects texture priority,
  terrain refetch waits for 5 km of movement, leaf coarsening is distance-only,
  and procedural residency has no velocity-ahead queue.
- Atlantis passes a fixed seed `1337` into the LAAS patch. GPU hashes are
  deterministic, but candidate cells are patch-local. The same window repeats;
  overlapping windows are not yet guaranteed to produce identical world IDs.
- The current LAAS flight policy hides the entire procedural root above 45 m/s
  and while in-place scatter buffers are reseeded. That policy is not an
  acceptable final flight LOD.

### Architecture

#### 1. Durable world storage

- Keep the existing quadtree and permanent height/texture/classifier cache.
- Add a server-owned `worldSeed` and `procgenVersion`; clients may not invent
  either value independently.
- Production migration target:
  - immutable terrain/imagery/classifier pages in object storage plus CDN;
  - PostgreSQL/PostGIS for page metadata, world identity and durable gameplay
    state;
  - Redis for presence, hot cell membership, short-lived spatial interest and
    event fan-out;
  - authoritative game services for movement, combat and validation.
- Redis is not the durable authority. PostgreSQL stores player snapshots,
  inventory, structures and procedural-object deltas.

#### 2. Terrain working set and prediction

- Continue to cover the complete visible range with a balanced quadtree; never
  retain only an arbitrary subset that creates holes.
- Treat 384 as an initial maximum leaf ceiling. Record actual CPU build time,
  GPU cost and memory proxies before changing it.
- Predict a streaming focus from position, velocity and heading. Bound the
  lookahead so turns retain coverage; keep the current position as a mandatory
  source and use the predicted focus as additional priority.
- Refresh the lightweight manifest from predicted displacement/time, not only
  after 5 km of actual movement. Versioned height pages must be fetched only on
  cache misses.
- Apply hysteresis: retain trailing pages until outside a larger unload region
  so turning does not thrash residency.
- Long-term render target is a fixed-cost terrain geometry clipmap backed by a
  GPU height/color page atlas. The server quadtree remains the page provider;
  collision remains a separate near-player representation.

#### 3. Deterministic procedural identity

- World placement key:
  `worldSeed + procgenVersion + absolute EPSG:3413 cell + class + candidate`.
- Candidate hashing and jitter use absolute integer cells. Patch-local position
  is derived only after the stable absolute candidate has been selected.
- Every accepted object exposes a stable 64-bit-equivalent ID (two uint32s are
  sufficient in WebGPU) suitable for network/persistence keys.
- Add seam tests proving the same overlap produces the same IDs/transforms from
  adjacent procedural windows.
- Store only deviations from generation: destroyed, harvested, moved, replaced
  or player-built state. Do not persist millions of unchanged generated poses.

#### 4. Procedural flight residency and LOD

- Remove speed as a binary visibility switch once continuous residency exists.
- Divide procedural residency into independently replaceable absolute cells.
  Crossing a boundary retains shared cells and generates only the leading edge.
- Prioritize leading cells using the same predicted flight corridor as terrain.
- Near ring: full grass/plants/detailed rocks and contact grounding.
- Middle ring: reduced vegetation and ordinary rock LODs.
- Far procedural ring: macro rocks/shrubs/impostors or HLOD proxies; no grass.
- Terrain, vehicles, buildings and exceptional gameplay objects retain shadow
  maps. Ordinary plants/rocks use material lighting, GTAO/contact and aggregate
  distant occlusion rather than per-object CSM casters.
- Old cells remain renderable until replacements are complete. A failed or slow
  generation job may reduce detail but must not expose a black/empty boundary.

#### 5. Multiplayer interest and persistence

- Clients subscribe to authoritative spatial cells intersecting their current
  and predicted flight corridor.
- Redis may index current player/entity positions for nearby-interest queries
  and distribute hot events.
- PostgreSQL/PostGIS stores durable deltas keyed by
  `(world_id, procgen_id)` with cell, state, revision and timestamps.
- Player position updates are processed by the game service; meaningful events
  and periodic snapshots are committed durably. Terrain and unchanged
  procedural poses are never replicated per frame.

### Implementation stages

1. **Instrumentation and pure prediction**
   - Add tested prediction/corridor functions.
   - Log current/predicted centers, speed, lookahead and manifest churn.
   - Preserve the 384 safety ceiling.
2. **Authoritative world identity and absolute procedural cells**
   - Serve world seed/version from backend metadata.
   - Feed it into LAAS before the first scatter.
   - Convert all scatter candidate hashes to absolute cells and add seam tests.
3. **Predictive terrain residency**
   - Use current plus predicted sources for priority and manifest refresh.
   - Add hysteresis and bounded per-frame materialization/upload work.
   - Measure cold/warm high-speed flight.
4. **Continuous procedural residency**
   - Replace the monolithic in-place patch update with retained absolute cells
     and leading-edge generation.
   - Remove the 45 m/s whole-root visibility cutoff.
   - Add near/middle/macro flight LODs.
5. **Production persistence interfaces**
   - Define Postgres/PostGIS delta schema and Redis interest/event contract.
   - Keep SQLite development compatibility behind the same repository/service
     interfaces; do not introduce Redis/Postgres as hard local boot blockers.
6. **Terrain clipmap migration**
   - Replace per-tile render geometry incrementally with shared clipmap rings
     and GPU page atlases after stages 1-4 have stable measurements.

### Acceptance gates

- A normal aircraft flight path never toggles the entire procedural root solely
  because speed crossed a threshold.
- Returning to a world cell reproduces the same stable procedural IDs/poses.
- Adjacent procedural windows agree exactly in their overlap.
- Warm flight performs no upstream DEM/imagery fetch for already cached pages.
- Manifest and binary page transfer, scene tile count, generated cell count,
  frame p50/p95/p99 and worst hitch are recorded for each flight test.
- No WebGPU validation, shader, pipeline or command-buffer errors.
- Terrain coverage remains hole-free through turns and high-speed travel.
- Every stage is committed independently and can be reverted to `e65dc11`.

### Non-goals and rejected shortcuts

- Do not render every tile stored in the DB.
- Do not solve popping by merely increasing the 45 m/s cutoff.
- Do not store every generated plant/rock row in PostgreSQL.
- Do not add more procedural CSM casters to disguise weak grounding.
- Do not rewrite this proposal after implementation reveals a wrong assumption;
  append the correction and evidence below.

## PROPOSAL END

## IMPLEMENTATION LOG

### 2026-07-19 - Record created

- Frozen proposal recorded against clean baseline `e65dc11`.
- No predictive-streaming implementation code had been changed at the time of
  this entry.

### 2026-07-19 - Stages 1-3 implementation and measured correction

Status: implemented locally and live-probed; not yet the stage-4 continuous
procedural-cell architecture.

- Terrain transport remains a hole-free quadtree rather than “load every DB
  row.” The preview asks for 16 leaves, but the current stored pyramid can only
  collapse the requested footprint to 45 real ancestors without holes. The
  settled pass is capped at 384 leaves and hydrates only missing versioned
  height pages. Scene construction is bounded to 16 preview / 32 settled
  meshes per continuation. Scheduler continuations use a zero-delay task;
  relying on `requestAnimationFrame` could strand pass 2 when the first WebGPU
  frame was expensive or the tab was backgrounded.
- Streaming focus now predicts from position, heading and speed with a bounded
  4-20 second / 5 km lookahead. Manifest refresh uses predicted displacement
  with a 1,200 m threshold and 1 s trigger floor. The current position remains
  authoritative coverage; prediction changes priority, not correctness.
- Flask now owns a persistent `worldSeed` and `procgenVersion`. Scatter hashes
  use biased absolute EPSG:3413 grid cells rather than patch-local cells. CPU
  overlap tests and GPU readback agreed on all 2,524/2,524 large-rock keys in
  adjacent windows; reconstructed world coordinates differed only by the
  expected approximately 0.001 m float reconstruction tolerance.
- Scatter buffers are sized to the actual absolute-grid candidate count rather
  than theoretical multi-million-instance ceilings. Its dependent clear/tree/
  understory/extra/stone passes are submitted as one ordered WebGPU batch so a
  render cannot observe the cleared intermediate scatter state.

### 2026-07-19 - Procedural handoff experiments and rejected approaches

- A resident active/inactive pair was implemented and measured. Data handoff
  after allocation was approximately 118-142 ms, but the first visibility of
  the second Forests/GroundRing graph triggered a 12.5 s lazy render-pipeline
  compilation frame. It was rejected.
- Explicitly compiling the inactive graph ahead of time was also rejected:
  `renderer.compileAsync` moved the stall into startup and increased readiness
  to 40.2 s.
- The current implementation retains one compiled render/material graph and
  rewrites its persistent height/classifier/scatter buffers. A coverage guard
  keeps a stale patch hidden after long-distance travel; during an ordinary
  adjacent recenter the old patch remains visible only while it still covers
  the complete 265 m detail radius.

### 2026-07-19 - Speed/altitude tier decision (proposal correction)

The user confirmed that the present game should intentionally use its cached
12 m satellite/DEM terrain tier during cruise/fast flight, then restore full
procedural detail after slowing or descending. This supersedes the frozen
proposal's stage-4 acceptance statement for the current monolithic patch. The
proposal remains unchanged above so the decision history is visible.

- Micro-detail exits above 45 m/s and re-enters below 30 m/s. It exits above
  500 m AGL and may prewarm below 650 m. These gates affect only the procedural
  root; streamed terrain, imagery, water, structures and vehicles remain.
- Prewarming begins only below the speed exit threshold. Visibility requires
  both the detail gate and a current window whose full 265 m radius covers the
  camera. A slow-down therefore cannot flash the old procedural patch at the
  previous flight position.
- Keeping full procedural detail active at 141 m/s was measured and rejected:
  835.5 m in 8 s caused seven recenters and measured 33.3 ms p50, 50.9 ms p95,
  151 ms p99 and 167.6 ms worst at 1961x1062. The procedural root remained
  visible, proving the result was cost—not a missing-root artifact.
- With the intended cruise tier, the same 141 m/s path performed zero
  procedural recenters. After the grounding optimization below, the measured
  result was 16.7 ms p50, 17.6 ms p95, 34.2 ms p99 and 66.7 ms worst.
- A cruise-to-slow handoff after 531.3 m restored detail at the exact predicted
  cell `-2304:-3264` in 990.6 ms. No stale root was visible before readiness.
  The warm classifier lookup was 4.5 ms and the persistent-buffer preparation
  was 159.1 ms (163.6 ms total).

This is a correct bounded fallback, not completion of proposal stage 4. The
future retained-cell/macro-rock architecture may remove the binary speed gate
if it meets budget. The current 163.6 ms warm rewrite still fails the 50 ms
hitch target, and a separate cold source-refinement run spent about 12 s
generating/loading classifier fields before later warm reads fell to 4.5 ms.

### 2026-07-19 - Half-resolution grounding implementation

- The measured full-resolution GTAO/contact bucket was about 6.7 ms at desktop
  resolution. LAAS's source design evaluates GTAO at half resolution, so
  Atlantis now renders only the scalar grounding mask at half width/height and
  bilinearly reconstructs it over full-resolution scene color. Scene depth,
  terrain, atmosphere and final color remain full resolution.
- Cloud god rays and grounding now share one reusable scaled-RTT owner.
  `?groundingFull=1` retains the full-resolution A/B path.
- Same-path 141 m/s cruise before this change measured 32.5 ms p50 / 34.2 ms
  p95 / 84.3 ms worst. After it: 16.7 / 17.6 / 66.7 ms. The Vite production
  build passed (373 modules), no shader/pipeline/WebGPU validation error was
  emitted, and a fresh frame at 64.18455, -51.70203 showed no visible mask
  edge or terrain-darkening regression.

### 2026-07-19 - Local geometry readiness and view-stable procgen correction

Status: implemented and live-probed after the user reported that procgen first
vanished, then grass/plants/rocks changed when only the camera view moved.

- A first attempted readiness condition required the entire deferred terrain
  queue to reach zero. This was wrong and was removed: 29 distant entries can
  legitimately remain deferred while awaiting imagery, so the condition made
  local procgen permanently unavailable and made the client appear fast only
  because its detail workload was absent.
- The terrain reconciler now has a narrowly scoped override for the 1,024 m
  local procgen geometry window. Fine height meshes in that window may be
  materialized untextured beneath a textured stale parent while their imagery
  remains deferred. Distant tiles keep the normal textured-parent handoff.
  Two regression tests cover both the local override and the unchanged distant
  behavior.
- The camera-turn pop had a separate cause. Procgen's `Forests` and
  `GroundRing` culls ran before `renderScene`, but relied on the camera inverse
  matrix that Three normally refreshes inside `renderScene`. With the
  demand-driven render loop, the previous-view frustum could persist after a
  drag ended. The camera world/inverse matrices are now explicitly updated
  before either GPU cull.
- At latitude 64.18697, longitude -51.68571 and altitude 75 m, an automated
  turn-away/turn-back probe returned to the identical heading, patch cell
  `1728:384`, depth-12 source set, 9,498 generated plants and 24,002 generated
  rocks. Before/returned frames matched visually instead of reproducing the
  user's all-layer disappearance. The returned counters reported 70 visible
  plants, 3,216 visible rocks and 9,501 grass instances.
- GPU buffer readback at that location found 4,472 large extras and 19,530
  stones. Sampled rock origins matched the resident depth-12 terrain and were
  deliberately sunk by their base offset; no floating placement equation was
  found in the settled window.
- The seven-sample hard terrain-occlusion rejection is now limited to trees;
  applying it to ground rocks made visibility flip around a 4 m nearest-sample
  threshold. Tundra flora and rigid objects use stable surface LOD dissolution
  instead of whole-instance transitions.
- Automated Web tests pass 86/86 and the Vite production build passes at 373
  modules. The only browser warning in the probe was the already-known optional
  asset service on port 8787 being unavailable; no shader/pipeline/WebGPU
  validation error was emitted.
