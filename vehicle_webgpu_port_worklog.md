# Vehicle WebGPU port worklog

Additive implementation ledger for porting the useful vehicle work from
`origin/vehicle_splitting` into the current Greenland WebGPU line.

This file is intentionally additive: keep completed entries and decisions in place,
append corrections with dates, and do not rewrite history to make the port look cleaner
than it was.

## Working state

- Destination branch at start: `godray-rework` (`9e4a0f2`)
- Source branch: `origin/vehicle_splitting` (`aaf6575`)
- Additional source tree: `/Users/projectatlantis/work/atlantis-terrain-server`, branch
  `vehicle_splitting` at `aaf6575` plus substantial uncommitted multi-definition/V-22 work.
- The branches have no merge base. Do not merge or transplant the old monolithic
  `webserver/main.terrain.js`.
- The destination working tree already contains parallel LAAS, cloud-dispatch, and Vite
  changes. Preserve those edits and keep this port scoped.
- Detailed source audit: `vehicle_splitting_port.md`

## Non-negotiable invariants

- Preserve current WebGPU terrain, atmosphere, CSM, LAAS, streaming, and vehicle behavior.
- Port runtime functionality, not only tests or disconnected helpers.
- Do not copy the old per-frame wheel vertex rewrite; rotate load-time wheel pivots and
  preserve position, normal, tangent, UV, index, and material data.
- Keep vehicle definitions data-driven. Patria node names belong in metadata, not renderer
  conditionals.
- Do not copy the WebGL `NormalPass` sprite-hiding workaround into WebGPU.
- Do not let multiple vehicles share ground-normal, snap-throttle, save-throttle, or
  persistence state.
- Use per-ID `PATCH /api/asset/:id` before claiming multi-vehicle persistence.
- Weapon effects must be validated against the WebGPU output/velocity/view-Z MRT and TAA.
- Vehicle shadow ownership must be explicit; avoid paying both local-detail shadows and
  unnecessary global CSM refreshes by accident.

## Source commits

- `765acda` — wheel spin animation (behavioral reference only)
- `12fb9d4` — turret, firing, and camera modes
- `0cb5bb1` — `VehicleEntry` registry (architecture reference; incomplete multi-vehicle state)
- `2a092d9` — part metadata plus WebGL-only sprite workaround

## Implementation board

- [x] Restore `VehicleParts`, `displayName`, `parts`, and
  `wheelClusterSplitThreshold` through types, sanitization, fallback data, and metadata.
- [x] Add reusable vehicle-part discovery with diagnostics for missing configured nodes.
- [x] Wire part discovery into the actual WebGPU GLB load path.
- [x] Split grouped wheel geometry once at load time and create independent pivots.
- [x] Expose wheel-center and bottom-contact transforms in terrain-local and world frames.
- [x] Animate wheel pivots from signed distance travelled / tire radius.
- [x] Add close, medium, and far follow-camera presets through current controls.
- [x] Port the vehicle control HUD and keep its labels synchronized with active state.
- [x] Port pointer selection: left-click selects, right-click selects and activates control.
- [x] Route enter/exit, movement, camera, and headlights only to the selected entry.
- [x] Route turret input only to the selected entry.
- [ ] Route future fire input only to the selected entry.
- [x] Preserve terrain/map selection behavior when the pointer does not hit a vehicle.
- [ ] Introduce a per-entry vehicle runtime without regressing the current Patria.
- [x] Port `vehicle_definitions` and per-instance `definitionId` through both servers and
  WebGPU startup normalization.
- [x] Port the local V-22 definition, model asset, hover flight, engine control, ground
  collision, aircraft camera modes, pitch/roll banking, and nacelle/rotor diagnostics.
- [x] Preserve both seeded entries (`amv-01`, `osprey-01`) and allow pointer selection of
  either loaded vehicle.
- [ ] Move ground/snap/camera/save state into each vehicle entry.
- [ ] Persist entries through `PATCH /api/asset/:id`.
- [ ] Add metadata/authored turret, gun, and muzzle transforms with logged fallbacks.
- [x] Add turret controls and crosshair through `terrain-controls.js` callbacks.
- [ ] Add WebGPU-native muzzle flash, tracers, and impacts; validate TAA behavior.
- [ ] Reuse/prebuild the gunshot audio graph instead of allocating it at 600 RPM.
- [ ] Feed wheel contacts into LAAS trample.
- [ ] Feed wheel contacts into interactive snow when that terrain work is stable.

## Progress log

### 2026-07-17 — audit and implementation start

- Confirmed the source branch has no WebGPU terrain entry and cannot be merged wholesale.
- Confirmed Patria GLB nodes: gun `Object_2`, turret `Object_3`, wheels
  `Object_8`/`Object_9`/`Object_10`.
- Confirmed the three wheel meshes contain 21,192 vertices total and carry normals,
  tangents, and UVs; position-only per-frame mutation would be incorrect.
- Confirmed current WebGPU already owns the better drive, suspension, terrain snap,
  orbit-camera, headlight, marker, local-shadow, and persistence foundation.
