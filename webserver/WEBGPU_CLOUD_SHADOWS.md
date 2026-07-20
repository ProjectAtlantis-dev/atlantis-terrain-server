# WebGPU Cloud Shadows

The WebGPU cloud work is centered on cloud shadows and atmospheric light
shafts. Visible cloud rendering is a later consumer of the same density field,
not the primary milestone.

## Current vertical slice

`webgpu-cloud-shadows.js` implements a project-owned TSL pipeline:

1. A camera-centered sun-space render target stores cloud optical depth, and a
   second sun-space depth target captures opaque terrain/models.
2. The project-owned `CloudShadowAerialPerspectiveNode` adapter reconstructs
   each surface position and samples the map there without modifying Takram's
   source checkout.
3. Only direct-sun surface illuminance is attenuated. Sky illuminance remains
   unshadowed, so `MeshBasicMaterial` terrain receives cloud/model shadows
   through the post-processing lighting path.
4. Eight inexpensive visibility probes between the viewer and viewer depth
   combine opaque sun depth and cloud transmittance to modulate atmospheric
   inscatter, producing the first depth-correct shaft approximation.

An early experiment connected a distributed shadow estimate to Takram's
`shadowLengthNode`. That was removed because the node models one contiguous
fully shadowed segment; feeding it accumulated partial shadow suppressed the
entire atmospheric inscatter instead of only cloud-occluded solar scattering.

The first pass intentionally uses one 70 km map and an analytic procedural
density field. Cloud optical depth updates at 10 Hz; the more expensive opaque
scene depth capture updates every 0.75 seconds. The Atmosphere panel exposes
cloud-shadow and god-ray toggles, god-ray strength, and a shadow-mask view that
shows combined terrain-projected sun visibility in grayscale.

## Next stages

1. Compare surface shadow direction, movement, softness, coverage, and strength
   against the retained WebGL renderer.
2. Replace the analytic field with Takram-compatible weather, shape, and shape
   detail textures so visible clouds and shadows share exact density.
3. Add near/mid/far Beer shadow cascades with texel-snapped transforms.
4. Add temporal jitter and reprojection to stabilize low-resolution optical
   depth maps.
5. Replace mean-visibility shafts with fitted-integral/epipolar intervals,
   modulating direct solar scattering while retaining indirect scattering.
6. Reconstruct visible clouds from the shared field after shadow quality and
   performance are established.

## Known limitations

- One shadow map covers a 70 km square around the camera.
- Atmospheric shafts currently use eight fixed visibility probes rather than
  temporal epipolar interval reconstruction.
- The procedural density is not yet shared with visible cloud rendering.
- There is no temporal filtering or cascade blending yet.
