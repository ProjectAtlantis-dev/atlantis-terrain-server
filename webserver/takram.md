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

Four separate procedural texture generators (`LocalWeather`, `CloudShape`, `CloudShapeDetail`, `Turbulence`) all need to be instantiated and assigned. The library also bundles STBN loaders, 3D EXR loaders, and procedural texture generators that live in the local `three-geospatial/` fork.

## 5. The "not React" problem

Takram's library is designed for R3F (React Three Fiber). This project is vanilla Three.js, which means manually wiring up everything that R3F components handle declaratively: effect composition, texture prop syncing, lifecycle management, etc. This is why there's a local fork of the entire `three-geospatial` repo and Vite aliases in `vite.config.js` pointing `@takram/*` imports to the local source.