- Confirmed old registry leaks per-vehicle state through global ground normal, snap timing,
  and save timing, and saves every entry through the primary `/api/vehicle_state` endpoint.
- Began production port with the metadata contract and WebGPU part-discovery path.

### 2026-07-17 — metadata, discovery, and wheel runtime

- Restored the vehicle-parts metadata contract in both asset metadata files, the
  TypeScript asset server, and the Flask/Pydantic compatibility server.
- Added `webserver/terrain-vehicle-parts.js` and wired it into the real
  `main.webgpu.terrain.js` GLB callback. Missing authored nodes now produce a structured
  boot diagnostic instead of silently disabling features.
- Replaced the old branch's per-frame position-buffer mutation with a one-time indexed
  geometry split. Every split preserves normals, tangents, UVs, indices, material, render
  layers, and shadow flags; each resulting wheel moves through an Object3D pivot.
- The actual Patria layout resolves to eight pivots: `Object_8` = 3, `Object_9` = 3,
  and `Object_10` = 2. No triangle crosses a wheel-cluster boundary.
- Wheel angle now advances from signed distance (`vehicleSpeed * dt`) divided by the
  configured tire radius. This changes eight pivot rotations instead of rewriting 21,192
  source positions every frame.
- Added debug-only contact access through `takramDebug.getVehicleWheelContacts()`. Each
  wheel reports its center and tire-bottom contact in Three world/ECEF and terrain-local
  coordinates. No terrain/LAAS/snow consumer is attached yet.

## Verification log

Append build, typecheck, runtime, visual, and performance results here as each slice lands.

### 2026-07-17 — first production slice

- `assetserver`: `npm run typecheck` passed.
- Both metadata JSON files parsed and expose the same Patria part definition.
- Flask virtualenv: `VehicleDefinitionModel` validated the complete metadata payload.
- WebGPU production bundle: `npm run build` passed (361 transformed modules; only the
  existing chunk-size warning).
- Actual `patria_amv.glb` geometry test passed: 8 pivots, 17,232 indexed triangles,
  0 crossing triangles, 0 skipped meshes, and `position`/`normal`/`tangent`/`uv` retained.
- Signed wheel-angle and world/terrain-local tire-bottom contact calculations passed a
  deterministic transform check.
- `git diff --check` passed again after the complete wheel slice.
- Browser visual/runtime validation is still pending; do not mark the wheel slice visually
  accepted until the live WebGPU vehicle has been driven forward and backward.

### 2026-07-17 — selection and control UI scope added

- The first implementation board omitted the source branch's vehicle selection and control
  HUD. These are runtime functionality, not optional polish, and are now tracked explicitly.
- The port must preserve the current WebGPU control installer and map/terrain pointer flow;
  raw window listeners from the old monolithic renderer are behavioral reference only.
- Selection alone must not silently activate driving. The selected entry and the entry
  currently receiving movement input need explicit, inspectable state.

### 2026-07-17 — selected-vehicle controls wired into WebGPU

- Added a dedicated selected-vehicle panel with Drive, Exit, Camera, and Lights actions,
  live load/control/map status, speed, camera mode, vehicle identity, and control help.
- Preserved the source branch's right-click-to-enter behavior. A successful vehicle mesh
  raycast explicitly selects `amv-01` before control activation; a miss leaves flight and
  map behavior unchanged.
- Added non-activating left-click selection with a four-pixel drag threshold, so orbit
  drags do not accidentally select the vehicle. This supplies the panel's separate
  select-then-Drive flow without changing right-click entry.
- Added `selectedVehicleId` as a separate state boundary. The movement loop refuses to route
  WASD to a vehicle that is not selected, while Escape and the panel Exit action release
  control without discarding selection.
- Ported the source camera presets (`CLOSE` 15m/5m, `MEDIUM` 25m/8m, `FAR` 38m/12m) and
  routed `V` through `installTerrainKeyboardControls`. Scroll-wheel camera adjustment is
  labeled `CUSTOM`; the next `V` returns to a named preset.
- Kept the existing WebGPU `stepVehicleDrive` movement implementation. It already contains
  the source branch's steering, acceleration/braking, slope gravity, downhill roll, speed
  clamp, terrain resnap request, persistence throttle, and enhancement abort behavior.
- This is intentionally the current single loaded entry, not a false claim that the unsafe
  old multi-vehicle registry has been ported. Per-entry scene/snap/save state remains open.

### 2026-07-17 — turret control surface (no effects yet)

- Added load-time turret yaw and gun pitch pivots from the configured `Object_3` and
  `Object_2` meshes. The authored zero pose and complete source geometry are preserved.
- Added selected-vehicle-only `T`/panel turret entry, pointer-lock aiming, clamped pitch,
  yaw/pitch transform updates, third-person barrel camera, crosshair, and Escape precedence.
- Turret mode keeps WASD movement routed to the selected vehicle, while `V` camera cycling
  is suppressed until turret mode exits.
- Deliberately did not port the old SpriteMaterial muzzle flash/impact or MeshBasicMaterial
  tracer path yet. Those effects touched the old WebGL NormalPass workaround and still need
  native output/velocity/view-Z MRT and TAA validation before they enter WebGPU.

