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
