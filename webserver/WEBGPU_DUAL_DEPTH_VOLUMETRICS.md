# WebGPU dual-depth volumetrics

## Goal

Use the opaque depth seen by the viewer and the opaque depth seen by the sun to
make terrain and models occlude atmospheric and cloud lighting. Keep clear-air
optical depth constant-time through the atmosphere LUT/fitted transfer rather
than nesting an optical-depth march inside the view-ray integration.

Clouds are not opaque surfaces, so the complete visibility term has three
inputs:

1. **Viewer depth** terminates the view ray at the first opaque surface.
2. **Sun depth** supplies binary terrain/model visibility at any point in the
   participating medium.
3. **Cloud transmittance** supplies fractional sun visibility through clouds.

For a point `p` on the view ray:

```text
sunVisibility(p) = opaqueSunVisibility(p) * cloudTransmittance(p)
```

The scene pass already provides viewer color and depth. The WebGPU atmosphere
pass reconstructs the surface position from that depth, so atmosphere and
cloud composition naturally stop at the scene rather than drawing over it.

## Integration strategy

The unshadowed clear-air transfer remains a single Takram atmosphere LUT query.
A small fixed number of probes along the depth-clipped view segment sample the
combined sun visibility. Their mean modulates the direct portion of atmospheric
inscatter while a configurable floor retains indirect and multiple scattering.
This is the initial approximation to light shafts:

```text
inscatter = unshadowedInscatter
           * mix(1, indirectFloor + (1 - indirectFloor) * meanVisibility,
                 shaftStrength)
```

This is not an optical-depth march. Each probe performs only a sun-depth compare
and a cloud-transmittance lookup. Temporal filtering and interval reconstruction
can later reduce the probe count or replace the mean with endpoint-difference
integration.

## Coordinate and depth conventions

- Scene/world coordinates are ECEF in the current application.
- The sun camera is an orthographic camera centered on the viewer's ground
  footprint and aligned with the atmosphere's ECEF sun direction.
- Its depth render target stores opaque geometry depth. Sampling follows
  three.js WebGPU render-target Y orientation and WebGPU `[0, 1]` clip depth.
- A small depth bias prevents a surface from shadowing the adjacent atmosphere
  because of quantization.

## Stages

### Stage 1 — implemented vertical slice

- Capture one camera-centered opaque sun-depth map.
- Refresh opaque sun depth at a lower rate than the procedural cloud map; the
  former redraws scene geometry while the latter is one fullscreen GPU pass.
- Combine opaque visibility with the existing cloud optical-depth map.
- Clip shaft evaluation at viewer depth.
- Apply shadow-aware inscatter to terrain/model pixels.
- Expose cloud-shadow, god-ray strength, and debug controls.

This stage is opt-in while the sun-depth convention and energy preservation are
validated visually. The normal WebGPU atmosphere remains the default.

### Stage 2 — visible clouds

- Render cloud shell intersections into a half/quarter-resolution view buffer.
- Reuse the same weather field and sun-space cloud transmittance.
- Use scene viewer depth as the hard upper bound for cloud integration.
- Store accumulated color and transmittance rather than one cloud surface depth.

### Stage 3 — fitted cloud profile

- Replace the 24-step cloud shadow optical-depth pass with an analytic integral
  of the vertical cloud profile.
- Sample the horizontal weather field once for distant clouds and a few times
  for low-sun or near-camera cases.
- Validate long-shadow error before removing the marched fallback.

### Stage 4 — interval/epipolar shafts

- Detect lit/shadow transitions along epipolar rays.
- Integrate each clear-air interval using fitted/LUT endpoint differences.
- Add blue-noise jitter, temporal reprojection, and disocclusion rejection.
- Add near/mid/far sun-depth cascades with texel-snapped centers.

### Stage 5 — spectral extensions

- Keep Rayleigh, aerosol/Mie, and ozone absorption in the atmosphere model.
- Add airglow as a night-only emissive layer; it must not be multiplied by sun
  visibility.
- Separate direct single scattering from indirect/multiple scattering more
  precisely when the atmosphere runtime exposes those components.

## Validation

- A model must cast a shaft through haze and a shadow onto the ground/cloud
  layer in the same direction.
- Moving the viewer must not slide a stationary shadow relative to terrain.
- Viewer depth must prevent atmosphere/cloud color from bleeding over opaque
  foreground silhouettes.
- Fully lit visibility must reproduce the previous unshadowed atmosphere.
- The sun-depth debug view must show the expected caster footprint and remain
  stable under small camera movements.