### 2026-07-17 — source correction: local Atlantis server has V-22 work

- The earlier audit treated `origin/vehicle_splitting` as the complete source. That was
  incorrect. The local `/Users/projectatlantis/work/atlantis-terrain-server` working tree
  contains uncommitted work after `aaf6575` that is not present in the remote branch.
- The local tree adds a plural `vehicle_definitions` map, per-instance `definitionId`, two
  seeded entries, registry construction for every returned instance, and a V-22 Osprey.
- The V-22 currently supports spawning, right-click activation, engine toggle (`E`), hover
  movement (`W/S`, `A/D`, Space/Q), gravity, auto-hover, ground collision, heading offset,
  pitch/roll banking, aircraft camera presets, and per-entry flight state.
- The V-22 source is explicitly WIP: transition/airplane mode, audio, textures, and usable
  nacelle/rotor animation are incomplete. Its GLB is material-grouped rather than split into
  physical parts, so the animation safety check intentionally rejects the configured meshes.
- The local registry is materially ahead of the remote branch but is not fully isolated:
  ground normal, snap throttle, save throttle/failure state, camera orbit, scratch vectors,
  and the active detail-shadow system remain shared globals. We should port its working
  multi-definition/aircraft behavior while finishing those boundaries in WebGPU rather than
  copying either the remote registry or the local globals wholesale.

### 2026-07-17 — selection/control slice verification

- WebGPU production bundle passed with 363 transformed modules after the turret slice.
- All 53 existing WebGPU/shared runtime tests passed.
- Deterministic keyboard routing confirmed `V` reaches the vehicle-camera callback through
  the installed controls path.
- Browser acceptance remains: right-click selection, Drive/Exit buttons, forward/reverse,
  steering, all three camera modes, custom scroll zoom, lights, Escape, and map-mode A/B.
- Actual Patria turret geometry check passed: yaw and pitch pivots present, zero warnings,
  zero-pose bounding-box delta `0`, and a finite transformed muzzle position.
- Turret keyboard precedence check passed: `V` is suppressed while aiming, first Escape
  exits turret rather than vehicle, then `V` and `T` route through their callbacks.

### 2026-07-17 — plural vehicle contract and V-22 asset landed

- Added schema-v5 `vehicle_definitions` support while retaining the singular Patria
  definition as a compatibility path. Instances and stored vehicle properties now preserve
  `definitionId`.
- Added strict sanitization for aircraft type, flight tuning, model/heading rotation,
  nacelle tuning, centers, and nacelle/rotor part names. This fixes the local source patch's
  accidental loss of those part fields at the server boundary.
- Changed vehicle seeding from "only if there are no vehicles" to idempotent per-seed
  insertion. Existing AMV databases gain `osprey-01`; existing vehicle rows and positions
  are not replaced.
- Added the local V-22 definition and both definition-aware seeds to the TypeScript and
  Flask metadata files. Copied `v22_osprey.glb` byte-for-byte (SHA-256
  `138e5d78a091fa94a5c9990c3cffb792743f9731733d1fc28a525befcbe3f68c`).
- The shared startup loader now preserves the plural catalog. Asset-server typecheck,
  metadata parsing, all 53 shared tests, and targeted `git diff --check` pass.
- Runtime rendering/control of the new aircraft is the next slice. Catalog presence alone
  is not being counted as a completed V-22 port.

### 2026-07-17 — WebGPU multi-entry/V-22 runtime slice

- The WebGPU scene now constructs a registry entry for the ground vehicle and every
  definition-aware aircraft instance returned by the server. Both entries own their scene
  group, model meshes, marker, load state, spatial/flight state, and aircraft persistence
  throttle.
- Pointer selection now ray-tests all loaded entries and chooses the nearest hit. A changed
  selection releases the previously controlled entry before routing Drive/right-click to
  the new selection.
- Ported the local V-22 hover behavior: `E` engine, `W/S` forward/reverse hover movement,
  `A/D` yaw, Space/Q climb/descend, engine-off gravity, auto-hover damping, terrain floor,
  pitch/roll presentation, heading offset, V-22 camera presets, markers, HUD/control-panel
  identity, and an aircraft Engine button.
- Aircraft saves use the per-ID `PATCH /api/asset/:id` endpoint. This avoids the local
  source's shared "primary vehicle" save target for the new entry. CSM movement invalidation
  now observes every loaded registry transform instead of only the Patria group.
- The aircraft part setup keeps the source safety boundary: the current material-grouped GLB
  is rendered intact and the oversized nacelle/rotor candidates are not destructively
  reparented. Physical nacelle/rotor animation still requires a split model asset.
- Production bundle, asset-server typecheck, Flask compile, targeted diff check, and all 54
  shared tests pass.
- Live temporary-database/API check passed: schema 5 returned both definitions and both
  instances; Vite served the exact 6,253,612-byte V-22 GLB.
- Live Brave WebGPU check passed for registry/model boot with no boot errors. `osprey-01`
  selection, control activation, engine start, and forward movement produced a finite
  position/speed change. Switching selection to `amv-01` also left the AMV selected and
  control-active; the longer timed interaction callback was delayed by the very slow
  headless full-scene render, so this does not replace an eventual normal-window visual pass.

