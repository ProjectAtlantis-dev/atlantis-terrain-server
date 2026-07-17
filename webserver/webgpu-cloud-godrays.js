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
import { hash12 } from './laas/gpu/noise/NoiseTSL.ts';
import { runiform } from './laas/gpu/RenderUniform.ts';

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

/**
 * @param {object} args
 * @param {object} args.csmShadowLengthNode epipolar terrain shadow length (vec2, unit space)
 * @param {object} args.beerShadowMap CloudBeerShadowMapNode instance
 * @param {object} args.depthNode scene pass depth texture node
 * @param {THREE.PerspectiveCamera} args.camera
 * @param {object} args.atmosphereContext takram AtmosphereContext (matrixViewToECEF,
 *   altitudeCorrectionECEF, correctAltitude are TSL-compatible)
 * @param {number} args.worldToUnit meters → atmosphere unit scale
 * @returns {{ node: object, uniforms: { uStrength: object } }}
 */
export function createCloudGodRayShadowLength({
  csmShadowLengthNode,
  beerShadowMap,
  depthNode,
  camera,
  atmosphereContext,
  worldToUnit,
}) {
  const uProjInv = runiform(camera.projectionMatrixInverse);
  const _camPos = new THREE.Vector3();
  const uCamPos = runiform(new THREE.Vector3()).onRenderUpdate(() =>
    _camPos.copy(camera.position),
  );
  const uFrame = runiform(0).onRenderUpdate(frame => (frame.frameId ?? 0) % 4096);
  const uStrength = runiform(1);

  const node = Fn(() => {
    const csm = vec2(csmShadowLengthNode).toVar('csmShadowLength');

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

    const jitter = hash12(
      screenUV.mul(vec2(311.7, 761.3)).add(float(uFrame).mul(0.6180339887)),
    );

    // vec2(shadowedLength, segmentStart) in meters along the ray.
    const cloud = beerShadowMap
      .marchShadowLength(rayOrigin, rayDirection, maxDistance, jitter, {
        iterations: CLOUD_GODRAY_ITERATIONS,
        minStepSize: CLOUD_GODRAY_MIN_STEP_M,
        stepScale: CLOUD_GODRAY_STEP_SCALE,
      })
      .toVar('cloudShadowSegment');
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
