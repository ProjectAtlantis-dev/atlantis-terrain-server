/**
 * Cloud god rays (task 4 of the clouds port): fold cloud optical depth into
 * the shadowLength vec2 consumed by aerialPerspective + skyNode.
 *
 * The epipolar CSM ShadowLengthNode only knows terrain occluders. This node
 * marches the beer shadow map's sun-direction optical depth along each view
 * ray (CloudBeerShadowMapNode.marchShadowLength — a port of the WebGL
 * clouds.frag marchShadowLength) and merges the resulting cloud shadow
 * segment with the CSM one.
 *
 * Convention (authoritative per atmosphere runtime.ts diagrams):
 *   shadowLength.x = shadowed length along the ray
 *   shadowLength.y = distance from camera to the shadow segment start
 * both in atmosphere UNIT space. The runtime models ONE contiguous segment,
 * so two segments (terrain + cloud) merge as: total length = sum of
 * lengths, start = length-weighted mean of starts.
 *
 * IMPORTANT: this samples the BSM only in the post pass — it deliberately
 * avoids CloudShadowAtmosphereLightNode / light.cloudShadow, whose graph
 * attach craters the frame rate ~50x on r182 (see main.webgpu.terrain.js).
 *
 * A/B: construction is gated by ?cloudGodRays=0; uStrength (0..1) scales
 * the cloud contribution live without a pipeline rebuild.
 */

import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec2,
  vec4,
  min,
  screenUV,
  getViewPosition,
} from 'three/tsl';
import { hash12 } from './procedural-runtime/gpu/noise/NoiseTSL.ts';
import { runiform } from './procedural-runtime/gpu/RenderUniform.ts';
import { ScaledRTTNode } from './webgpu-scaled-rtt.js';

// Clouds live in the 900-3300 m band here; beyond ~25 km the march adds
// nothing god rays could resolve against aerial perspective. The cap is the
// actual march coverage: 48 geometric steps from 100 m at 1.06 growth reach
// 100·(1.06^48−1)/0.06 ≈ 25.6 km. Raising the cap requires raising the
// iteration count or step growth to match — the march stops at whichever is
// shorter.
const CLOUD_GODRAY_MAX_DISTANCE_M = 25000;
const CLOUD_GODRAY_ITERATIONS = 48;
const CLOUD_GODRAY_MIN_STEP_M = 100;
const CLOUD_GODRAY_STEP_SCALE = 1.06;
// The march runs in a scaled offscreen target, not per output pixel: the BSM
// segment is a soft 25 km signal, so quarter the invocations survives a
// bilinear upsample (bucket-sweep 2026-07-18 measured the full-res march at
// ~10.7 ms of a 36 ms frame at 1440p — the largest single bucket). Known
// limit: plain bilinear can halo at depth silhouettes (sky/ground
// maxDistance mismatch); revisit with a depth-aware upsample + temporal
// reconstruction if visible (PERF_REWORK.md Tier 3).
const CLOUD_GODRAY_RESOLUTION_SCALE = 0.5;

/**
 * @param {object} args
 * @param {object} args.csmShadowLengthNode epipolar terrain shadow length (vec2, unit space)
 * @param {object} args.beerShadowMap CloudBeerShadowMapNode instance
 * @param {object} args.depthNode scene pass depth texture node
 * @param {THREE.PerspectiveCamera} args.camera
 * @param {object} args.atmosphereContext takram AtmosphereContext (matrixViewToECEF,
 *   altitudeCorrectionECEF, correctAltitude are TSL-compatible)
 * @param {number} args.worldToUnit meters → atmosphere unit scale
 * @param {boolean} [args.fullRes=false] march per output pixel instead of in
 *   the scaled offscreen target (A/B escape hatch, ?cloudGodRaysFull=1)
 * @returns {{ node: object, uniforms: { uStrength: object } }}
 */