### 2026-07-18 — genuine per-entry ground registry and WebGPU firing

- Replaced the Patria's persistent module-level movement/snap/save/camera/turret/wheel state
  with `createGroundVehicleState` entries stored directly in the shared vehicle registry.
  Every returned ground instance now receives its own scene group, model, mesh collection,
  terrain contact state, suspension, orientation target, wheel and turret rigs, headlights,
  camera orbit, firing cadence, and persistence throttle/failure state.
- Made ground model loading definition-driven and applied it to every ground registry entry.
  Terrain resnap, suspension, wheel spin, turret transforms, marker updates, caster movement
  invalidation, selection, control routing, HUD status, and debug inspection now iterate or
  resolve registry entries instead of assuming one AMV.
- Removed the WebGPU main view's dependency on the legacy primary-vehicle
  `/api/vehicle_state` save route. Ground and aircraft entries now persist through their own
  `PATCH /api/asset/:id` endpoint. Ground saves retain terrain depth/tile affinity.
- Added authored Patria turret yaw pivot, gun pitch pivot, and muzzle coordinates to both
  server metadata catalogs and preserved them through TypeScript, Flask, and browser
  sanitizers. Runtime derivation remains a compatibility fallback and is explicitly warned.
- Added a WebGPU-native firing runtime. Muzzle flash, tracers, and impacts use preallocated
  `MeshBasicNodeMaterial` pools; no old WebGL normal-pass visibility workaround or per-shot
  mesh/material allocation is present. Fire cadence is per registry entry, tracers stop at
  the actual aim hit/range, and the reusable Web Audio graph is primed from the trusted input
  event.
- Added firing callbacks to the shared pointer controls and routed them only while the
  selected ground entry has active turret control. Pointer-lock loss, blur, turret exit, and
  vehicle exit all release held fire.
- Aircraft follow-camera zoom is now independent state (`cameraZoom`) rather than the
  ineffective same-ratio distance/height pitch rewrite.
- Deterministic verification: all 55 shared tests pass, including a native node-material
  pool/cooldown/lifetime firing test. The WebGPU production build (365 modules), asset-server
  TypeScript check, Flask compile, and `git diff --check` pass.
- Live verification used an isolated database containing `amv-01`, `amv-02`, and
  `osprey-01`. All three models loaded. Both Patria entries reported complete, warning-free
  authored turret rigs. Driving each ground entry separately changed its own transform while
  the other entries remained independently addressable; the V-22 stayed unchanged. A live
  turret shot produced one muzzle flash, tracer, and terrain impact from node-material pools.
- The live headless scene remains too slow for trustworthy visual-quality acceptance and
  caused its own 1.5-second persistence requests to time out while frames blocked the page.
  Those timeouts are recorded as a harness/performance limitation, not hidden as a pass.
  Normal-window visual acceptance of muzzle/tracer/impact appearance is still required.

### 2026-07-18 — V-22 propeller geometry repaired and animated

- Headless Blender inspection proved the old `leftRotor`/`rightRotor` metadata was wrong:
  both pointed at `Object_9`, a material bucket containing scattered trim, cockpit, and
  exterior pieces rather than either propeller. The actual blades and spinners were
  separable connected components distributed across `Object_5` and `Object_7`.
- Added the reproducible, source-hash-guarded generator
  `webserver/tools/rig_v22_rotors.py`. It preserves the original GLB, extracts only geometry
  inside the measured rotor discs, joins each side across its original materials, places
  origins at the measured hubs, exports a replacement GLB, re-imports it, and rejects any
  polygon-count, name, pivot, per-rotor geometry, or embedded-texture hash mismatch. All 17
  embedded PNG payloads remain byte-for-byte identical to the source asset.
- Generated `webserver/public/models/v22_osprey_rotors.glb` while preserving the original
  `v22_osprey.glb`. Total source geometry remains 102,326 polygons; each new rotor contains
  2,622 polygons. The generated asset SHA-256 is
  `97dc6bce041eb7cfc5b030813ba77478aa22f8d0fb3462b1311ff6b5dac82f28`.
- Updated both metadata catalogs to load the repaired asset and resolve the distinct
  `V22_Rotor_Left` and `V22_Rotor_Right` objects. Added sanitized rotor-axis, RPM, and
  response-time configuration to both server contracts.
- Completed the runtime setup boundary so it assigns the two resolved rotor meshes. Rotor
  animation uses the asset's correct local Y axis, counter-rotation, configured 397 RPM,
  and exponential engine spool-up/coast-down rather than the old instantaneous Z rotation.
- Verification: all 56 shared tests pass, including distinct rotor assignment, axis,
  counter-rotation, spool-up, and coast-down. WebGPU production build, asset-server
  typecheck, Flask compile, metadata parsing, and diff checks pass.
- Live Brave WebGPU verification loaded both named meshes. Starting the engine through the
  real `E` control path advanced the rotor angle and raised angular velocity from 0 to
  15.25 rad/s; engine shutdown decayed it to 1.46 rad/s. The remaining material-merged
  warning now concerns nacelle tilt only, not propeller animation.

