# WebGPU Cloud Shadows

The WebGPU cloud work is centered on cloud shadows and atmospheric light
shafts. Visible cloud rendering is a later consumer of the same density field,
not the primary milestone.

## Current vertical slice

`webgpu-cloud-shadows.js` implements a project-owned TSL pipeline:

1. A camera-centered sun-space render target stores cloud optical depth.
2. The project-owned `CloudShadowAerialPerspectiveNode` adapter reconstructs
   each surface position and samples the map there without modifying Takram's
   source checkout.
3. Only direct-sun surface illuminance is attenuated. Sky illuminance and
   atmospheric inscatter are preserved, so `MeshBasicMaterial` terrain receives
   cloud shadows through the post-processing lighting path.

An early experiment connected a distributed shadow estimate to Takram's
`shadowLengthNode`. That was removed because the node models one contiguous
fully shadowed segment; feeding it accumulated partial shadow suppressed the
entire atmospheric inscatter instead of only cloud-occluded solar scattering.

The first pass intentionally uses one 70 km map and an analytic procedural
density field. It updates at 10 Hz while the scene may render at display rate.
The Atmosphere panel exposes enable, coverage, density, and strength controls,
plus a shadow-mask toggle that shows terrain-projected Beer transmittance in
grayscale for validation without visible WebGPU clouds.

## Next stages

1. Compare surface shadow direction, movement, softness, coverage, and strength
   against the retained WebGL renderer.
2. Replace the analytic field with Takram-compatible weather, shape, and shape
   detail textures so visible clouds and shadows share exact density.
3. Add near/mid/far Beer shadow cascades with texel-snapped transforms.
4. Add temporal jitter and reprojection to stabilize low-resolution optical
   depth maps.
5. Integrate shafts per view-ray sample, modulating only direct-sun atmospheric
   scattering by cloud transmittance while retaining sky/Rayleigh scattering.
6. Reconstruct visible clouds from the shared field after shadow quality and
   performance are established.

## Known limitations

- One shadow map covers a 70 km square around the camera.
- Atmospheric shafts are disabled until their per-view-ray-sample integration
  is in place.
- The procedural density is not yet shared with visible cloud rendering.
- There is no temporal filtering or cascade blending yet.
