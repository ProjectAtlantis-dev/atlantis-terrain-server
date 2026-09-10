# Takram Integration Pain Points

## 1. Render-target feedback issues (effect pass order)

Separating `CloudsEffect` and `AerialPerspectiveEffect` into different `EffectPass` calls caused visual glitches because postprocessing ping-pongs render targets between passes. The fix was combining them in a single pass:

```js
// Keep clouds + atmosphere in one effect pass to avoid render-target feedback issues.
composer.addPass(new EffectPass(camera, cloudsEffect, aerialPerspective));
```

## 2. Precomputed atmosphere texture loading (EXR pipeline)

The 4 EXR LUTs (`transmittance.exr`, `scattering.exr`, `irradiance.exr`, `higher_order_scattering.exr`) are expensive to fetch. The early builds used a simple `PrecomputedTexturesLoader().load()`, but this evolved into a full Cache API layer with `URLModifier`, blob object URLs, and fallback chains to avoid re-downloading on every page load.

## 3. Cloud-to-atmosphere wiring (`syncCloudComposition`)

`CloudsEffect` produces overlay, shadow, and shadowLength outputs that `AerialPerspectiveEffect` consumes. This requires a manual event listener on `cloudsEffect.events` to keep them in sync. Getting this wrong means the atmosphere doesn't react to clouds correctly.

## 4. Procedural 3D textures for cloud shapes

Four separate procedural texture generators (`LocalWeather`, `CloudShape`, `CloudShapeDetail`, `Turbulence`) all need to be instantiated and assigned. The library also bundles STBN loaders, 3D EXR loaders, and procedural texture generators that live in the local `three-geospatial/` clone.

## 5. No R3F, no problem

Takram's library ships with R3F (React Three Fiber) wrappers, but the actual 3D code underneath is plain Three.js. R3F only helps with postprocessing wiring (effect pass setup, event listener plumbing) — it does nothing for loading meshes, textures, heightmaps, or any of the real 3D work. Not worth the dependency. We use an unmodified clone of `three-geospatial/` pinned to commit `ab3d1cf5` and point Vite aliases at the source to skip the React dependencies in the npm builds. Pain points 1–4 above are just the manual postprocessing plumbing we took on instead.

## 6. Cloud history reset after sun changes

`terrain-cloud-runtime.js` installs a runtime shader patch through
`installTerrainCloudHistoryReset()`. Takram's temporal upscaler ignores
`temporalAlpha` for 15 of its 16 Bayer phases. Merely resetting that alpha leaves
pixels accumulated under different sun directions, producing grid ghosts.
Our patch makes the next resolve fill every history pixel from the current
low-resolution frame. It depends on exact anchors in the pinned
`packages/clouds/src/shaders/cloudsResolve.frag`.

This patch is part of the tracked Atlantis code, not an edit inside the ignored
Takram checkout. Setup runs the existing regression test against the downloaded
shader and fails if the patch no longer installs correctly.

## Reproducing the working WebGL integration

Run `./setup` or `./runViteServer`. Both retain commit
`ab3d1cf54cfe2bd3d79ffd2ee872d801050b6c64`; they do not select upstream latest.
The required fixes remain in these tracked files:

- `render-backends/webgl-backend.js`: combined clouds/atmosphere effect pass.
- `terrain-atmosphere-textures.js`: EXR cache and loader fallback handling.
- `terrain-cloud-runtime.js`: composition events, procedural textures, history
  reset patch, cloud sampling parameters, and wind projection handling.
- `terrain-atmosphere-frame.js`: moving geospatial frame synchronization.
- `vite.config.js`: imports from the pinned Takram source checkout.

During the bootstrap audit, all four downloaded source trees matched the
existing working checkout byte for byte, and the fresh clone passed the build
and all 436 tests. This establishes source and test reproducibility; it is not
a new visual verification of the rendered scene. No assumption about upstream
fixing these issues is needed or made.