### 2026-07-18 — game-focused VTOL flight model (implemented)

Checkpoint before this slice: `bd1c155` (`Checkpoint WebGPU terrain and vehicle port`).

- [x] Preserve `E` as engine start/stop; engine start only spools the rotors and never
  launches the aircraft by itself.
- [x] Replace Space/Q scripted climb/descent and automatic hover with a persistent
  collective control. Lift must depend on collective and actual rotor spool.
- [x] Replace speed-triggered nacelle automation with explicit, approachable transition
  control while keeping safe rate limits and useful game assists.
- [x] Blend hover and airplane behavior: rotor-vector thrust at low speed, wing lift at
  forward speed, gravity/drag throughout, and responsive pitch/yaw/roll presentation.
- [x] Keep W/S, A/D, Space/Q, E, V, Escape, selection, entry/exit, camera, and persistence
  behavior compatible with the vehicle port wherever their meanings remain appropriate.
- [x] Add HUD/debug feedback for collective, rotor spool, nacelle angle, vertical speed,
  airspeed, and the current GROUND/HOVER/TRANSITION/AIRPLANE regime.
- [x] Add deterministic tests for grounded spool-up, collective takeoff, hover stability,
  collective descent, transition thrust/lift blending, engine-out gravity, and control
  isolation.
- [x] Run the complete shared test suite, WebGPU production build, server typecheck, Flask
  compile, metadata parse, and final diff checks before calling the slice complete.

Implementation notes:

- `E` now controls only engine state and governed rotor spool. Space/Q raise and lower a
  persistent collective; takeoff requires both sufficient collective and actual rotor RPM.
- `F` toggles the pilot's hover/cruise request. A conversion schedule holds 68 degrees of
  nacelle angle until useful airspeed exists, then blends toward airplane mode instead of
  letting a single keypress dump all vertical thrust at zero speed.
- Vertical force now combines rotor support (`RPM² × collective × nacelle direction`),
  forward-speed wing support, gravity, drag, climb/descent limits, and a deliberately broad
  neutral-collective hover assist. Physics is integrated in bounded substeps so the flight
  model remains stable even while the main renderer is running at a low frame rate.
- W/S retains the port's approachable forward/back intent, A/D retains turn intent, and
  their acceleration/yaw/bank response blends between hover and cruise. This is deliberately
  game-realistic rather than a cockpit-level V-22 simulator.
- Extended the reproducible Blender rig to extract two 8,267-polygon nacelle assemblies,
  pivot them at the measured rotor hubs, and parent the repaired rotors to them. The export
  retains all 102,326 source polygons and every embedded texture. Current generated GLB:
  `d5d03fe64d769718b3d6fedf5a636d170d21656f554b50a93dbd5d3d413e1870`.
- A full-scene live load caught that glTF represents each multi-material nacelle as a named
  pivot node containing mesh primitives. The resolver now accepts those nodes, excludes the
  rotor children from its old oversized-material safety check, and has a matching hierarchy
  regression test. The same live page confirmed the aircraft position remained unchanged at
  its pre-test coordinates because collective was never raised.
- Final verification passed: 64 shared tests, the 365-module WebGPU production build,
  asset-server TypeScript checking, Flask compilation, both metadata parses, and
  `git diff --check`.

## 2026-07-19 — vehicle recovery board (authoritative correction)

This section supersedes the completion claims above where they conflict with live visual
feedback. The earlier tests proved that code executed and matched its own expectations; they
did not prove that Patria handling, V-22 controls, camera behavior, rotor motion, materials,
or firing retained the accepted gameplay. Do not mark an item below complete from unit tests
or headless state alone.

### What "performance" means in this recovery

There are two separate problems. They must not be conflated:

1. **Full-scene rendering cost.** `PERF_REWORK.md` owns this track. Its current measured
   stationary 2560x1440 frame is about 36 ms: cloud march about 10.7 ms, LAAS vegetation
   about 9.8 ms (about 5.8 ms in casters), and GTAO/contact about 6.7 ms. Movement can stack
   CSM refreshes, beer-shadow compute, tile streaming, and wholesale LAAS recenter work in
   the same frame. The vehicle recovery will not reduce vegetation quality, shadow quality,
   resolution, materials, or view distance to disguise this cost.
2. **Gameplay time under a slow renderer.** Both the old working WebGL application and the
   current WebGPU application use `Math.min(0.05, clock.getDelta())`. This clamp dates to the
   initial February 2026 code; it was not introduced by the vehicle port. It prevents a huge
   movement jump after a tab pause or loading stall, but below 20 fps it causes slow motion.
   Do not alter it during behavioral restoration. First restore WebGL parity and address the
   rendering regression. Only then evaluate a shared fixed-step game clock at forced 60,
   15, and 5 fps. A fixed step may fix time dilation; it cannot fix visible rendering lag.

The isolated vehicle scene is permitted for diagnosis of models, axes, materials, and input.
It is not final acceptance. Final acceptance must also pass in the complete WebGPU scene with
all production graphics enabled.

