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
