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

// Clouds live in the 900-3300 m band here; beyond ~30 km the march adds
// nothing god rays could resolve against aerial perspective.
const CLOUD_GODRAY_MAX_DISTANCE_M = 30000;

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
      .marchShadowLength(rayOrigin, rayDirection, maxDistance, jitter)
      .toVar('cloudShadowSegment');
    const cloudLength = cloud.x.mul(worldToUnit).mul(uStrength);
    const cloudStart = cloud.y.mul(worldToUnit);

    // Merge segments: total shadowed length is additive; the single-segment
    // model gets the length-weighted mean start.
    const totalLength = csm.x.add(cloudLength);
    const mergedStart = csm.y
      .mul(csm.x)
      .add(cloudStart.mul(cloudLength))
      .div(totalLength.max(1e-6));
    return vec2(totalLength, totalLength.greaterThan(0).select(mergedStart, 0));
  })();

  return { node, uniforms: { uStrength } };
}