### Verified architecture and source of truth

- The local `integration/webgpu-restoration` branch demonstrates the intended architecture:
  `main.js` and `main.webgpu.js` both start `terrain-application.js`; only the backend value
  changes. Vehicle gameplay did not require a WebGPU rewrite.
- The current `godray-rework` branch descends from the older grafted WebGPU tree and again
  contains separate `main.terrain.js` and `main.webgpu.terrain.js` applications. This allowed
  gameplay and UI to diverge.
- The local, uncommitted
  `/Users/projectatlantis/work/atlantis-terrain-server` `vehicle_splitting` working tree is
  the behavioral source for Patria movement, suspension/grounding, wheel motion, turret,
  firing, camera, selection, and the original V-22 control contract.
- Renderer-independent gameplay must be shared. WebGPU-specific code is allowed only at a
  demonstrated material/render-pass incompatibility, after the original path is tried.

### Confirmed implementation errors

- [x] The V-22 rotor geometry lies in local XY, so the shaft/spin axis is local **Z**. The
      current metadata/test expectation of `rotorAxis: "y"` is wrong and makes the blades
      tumble.
- [x] The V-22 nacelles extend along local Z and must convert about the wing axis **Y**. The
      current `tiltAxis: "z"` is wrong. The conversion sign must be verified at static hover,
      transition, and cruise poses before flight testing.
- [x] The rigged GLB preserves 17 embedded cockpit/instrument images, but the five exterior
      `DefaultWhite` body meshes still have no body PBR maps. The missing 4K albedo, normal,
      roughness, metallic, glass diffuse, and glass roughness masters remain under the local
      Atlantis server's `webserver/public/models/v22_textures/` directory.
- [x] The Patria port replaced the accepted vertex-cluster wheel animation with a new
      load-time geometry split/pivot rig, then collected the replacement animated meshes for
      collision raycasts. This is not behavioral parity and is an unnecessary variable in
      grounding.
- [x] The old firing path was not first tested unchanged under `WebGPURenderer`; it was
      replaced preemptively with a new node-material pool because of an assumed NormalPass
      incompatibility. That assumption is not visual acceptance evidence.
- [x] Bare `R` invokes the global destructive reset. Required behavior is no bare reset key;
      provide a small out-of-the-way Reset View UI action with confirmation.

### Rollback safety

- Existing local commit: `bd1c155` (`Checkpoint WebGPU terrain and vehicle port`). It already
  includes the first WebGPU firing rewrite, registry changes, Patria changes, and first rotor
  rig. It is not a clean pre-port baseline.
- The game-focused VTOL, persistent collective, manual `F` conversion, expanded nacelle rig,
  and later UI/server changes remain uncommitted after `bd1c155`.
- [ ] Before implementation, create a new local checkpoint containing only the current
      vehicle/server/model/worklog files and vehicle-related hunks from the mixed WebGPU main
      file. Do not stage parallel LAAS, terrain, cloud, shadow, or post-processing changes.
- [ ] Tag or branch that checkpoint clearly so the exact current state can be restored
      without resetting the shared working tree.

### Recovery milestones

#### 1. Record the accepted behavior before porting

- [ ] Record the local WebGL Patria constants, key routing, movement integration, terrain
      probes, suspension, camera, wheels, turret, firing cadence/effects, and entry/exit flow.
- [ ] Record the original V-22 contract: `E` engine, `W/S` forward/back, `A/D` turn,
      `Space/Q` climb/descend, automatic speed-based nacelle conversion, `V` camera, `Esc`
      exit. Do not retain the unapproved `F` conversion toggle.
- [ ] Capture an accepted WebGL reference run and telemetry for a repeatable Patria route:
      position, heading, speed, ground target, suspension Z, and camera pose.

#### 2. Restore Patria parity before optimizing it

- [ ] Make WebGPU call the same renderer-independent Patria gameplay functions used by the
      WebGL path. Do not maintain a second WebGPU movement model.
- [ ] Restore the accepted wheel animation and keep visual wheel transforms out of the
      grounding collider.
- [ ] Restore the accepted terrain-contact, suspension, slope, camera, turret, and entry/exit
      behavior without tuning constants.
- [ ] Replay the reference route in both backends. Positions, speed, heading, grounding, and
      camera must match within documented tolerances before any cleanup or optimization.

#### 3. Restore firing and animations by evidence

- [ ] Run the original firing implementation unchanged under WebGPU first: muzzle flash,
      tracer, impact, audio, pointer-lock aiming, cadence, and exit cleanup.
- [ ] If a specific material or render pass actually fails, adapt only that boundary and
      document the failing screenshot/error and the smallest fix. Do not replace the entire
      firing system speculatively.
- [ ] Visually compare the Patria wheel, turret, gun, muzzle, tracer, and impact animation
      against WebGL. Headless object counts are insufficient.

#### 4. Repair the V-22 without another Blender round-trip

- [ ] Use the existing separated GLB geometry and patch the authoritative metadata/runtime
      to nacelle tilt axis Y and rotor spin axis Z.
