# Procgen Runtime Recovery Plan

This is the working, additive ledger for the Greenland WebGPU terrain and
procedural-asset runtime. New evidence and completed work are appended; older
observations remain in place so a later session can distinguish what was
believed, what was measured, and what changed.

## Operating rules

- Treat `flaskserver/client_debug.log` (also exposed at
  `http://localhost:5173/client_log.html`) as the primary runtime record.
- Correlate recordings by wall-clock filename and log timestamps before adding
  new probes.
- Do not repeatedly run the full test/build matrix while diagnosing a visual or
  timing defect. Use focused static/unit checks while editing, then one
  proportional verification pass at the implementation boundary.
- Keep procgen deterministic in absolute EPSG:3413 coordinates. Camera motion
  may change visibility, never placement or classifier identity.
- Checkpoint locally before architectural changes. Generated terrain databases,
  caches, recordings, and secrets do not belong in commits.

## Target architecture

The stable ownership chain is:

`best available imagery/DEM -> world-keyed classifier chunk -> baked albedo + placements -> retained GPU chunk -> visibility/LOD -> wind animation`

Classification, biome selection, and placement are area data. They run once for
a canonical world chunk and remain cached until the source identity,
`worldSeed`, or `procgenVersion` changes. Camera translation should retain the
overlap and add/remove only boundary chunks. A stationary camera should submit
wind/render work without rescanning candidate placement grids.

The currently compiled 768 m monolithic window can be improved safely in two
stages:

1. Stabilize the existing window: hysteretic/serialized target selection,
   cached CPU window samples, and dirty-driven visibility computes.
2. Replace whole-window buffer rewrites with retained canonical chunk slots.
   The initial practical chunk size is the existing 192 m snap cell because it
   preserves absolute placement and lets a move exchange one edge rather than
   rebuild the 768 m square.

## Evidence baseline — 2026-07-20 02:04 recording

Source: `/Users/projectatlantis/Desktop/Screen Recording 2026-07-20 at
02.04.50.mov`, 9.753 seconds, 1958x1138. Correlated log interval:
2026-07-20 02:04:49–02:05:04 local time.

- The clip starts during traversal and ends stationary at about 11 m AGL.
- Two complete procgen recenters finished 471 ms apart: `384:0` at 49.223 and
  `192:0` at 49.694. They cost 160.6 ms and 159.0 ms. This is target ping-pong,
  not a missing shader or a mere visibility update.
- Each recenter rewrote the same compiled 768 m slot. The first spent 61.6 ms
  in scatter; the second spent another 36.1 ms. The handoff therefore repeats
  classification/window assembly and persistent GPU-buffer mutation for areas
  that mostly overlap.
- The classifier is no longer hardcoded to depth 12. The first window used
  seven available depth-13 pages plus one depth-12 coverage fallback. The next
  used ten depth-13 pages plus the same fallback. Selection is correctly
  finest-first, but the moving monolithic window changes its required page
  mosaic at every snap.
- After traversal stopped, population and draw counts stabilized: 11,280 plant
  candidates, 16,754 rock candidates, 399 plants drawn, 3,264 rocks drawn and
  about 2.23 million vegetation triangles. Grass changed only from 20,643 to
  20,641 between diagnostics, consistent with the moving ground-ring camera
  quantization rather than population regeneration.
- The video still shows a hard near-terrain color/material region and a pale
  seam. Textured tiles now preserve their satellite albedo, but fine local
  geometry without its own texture still receives the generic procedural
  fallback while textured stale coverage can remain visible. This visual path
  is not yet a world-baked classifier albedo.
- JavaScript heap was approximately 2.3–2.5 GB and the terrain scene reached
  roughly 466 meshes during the interval. These are material performance
  constraints in addition to procgen compute cost.

## Task ledger

### P0 — stop recenter ping-pong

Status: **verified broken**.

- Add target hysteresis so predictive lookahead cannot snap the window across a
  boundary and immediately pull it back.
- Serialize/coalesce requested centers: while a recenter runs, retain only the
  newest valid target and never execute an obsolete intermediate target.
- Log requested/current/committed center plus the reason (`camera`, `lookahead`,
  or `source-refined`).
- Acceptance: no A->B->A recenter sequence while travel direction is unchanged;
  one boundary crossing produces at most one committed recenter.

