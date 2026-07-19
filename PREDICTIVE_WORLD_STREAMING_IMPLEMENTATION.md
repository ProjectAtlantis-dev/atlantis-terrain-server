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