- [ ] Validate model-space static poses with axis helpers: hover, mid-transition, and cruise.
      Confirm the conversion sign, both hub pivots, rotor parenting, and counter-rotation.
- [ ] Restore the original game-friendly controls and automatic transition before adding
      any new lift model. Engine spool may remain visual, but must not redefine the controls.
- [ ] Add the existing 4K body/glass PBR masters without Blender: preserve cockpit maps,
      bind sRGB albedo, normal, correctly packed metallic/roughness, and transparent glass to
      the rigged model's existing UVs.
- [ ] Accept only after takeoff, hover, forward travel, automatic transition, landing,
      camera, textures, nacelles, and rotors are visually correct in the full WebGPU scene.

#### 5. Replace the vehicle control panel with an informational HUD

- [ ] Remove Drive/Exit/Camera/Lights/Turret/Engine/Convert action buttons.
- [ ] Show actual speed and the keys to press. Ground HUD target:
      `PATRIA AMV | 42 km/h | W/S drive | A/D steer | V camera | L lights | T turret | Esc exit`.
- [ ] Aircraft HUD target includes km/h and knots, vertical speed, and the accepted keys.
- [ ] Before control is active, show selection/entry hints only: left-click select,
      right-click enter.
- [ ] Remove bare `R`. Add a small Reset View action outside the vehicle HUD, require
      confirmation, and list exactly which saved camera/tuning/time state it clears.

#### 6. Restore discoverability and navigation

- [ ] Make Patria and V-22 markers visible and selectable in the existing `M` map without
      changing their persisted positions.
- [ ] Restore the corrected local WebGPU Google navigator from `bfc54ba`, `dc9be26`, and
      `e212b5a`, including explicit Navigate and exact WGS84-to-EPSG:3413 placement.
- [ ] `G` toggles the navigator. Map selection must not move the camera until Navigate is
      explicitly activated.

#### 7. Performance and final acceptance gates

- [ ] Record stationary warmed full-scene FPS/frame time with vehicles hidden and visible;
      the delta identifies vehicle-specific render cost without blaming the vehicle for the
      known cloud/LAAS/post costs.
- [ ] Record the same Patria route at normal WebGL and WebGPU performance. Do not change the
      historical `0.05` clamp during this comparison.
- [ ] After rendering performance is healthy, force 60/15/5 fps and decide whether a shared
      fixed-step gameplay clock is needed. If implemented, tab resume must not teleport,
      gameplay must not enter slow motion, and both renderers must use the same clock.
- [ ] Final visual sign-off must cover Patria handling/grounding/camera/firing, V-22
      controls/camera/materials/nacelles/rotors, both map systems, HUD hints/speed, and reset
      safety. Tests/builds support this sign-off but cannot replace it.

### Explicit non-goals during vehicle recovery

- No shadow-resolution changes, vegetation-density cuts, LOD removals, material removals,
  view-distance reductions, or other graphics shortcuts.
- No new VTOL control scheme, firing rewrite, wheel-rig rewrite, or camera redesign before
  accepted WebGL behavior is restored.
- No wholesale shared-application merge while parallel terrain/graphics work is active.
  Share the vehicle gameplay boundary first; schedule broader application consolidation as
  a coordinated follow-up so it cannot overwrite active renderer work.

## 2026-07-19 — recovery implementation and verification result

The recovery board above was executed without changing the graphics quality settings or the
historical render-loop delta clamp.

### Safety and source parity

- Created full-tree safety ref `safety/vehicle-pre-recovery-20260719` at
  `fab5ddde272e9f807b2416de34fe72802a17ce1c`.
- Created selective vehicle checkpoint `97775d0` before recovery. Parallel LAAS/cloud/shadow
  work was not reset or overwritten.
- Compared the live local `vehicle_splitting` implementation function-for-function. Patria
  acceleration (24 m/s²), max speed (24 m/s), braking (3 m/s²), steering (1.5 rad/s), slope
  gravity, terrain probes, suspension, follow camera, turret transforms, and entry/exit flow
  retain the same math/constants through the renderer-independent helpers.

### Patria restored

- Restored the original vertex-cluster wheel animator. It mutates the original GLB wheel
  geometry exactly like `vehicle_splitting`; it no longer replaces grouped wheels with newly
  split pivot meshes.
- Grounding now raycasts only the static non-wheel body meshes. Visual wheel rotation cannot
  move the collision floor or make Patria bob as the vertices spin.
- Restored the accepted CanvasTexture sprite muzzle flash and impacts, classic
  `MeshBasicMaterial` tracer, original dimensions/colors/lifetimes/range, procedural gunshot
  sound, camera-center aiming, cadence, pooling, and cleanup. WebGPU live validation created
  muzzle, tracer, and impact effects with no node material substitution.

### V-22 restored

- Removed persistent collective and manual `F` conversion. Controls are again `E` engine,
  `W/S` forward/back, `A/D` yaw, `Space/Q` climb/descend, `V` camera, `Esc` exit.
- Automatic nacelle scheduling is driven by the configured 30–50 m/s transition band. The
  old hover-speed clamp made that band unreachable, so forward acceleration now correctly
  continues toward `maxSpeedMs` while conversion remains automatic.