export function createCloudGodRayShadowLength({
  csmShadowLengthNode,
  beerShadowMap,
  depthNode,
  camera,
  atmosphereContext,
  worldToUnit,
  fullRes = false,
}) {
  const uProjInv = runiform(camera.projectionMatrixInverse);
  const _camPos = new THREE.Vector3();
  const uCamPos = runiform(new THREE.Vector3()).onRenderUpdate(() =>
    _camPos.copy(camera.position),
  );
  const uFrame = runiform(0).onRenderUpdate(frame => (frame.frameId ?? 0) % 4096);
  const uStrength = runiform(1);

  // vec2(shadowedLength, segmentStart) in meters along the view ray. Kept in
  // meters (not unit space) so uStrength/worldToUnit stay in the full-res
  // merge and tune live without re-rendering the offscreen target.
  const cloudSegment = Fn(() => {
    // Per-pixel view ray in ECEF. Direction from a fixed finite depth (the
    // far-plane value degenerates through the inverse projection).
    const viewDir = getViewPosition(screenUV, float(0.5), uProjInv).normalize();
    const rayDirection = atmosphereContext.matrixViewToECEF
      .mul(vec4(viewDir, 0))
      .xyz.normalize();
    let rayOrigin = vec4(uCamPos, 1).xyz;
    if (atmosphereContext.correctAltitude) {
      rayOrigin = rayOrigin.add(atmosphereContext.altitudeCorrectionECEF);
    }

    // March up to the surface (or the cap, for sky pixels — that's where
    // cloud rays matter most).
    const d = depthNode.x;
    const isSky = d.lessThanEqual(1e-7).or(d.greaterThanEqual(0.9999999));
    const surfaceDistance = getViewPosition(screenUV, d, uProjInv).length();
    const maxDistance = min(
      isSky.select(float(CLOUD_GODRAY_MAX_DISTANCE_M), surfaceDistance),
      CLOUD_GODRAY_MAX_DISTANCE_M,
    );

    // Full-res path: temporal jitter, averaged per-pixel by TAA. Scaled path:
    // STATIC spatial dither only — animating the jitter at half res turns it
    // into large coherent blobs that crawl over the terrain every frame
    // (seen live 2026-07-19; TAA cannot average noise that is spatially
    // coherent across many output pixels).
    const jitterCoord = fullRes
      ? screenUV.mul(vec2(311.7, 761.3)).add(float(uFrame).mul(0.6180339887))
      : screenUV.mul(vec2(311.7, 761.3));
    const jitter = hash12(jitterCoord);

    const segment = beerShadowMap
      .marchShadowLength(rayOrigin, rayDirection, maxDistance, jitter, {
        iterations: CLOUD_GODRAY_ITERATIONS,
        minStepSize: CLOUD_GODRAY_MIN_STEP_M,
        stepScale: CLOUD_GODRAY_STEP_SCALE,
      })
      .toVar('cloudShadowSegment');
    return vec4(segment, 0, 1);
  });

  // Default path: march into a half-res target (linear-filtered HalfFloat),
  // sampled here at full res = bilinear upsample.
  const cloudSource = fullRes
    ? cloudSegment()
    : new ScaledRTTNode(cloudSegment(), CLOUD_GODRAY_RESOLUTION_SCALE);

  const node = Fn(() => {
    const csm = vec2(csmShadowLengthNode).toVar('csmShadowLength');

    const cloud = vec2(cloudSource.xy).toVar('cloudShadowSegmentM');
    const cloudLength = cloud.x.mul(worldToUnit).mul(uStrength);
    const cloudStart = cloud.y.mul(worldToUnit);

    // Merge segments, moment-preserving: the runtime models ONE contiguous
    // segment, so fit (start, length) to the union's total length and first
    // moment. Total length is additive (an upper bound where terrain and
    // cloud intervals overlap — acceptable: it errs toward slightly longer
    // rays, and uStrength tunes it down). The merged start places the
    // segment so its CENTER is the length-weighted mean of the two segment
    // centers: start = Σ Li·(Si + Li/2) / ΣL − ΣL/2. A plain weighted mean
    // of starts sits L1·L2/ΣL too far down the ray. Known model limit
    // (WEBGPU_CLOUD_SHADOWS.md): distributed partial cloud cover squeezed
    // into one fully-shadowed segment over-dims broad overcast — that is a
    // property of takram's single-segment shadowLength, not of this fit.
    const totalLength = csm.x.add(cloudLength);
    const mergedCenterMoment = csm.y
      .add(csm.x.mul(0.5))
      .mul(csm.x)
      .add(cloudStart.add(cloudLength.mul(0.5)).mul(cloudLength));
    const mergedStart = mergedCenterMoment
      .div(totalLength.max(1e-6))
      .sub(totalLength.mul(0.5))
      .max(0);
    return vec2(totalLength, totalLength.greaterThan(0).select(mergedStart, 0));
  })();

  return { node, uniforms: { uStrength } };
}
