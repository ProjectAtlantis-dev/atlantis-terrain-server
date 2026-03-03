# Fixing Black Square Sprites — Investigation Log

## Status: FIXED

## Problem
After the vehicle registry refactor (`vehicle_splitting` branch), the muzzle flash and ground impact sprites appear as **black squares** instead of glowing gradient effects. (Note: this bug likely existed on the UI branch too — it's a pre-existing issue with THREE.Sprite + postprocessing NormalPass, not caused by the refactor.)

The user reports:
- Turret firing works (visible animations)
- Muzzle flash appears and fades (correct timing)
- Ground impacts appear (correct positioning)
- But both appear as **opaque black squares** instead of soft gradient glows

## What Was Changed
The refactor moved ~40 global vehicle variables into a `VehicleEntry` factory/registry pattern. The sprite creation code was **only changed in variable references** (e.g. `muzzleFlashSprite` → `vehicle.muzzleFlashSprite`, `vehicleGroup` → `vehicle.group`). The material creation, canvas texture drawing, and blending setup are byte-for-byte identical.

## Investigation Steps

### 1. Code Diff Analysis
Compared sprite creation code line-by-line between `UI` branch and `vehicle_splitting` branch. Result: **IDENTICAL** except for variable names.

**UI branch (line 2702):**
```js
const flashMat = new THREE.SpriteMaterial({
  map: flashTex,
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false,
});
muzzleFlashSprite = new THREE.Sprite(flashMat);
muzzleFlashSprite.scale.setScalar(0.5);
muzzleFlashSprite.visible = false;
vehicleGroup.add(muzzleFlashSprite);
```

**vehicle_splitting branch (line 2782):**
```js
const flashMat = new THREE.SpriteMaterial({
  map: flashTex,
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false,
});
vehicle.muzzleFlashSprite = new THREE.Sprite(flashMat);
vehicle.muzzleFlashSprite.scale.setScalar(0.5);
vehicle.muzzleFlashSprite.visible = false;
vehicle.group.add(vehicle.muzzleFlashSprite);
```

Same for impact sprites, tracer meshes.

### 2. Playwright Runtime Analysis
Ran Playwright tests on BOTH branches to inspect sprite material properties at runtime.

**UI branch result:**
```json
{
  "blending": 2,        // THREE.AdditiveBlending
  "transparent": true,
  "depthWrite": false,
  "depthTest": true,
  "toneMapped": true,
  "hasMap": true,
  "mapVersion": 1,
  "canvasData": {
    "center": [255, 251, 189, 251],  // bright yellow, alpha ~0.98
    "corner": [0, 0, 0, 0]           // fully transparent
  }
}
```

**vehicle_splitting branch result:**
```json
{
  "blending": 2,        // THREE.AdditiveBlending
  "transparent": true,
  "depthWrite": false,
  "depthTest": true,
  "toneMapped": true,
  "hasMap": true,
  "mapVersion": 1,
  "canvasData": {
    "center": [255, 251, 189, 251],  // IDENTICAL
    "corner": [0, 0, 0, 0]           // IDENTICAL
  }
}
```

**Result: IDENTICAL** between branches. The canvas texture has correct gradient data, all material properties match.

### 3. Scene Graph Comparison
- Both branches: sprite is a child of the vehicle group (which is a child of `terrainRoot`)
- Both branches: impact sprites are direct children of `terrainRoot`
- Both branches: tracer meshes are direct children of `terrainRoot`
- Vehicle group properties (scale, position, rotation) are applied identically

### 4. Render Loop Order Comparison
Both branches have identical render loop order for sprite-related calls:
```
fireTurret()          → creates muzzle flash, spawns tracer, spawns impact
updateTracers(dt)     → moves tracers along fire direction
updateImpacts(dt)     → fades impact sprites
muzzle flash fade     → decreases opacity over 0.05 seconds
syncVehicleSunLight() → updates directional light direction
```

### 5. Renderer Settings
```js
renderer.toneMapping = THREE.NoToneMapping;    // no built-in tone mapping
renderer.toneMappingExposure = 10;
// Postprocessing: ToneMappingEffect(AGX) applied separately
```
Both branches have identical renderer and postprocessing setup.

## Key Finding
**The sprite code, materials, textures, and rendering pipeline are IDENTICAL between branches.** The Playwright tests confirm every material property matches. This raises the question of whether the black squares also existed on the UI branch.

## Possible Causes Still Under Investigation

### Theory A: Browser rendering state
The black squares might be caused by a WebGL state issue that is browser-specific or GPU-specific. The headless Playwright tests may not reproduce the issue because:
- Headless Chromium uses software rendering (SwiftShader)
- The actual browser may have different GPU driver behavior
- WebGL state leaks or driver-specific blending quirks

### Theory B: Postprocessing framebuffer interaction
The EffectComposer uses `HalfFloatType` framebuffers with `multisampling: 4`. The sprite's `AdditiveBlending` renders to this framebuffer. There may be an issue with how:
- Alpha channel accumulates in the multisampled framebuffer
- The resolve step handles additive-blended alpha
- The subsequent tone mapping pass reads the alpha

### Theory C: CanvasTexture GPU upload timing
The muzzle flash sprite starts as `visible: false`. When it becomes visible during `fireTurret()`, the CanvasTexture needs to be uploaded to the GPU. While Three.js handles this automatically via the `version` property, there might be a race condition or a driver-specific issue with the first frame render.

### Theory D: Pre-existing issue on UI branch
Given identical code and identical Playwright results, the black squares may have existed on the UI branch too. The user may not have tested turret firing extensively on the UI branch, or the issue may have been intermittent.

## Potential Fixes to Try

1. **Add `toneMapped: false`** to sprite materials — ensures no tone mapping interference
2. **Add `depthTest: false`** to sprite materials — prevents depth buffer culling
3. **Set `needsUpdate = true`** on the texture before first render when sprite becomes visible
4. **Use `NormalBlending` instead of `AdditiveBlending`** (changes look but verifies rendering works)
5. **Force texture upload** by briefly making sprite visible during load then hiding it
6. **Use a pre-rendered PNG texture** instead of CanvasTexture to rule out canvas issues

## ROOT CAUSE FOUND

**THREE.Sprite ignores `scene.overrideMaterial`.**

The postprocessing library's `NormalPass` works by setting `scene.overrideMaterial` to a normal-encoding material to capture scene normals into a texture. Because THREE.Sprite is special-cased in Three.js's WebGL renderer and bypasses override materials, sprites write their **raw glow texture colors** directly into the normal buffer instead of proper encoded normals.

The `AerialPerspectiveEffect` reads that normal buffer to compute per-pixel sun irradiance (`aerialPerspective.sunIrradiance = true`, `aerialPerspective.normalBuffer = normalPass.texture`). At the sprite's screen-space pixels, it sees corrupted "normals" (random glow colors) and computes incorrect irradiance — resulting in a **black rectangular region** matching the sprite's billboard quad, rendered on top of the scene by the atmosphere pass.

## Fix Applied

Wrap `normalPass.render` to temporarily hide effect sprites during the NormalPass render, then restore their visibility immediately after. This prevents them from corrupting the normal buffer while still rendering them correctly in the main RenderPass.

**Location:** `webserver/main.terrain.js`, immediately after `const normalPass = new NormalPass(scene, camera);`

```js
{
  const _origNormalRender = normalPass.render.bind(normalPass);
  normalPass.render = function (renderer, inputBuffer, outputBuffer, deltaTime, stencilTest) {
    // Save & hide muzzle flash sprites for ALL vehicles in registry
    const flashVis = [];
    for (const [, v] of vehicleRegistry) {
      if (v.muzzleFlashSprite) {
        flashVis.push({ sprite: v.muzzleFlashSprite, was: v.muzzleFlashSprite.visible });
        v.muzzleFlashSprite.visible = false;
      }
    }
    // Save & hide impact pool sprites
    const impVis = impactPool.map(s => s.visible);
    impactPool.forEach(s => { s.visible = false; });

    _origNormalRender(renderer, inputBuffer, outputBuffer, deltaTime, stencilTest);

    // Restore visibility
    for (const entry of flashVis) entry.sprite.visible = entry.was;
    impactPool.forEach((s, i) => { s.visible = impVis[i]; });
  };
}
```

## Important: Future Sprites
Any `THREE.Sprite` used as a visual effect (muzzle flash, impact glow, particles, etc.) that sits in the same scene as the NormalPass will have this same problem and needs to be hidden in the NormalPass wrapper.
