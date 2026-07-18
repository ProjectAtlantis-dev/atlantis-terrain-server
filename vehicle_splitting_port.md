# `vehicle_splitting` port audit

Read-only audit of `origin/vehicle_splitting` against the current Greenland WebGPU line.
The old branch has unrelated Git history, so it must not be merged wholesale. Port the
features deliberately into the current modular architecture.

## Decision

Wait on interactive snow, LAAS water, and volumetric-cloud integration until the active
terrain/procgen/CSM work settles. Those systems touch the same heightfield, materials,
postprocessing, and frame loop.

The strongest isolated port target is the vehicle stack. In particular, proper vehicle
part discovery and wheel contact points will provide inputs needed later for vegetation
trample and snow tracks.

## Relevant old commits

- `765acda` — wheel spin animation based on vehicle speed
- `12fb9d4` — Patria AMV turret, .50-cal firing, and vehicle camera modes
- `0cb5bb1` — `VehicleEntry` registry refactor
- `2a092d9` — hide weapon sprites during the WebGL `NormalPass`
- `1e6fc45` — Google Maps navigation panel and click-to-travel
- `25a7172` — correct pass-one tile loading around the moving camera
- `aeb4b93` — unified assets table and restored two-pass tile loading
- `6d7ed6e` — standalone asset server and unified asset schema

## Missing vehicle-definition metadata

The old branch added the following contract:

```json
{
  "displayName": "Patria AMV",
  "parts": {
    "wheels": ["Object_8", "Object_9", "Object_10"],
    "turret": "Object_3",
    "gun": "Object_2",
    "body": ["Object_4", "Object_5", "Object_6"],
    "shield": ["Object_7"]
  },
  "wheelClusterSplitThreshold": 3500
}
```

These fields are missing from the current:

- `assetserver/src/types.ts`
- `assetserver/src/server.ts` sanitization and fallback vehicle definition
- `assetserver/assets_metadata.json`
- `flaskserver/assets_metadata.json`

`webserver/terrain-startup-assets.js` already shallow-copies `vehicle_definition`, so it
will preserve the added fields once the asset server returns them.

Port the old `VehicleParts` type, `displayName`, `parts`, and
`wheelClusterSplitThreshold`, including validation. Treat model node names as data rather
than hard-coding Patria-specific names in the renderer.

## `VehicleEntry` registry

The old branch replaced most global Patria state with a `VehicleEntry` object containing:

- identity and definition
- scene group, model, meshes, lights, and map marker
- wheel, turret, gun, and muzzle references
- terrain snap and suspension state
- heading, speed, and control state
- camera mode and turret state
- per-instance dimensions and shadow radius

This architecture is missing from current WebGPU, which still consumes only the first
vehicle instance and stores most state in globals.

### Important limitation in the old implementation

It was multi-vehicle-ready, not truly multi-vehicle end to end:

- Only one Patria entry was initially created.
- The asset response still exposed one shared `vehicle_definition`.
- All registry entries saved through `POST /api/vehicle_state`.
- That endpoint resolves the primary vehicle internally, so a second vehicle could save
  over the primary vehicle.

Do not copy that persistence behavior. Use the existing generic
`PATCH /api/asset/:id` route for per-vehicle state, including spatial fields and vehicle
properties. Refactor `createVehiclePersistenceRuntime` so each entry owns an ID-specific
endpoint or save callback.

For multiple vehicle types, the asset schema will eventually need definitions keyed by a
definition/type ID. The old branch did not complete that part.

### Recommended module boundaries

Do not transplant the old monolithic `main.terrain.js`. Extract the functionality into
modules such as:

- `terrain-vehicle-registry.js`
- `terrain-vehicle-model.js`
- `terrain-vehicle-camera.js`
- `terrain-vehicle-weapon.js`

Keep the existing pure drive, suspension, snapshot, and persistence helpers in
`terrain-vehicle.js` and generalize them where necessary.

## Wheel animation and contact points

The old branch discovers configured wheel meshes and clusters their vertices by local
position. Its animation then rewrites every clustered vertex position on every frame.

Do not port that animation literally. Problems include:

- CPU cost proportional to wheel vertex count every frame
- continuous GPU position-buffer uploads
- normals and tangents are not rotated with positions
- geometry bounds are not reliably updated
- lighting and frustum culling can become incorrect

### Correct port design

1. Discover configured wheel nodes during GLB loading.
2. If multiple wheels share one mesh, split the clusters into separate wheel meshes once
   at load time while preserving positions, normals, tangents, UVs, skin/index data where
   applicable.
3. Create a pivot `Object3D` at each wheel center.
4. Rotate the wheel pivots using distance travelled divided by tire radius.
5. Expose each wheel's world/ENU position and bottom contact point.

The contact output should be designed as a reusable runtime interface:

```text
vehicle wheel pivots
        -> world/ENU contact points
        -> vegetation trample
        -> snow compression and tire tracks
        -> later wheel collision/suspension probes
```

This is a prerequisite-quality improvement for interactive snow rather than merely a
visual wheel-spin effect.

## Vehicle camera modes

The old turret commit added close, medium, and far follow-camera presets, cycled with
`V`. Current WebGPU has only one follow distance and height.

Port the presets after camera/control state belongs to the active `VehicleEntry`. This is
relatively isolated from terrain rendering, vegetation, snow, and CSM work.

## Turret and weapon system

The old branch contains:

- metadata-selected turret and gun meshes
- turret-yaw and gun-pitch pivots
- pointer-lock mouse aiming
- turret follow camera and crosshair
- 600 RPM fire control
- camera-center raycast aiming with muzzle-origin shots
- pooled tracers and impacts
- muzzle flash
- procedural gunshot audio