### P0 — stop stationary placement-grid rescans

Status: **verified broken**.

- `GroundRing.update()` currently submits five compute kernels every rendered
  frame, scanning roughly 3.2 million candidate cells even when the camera and
  projection are unchanged.
- `Forests.update()` also clears, culls four layers, and rebuilds indirect draws
  every frame.
- Cache the last camera/projection/cascade inputs and submit visibility compute
  only when those inputs, the active slot, or an explicit visibility dependency
  changes. Wind remains vertex animation and must not invalidate placement.
- Acceptance: stationary diagnostics report zero repeated procgen-cull submits
  after the first settled frame while vegetation continues to animate.

### P0 — make near terrain world-anchored

Status: **partially fixed; still visibly broken**.

- Completed: textured meshes no longer receive moving classifier color or
  synthetic normal embossing.
- Remaining: never render a generic untextured fine material over textured
  stale coverage. Reuse a correctly transformed covering texture, use a baked
  world classifier albedo, or keep the child hidden until one is available.
- Acceptance: camera travel cannot reveal a circular/rectangular dark-green
  island, pale strip, or competing coplanar terrain surfaces.

### P1 — retained world-chunk cache

Status: **designed, not implemented**.

- Key chunks by canonical EPSG cell, source identities, `worldSeed`, and
  `procgenVersion`.
- Retain the neighborhood around the player and exchange only entering/leaving
  edge chunks.
- Persist classifier fields, sampled height data, species selections, and
  placement buffers for retained chunks.
- Acceptance: revisiting a retained chunk produces no classifier request,
  scatter pass, or placement-buffer rewrite.

### P1 — expose all 23 flora varieties honestly

Status: **data roster present; visual proof incomplete**.

- `GREENLAND_FLORA` contains 23 species records but maps them into only 16
  rendering classes; several species share a mesh class/variant family.
- Add per-species accepted/drawn histograms to the existing diagnostics so the
  log shows whether a species is absent because of classification, weighting,
  culling, season, or missing distinct geometry.
- Review the rock-heavy classifier response separately from species selection.
- Acceptance: the log accounts for every accepted plant by species and a debug
  view can demonstrate every available visual variety without changing normal
  world placement.

### P1 — performance and memory budget

Status: **measured, not resolved**.

- Current evidence: about 2.23 million vegetation triangles in the settled
  recorded view, 2.3–2.5 GB JS heap, and up to roughly 466 terrain meshes.
- Add cumulative counters for cull submits, skipped stationary submits, window
  cache hits/misses, and recenter work. These belong in `patch.diag` rather than
  a separate high-frequency logger.
- Reduce work based on measured ownership rather than hiding all detail during
  ordinary ground travel.

### P1 — vehicle/CSM traversal state

Status: **still broken; failed user acceptance**.

- Preserve the current restored-vehicle visibility fix, persistence-safe live
  verifier, and motion-aware CSM refresh limits in the baseline commit.
- Reassess vehicle behavior after procgen hitches are removed; the new recording
  shows procgen recenters consuming about 320 ms across two closely spaced
  commits. That hitch is a contributor, not an acceptance of the current drive,
  suspension, camera, or control feel.

### P2 — hosted ComfyUI enhancement

Status: **operator configuration implemented; product workflow not built**.

- `.env.example` keeps enhancement disabled by default and points to the local
  ComfyUI service.
- A hosted paid service still requires authenticated job creation, quotas,
  billing, isolation, and durable job state. It must not expose the raw local
  enhancement endpoint anonymously.

## Progress log

### 2026-07-20 — assessment opened

- Read the current recording and client log before running new verification.
- Confirmed depth-13 classifier selection is active.
- Confirmed back-to-back whole-window recentering is the dominant movement
  defect captured in the recording.
- Confirmed the next implementation should first stabilize and dirty-drive the
  existing compiled window, then replace it with retained canonical chunks.

### 2026-07-20 — vehicle status correction

- User validation explicitly reports that the vehicle still feels bad. The
  checkpoint preserves recent vehicle/CSM attempts but does not label the
  vehicle recovered.
- Vehicle acceptance remains open and must cover drive response, suspension,
  terrain contact, camera behavior, and traversal smoothness after the procgen
  double-recenter hitch is isolated.