- Corrected the rig from measured GLB geometry: nacelles rotate about local Y with negative
  conversion sign; propellers counter-rotate about local Z. Current server metadata and
  runtime defaults both enforce the correct axes even if a watch server has stale code.
- Copied all six source PBR masters byte-for-byte into
  `public/models/v22_textures/`: body albedo, normal, roughness, metallic, glass diffuse, and
  glass roughness. Runtime binding targets only exact `DefaultWhite` and `Transparent`
  materials, preserving all 17 cockpit/instrument materials and embedded maps.
- Aircraft follow camera now writes the same yaw/pitch control state as the accepted Patria
  camera, preventing the next camera update from snapping to a stale orientation.

### UI and maps restored

- Vehicle HUD is informational only: zero action buttons, actual km/h, aircraft knots and
  vertical speed, and the keyboard contract in one line. It sits above the existing bottom
  status row.
- Bare `R` is inert. `Reset view` lives inside the Atmosphere header and requires confirmation.
- Restored the corrected WebGPU Google navigator from the local restoration commits:
  `G` toggle, Satellite/Map tabs, explicit point selection followed by `Navigate`, exact
  WGS84 ↔ EPSG:3413 placement, and Google 3D camera links.
- `M` map includes both `vehicle-marker-amv` and `vehicle-marker-osprey-01`; marker children
  disable frustum/depth loss so they remain discoverable.

### Verification evidence

- `node --test *.test.js`: **72/72 passing** after the final wheel parity test.
- `npm run build`: production Vite build passes (370 modules).
- `assetserver npm run typecheck`: passes.
- `git diff --check`: passes.
- Full production WebGPU scene in headless Brave, with no graphics ablations:
  - both Patria and V-22 loaded; no boot errors;
  - V-22 live input reached 48.78 m/s and `TRANSITION`;
  - nacelles were `Y=-0.30879`, rotors were spinning/counter-rotating on Z;
  - exterior materials reported albedo + normal + roughness + metallic and glass diffuse +
    glass roughness maps by their source filenames;
  - bare `R` preserved the stationary rendered coordinate;
  - `G` opened the navigator;
  - classic firing produced one active muzzle/tracer/impact set;
  - `M` made both vehicle markers visible;
  - vehicle HUD contained zero buttons and displayed speed/key hints.
- The only browser error during scripted firing was the expected browser security rejection
  for pointer lock without a real user gesture. Actual pointer interaction is the trusted
  path and remains wired; this was not a render or gameplay exception.

### Separate performance track left intact

The complete headless WebGPU page still took minutes to reach the acceptance state. No
vegetation, shadows, clouds, materials, resolution, or view distance were reduced. That is
the existing full-scene render/streaming problem owned by `PERF_REWORK.md`, not a reason to
change vehicle behavior. The historical `Math.min(0.05, clock.getDelta())` also remains
unchanged pending a coordinated shared fixed-step decision after rendering performance is
healthy.

### 2026-07-19 — live-verifier persistence correction

- The first acceptance script used the real movement and persistence path, so its V-22
  transition runs unintentionally saved test positions to the live asset database. This was
  a validation-harness defect, not a renderer visibility result.
- Restored both records to the exact states captured before the first acceptance run:
  Patria `64.18867881, -51.68565638`, heading `275.095`, Z `70.644`; Osprey
  `64.18990439, -51.68699431`, heading `169.456`, Z `613.043`.
- Added boot-only `?vehiclePersistence=0`. The live verifier now forces this flag while still
  exercising real movement, controls, visuals, maps, and firing. Normal production sessions
  retain persistence by default.

### 2026-07-19 — restored-vehicle visibility correction

- Live inspection confirmed Patria loaded all nine meshes but started with its root group
  explicitly hidden while it waited for the saved terrain depth. In a heavily loaded scene,
  that streaming wait made the physical vehicle appear permanently missing.
- Restored vehicles now render immediately at their persisted Z, which is already part of the
  saved state. The existing terrain-depth gate and initial-snap path remain active and refine
  ground contact when the requested tile arrives; no terrain fidelity was removed.
- The live verifier now fails if any loaded vehicle has an invisible group or zero meshes, so
  this specific disappearance cannot pass acceptance again.

### 2026-07-19 — WebGPU traversal hitch correction

- Direct comparison against the local `atlantis-terrain-server` `vehicle_splitting` working
  tree confirmed that Patria drive integration, suspension, terrain-contact cadence, and
  chase-camera transforms already match the fun WebGL reference. Those values remain intact.
- The WebGPU-only CSM policy was treating every 5 cm of controlled-vehicle travel as an
  urgent near-cascade invalidation. At normal Patria speed this forced a complete near shadow
  render on essentially every displayed frame, a cost that does not exist in the reference.
- During active traversal, near-cascade camera drift now gets an eight-texel window and
  vehicle-only invalidation is capped at 10 Hz. Stationary camera/sun/stream/recenter policy
  remains unchanged; TAA and contact shadows cover the small moving-shadow latency.