The overall interaction design is reusable, but several implementation details need to
be replaced.

### Pivot calculation

The old implementation estimates pivots by averaging mesh vertices and estimates the
muzzle from the maximum-Y gun vertex. This may work for the current Patria model but is
not a reliable general vehicle contract.

Prefer, in order:

1. authored pivot/muzzle nodes in the GLB;
2. explicit pivot and muzzle transforms in vehicle metadata;
3. vertex-derived estimates only as a logged fallback.

### WebGPU effects

The `2a092d9` black-square fix wraps the WebGL `NormalPass` and temporarily hides muzzle
and impact sprites because `THREE.Sprite` corrupted its normal buffer.

Do not carry that workaround blindly into the active WebGPU renderer. WebGPU uses a TSL
MRT/postprocessing path with output, depth, velocity, and view-Z data. Implement muzzle,
tracer, and impact materials for WebGPU and validate their participation in those buffers.
The old `NormalPass` wrapper is only relevant to the WebGL fallback composer.

## Navigation panel

The old branch added a `G` panel with:

- road and satellite tabs
- current camera coordinates
- coordinate input
- click-to-travel
- `webserver/public/mapview.html`

This functionality is absent from the current repository and can be restored as an
independent UI task.

Do not copy the old tile provider unchanged. It embeds an unofficial Google tile URL
through Leaflet. Use an approved/configured provider or an appropriate OSM-based map,
and keep coordinate-to-camera movement inside the current terrain camera/fetch modules.

## Larger visual systems that remain incomplete

These are valid future ports, but they overlap active graphics work and should wait.

### WebGPU water

Current WebGPU constructs the old flat water plane but does not show it in WebGPU. The
old material is a WebGL `ShaderMaterial`, so it is not the desired final WebGPU solution.

The LAAS tree already contains `world/WaterSurface.ts` and `render/WaterMaterial.ts`, with:

- camera-following clipmap levels
- depth-based opacity
- refraction and reflection
- foam and flow
- ice rendering

That system expects LAAS hydrology, atmosphere, and water-height resources. Port it by
adapting the Greenland heightfield/classifier to those inputs after the terrain patch is
stable. Do not replace it with the old 400 km flat plane as the final solution.

### Volumetric WebGPU clouds

Current WebGPU has cloud-density compute nodes and Beer shadow-map work, but the full
surface cloud renderer is not complete and the cloud shadow is detached during the
current god-ray/CSM investigation. The old `CloudsEffect` belongs to the WebGL
postprocessing path and cannot simply be used as the WebGPU solution.

Finish this with the active atmosphere work, not as a branch transplant.

### LAAS trample

The LAAS shaders already contain `render/Trample.ts`, and grass/plants already sample its
uniform. The missing connection is updating it with an eye/player/vehicle position in the
LAAS vegetation frame.

Start with the active player/camera position. Later, extend the interaction representation
to multiple vehicle wheel contacts for directional vegetation bending and snow tracks.

### Interactive snow

Interactive snow work was found in the Nanite snow-remaster workspace, while the current
Greenland tree already has static seasonal/winter material support. Delay importing the
interactive system until the terrain heightfield, vehicle contacts, and rendering ownership
are stable.

## Functionality already present in the current line

Do not spend time re-porting these old features:

- two-pass preview/full tile loading
- pass-one loading centered on the moving camera
- asset-server bootstrap and unified asset database
- generic per-ID asset PATCH endpoint
- Patria GLB loading and real-world scaling
- terrain snap, slope alignment, suspension, driving, and steering
- headlights
- vehicle map marker
- local vehicle shadow system
- single-vehicle persistence
- house instances, terrain snapping, shadows, markers, and hot reload
- HUD time transport controls
- terrain/tile inspector
- ocean-mask debugging and texture enhancement
- Greenland LAAS plants, rocks, materials, wind, seasons, and plant LODs

Diesel audio code and `audio/diesel_idle.mp3` are also present. It is disabled by
`DIESEL_MAX_VOL = 0`, so this is a tuning/activation decision rather than missing code.

The current game-time scale of `1` is deliberate. The old accelerated scale should not be
treated as missing functionality unless accelerated time is explicitly desired again.

## Recommended implementation order

After the active terrain/procgen/CSM changes have safely landed:

1. Restore and validate vehicle part metadata in both asset metadata files and the asset
   server.
2. Extract a modular `VehicleEntry` registry and migrate the existing Patria into it.
3. Change persistence to save each vehicle through `PATCH /api/asset/:id`.
4. Build load-time wheel pivots and expose wheel contact points.
5. Add close/medium/far camera modes.
6. Connect LAAS trample to the player/active-vehicle coordinate frame.
7. Add turret and gun articulation using authored or metadata pivots.
8. Add WebGPU-native muzzle, tracer, impact, and crosshair behavior.
9. Restore navigation as a separate UI feature.
10. Integrate interactive snow using the stable heightfield and wheel contacts.
11. Integrate LAAS water after hydrology and the terrain adapter are stable.

## Porting rules

- Do not merge `origin/vehicle_splitting` wholesale; its Git history is unrelated.
- Do not overwrite active dirty terrain, LAAS, atmosphere, or CSM work.
- Do not remove current functionality to make an old transplant fit.
- Prefer current modules and runtime contracts over adding more code to the entry-point
  monolith.
- Port runtime functionality, then validate it in the actual WebGPU scene. Tests support
  the implementation but are not a substitute for building and wiring the feature.
