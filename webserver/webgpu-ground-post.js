/**
 * Screen-space grounding for the takram WebGPU post chain: GTAO + a short
 * contact-shadow march, multiplied into the scene color BEFORE aerial
 * perspective (occlusion is a surface property; haze integrates on top —
 * The source post stack applied it after aerial but neutralized the difference
 * with the same near-field fades used here).
 *
 * Why this exists: the procedural runtime excludes understory plants from the
 * CSM caster set (ringCasts=false) on the assumption that PostStack's GTAO
 * + contact shadows ground them instead — but PostStack never got wired
 * into this takram pipeline, so plants floated. This ports exactly those
 * two layers, nothing else (no clouds march, no bounce, no TRAA changes).
 *
 * - GTAO: procedural-runtime/render/Gtao.ts (Three r184 GTAONode math), run
 *   full-res here (the original pass ran it half-res inside its merged MRT; port
 *   the HalfResMrt infrastructure only if measurement says so).
 * - Contact: 12-tap depth march toward the sun, ≤240 m, quadratic step
 *   spacing, first-hit-wins, occlusion floored (never pitch black) — a
 *   direct port of PostStack's spec §2 floor.
 * - Both terms return 1 on sky pixels and fade out by ~240 m, so distant
 *   terrain and the sky composite are untouched.
 *
 * A/B: compile-out via ?gtao=0 / ?contact=0 (true cost ablation);
 * uAoStrength / uContactStrength uniforms (0..1) for rebuild-free visual
 * toggling at runtime (exposed on window.__atlantisWebGPU.grounding).
 */

import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  float,
  mix,
  smoothstep,
  texture,
  vec2,
  vec3,
  vec4,
  screenUV,
  getViewPosition,
  getScreenPosition,
} from 'three/tsl';
import { gtaoLayer } from './procedural-runtime/render/Gtao.ts';
import { hash12 } from './procedural-runtime/gpu/noise/NoiseTSL.ts';
import { runiform } from './procedural-runtime/gpu/RenderUniform.ts';
import { ScaledRTTNode } from './webgpu-scaled-rtt.js';

const SSCS_STEPS = 12;
const GROUND_FADE_FAR_M = 240;
const GROUND_FADE_NEAR_M = 140;
const GROUNDING_RESOLUTION_SCALE = 0.5;

/**
 * Builds the grounded color node.
 *
 * @param {object} args
 * @param {object} args.colorNode scene pass color texture node
 * @param {object} args.depthNode scene pass depth texture node
 * @param {THREE.PerspectiveCamera} args.camera
 * @param {() => THREE.Vector3 | null} args.getSunDirectionECEF world (ECEF)
 *   unit vector toward the sun; the scene's world frame IS ECEF here.
 * @param {{ gtao: boolean, contact: boolean }} args.enabled compile-time
 *   inclusion of each layer.
 * @returns {{ node: object, uniforms: { uAoStrength: object, uContactStrength: object } }}
 */
export function createGroundingNode({
  colorNode,
  depthNode,
  camera,
  getSunDirectionECEF,
  enabled,
  fullRes = false,
}) {
  // Live object references — current (TAA-jittered) values at upload time,
  // the same pattern gtaoLayer uses internally.
  const uProj = runiform(camera.projectionMatrix);
  const uProjInv = runiform(camera.projectionMatrixInverse);

  const _sunView = new THREE.Vector3(0, 0, 1);
  const uSunView = runiform(new THREE.Vector3(0, 0, 1)).onRenderUpdate(() => {
    const sun = getSunDirectionECEF();
    if (sun != null && sun.lengthSq() > 0) {
      _sunView.copy(sun).transformDirection(camera.matrixWorldInverse);
    }
    return _sunView;
  });
  const uFrame = runiform(0).onRenderUpdate(frame => (frame.frameId ?? 0) % 4096);
  const _bufSize = new THREE.Vector2(2, 2);
  const uResolution = runiform(new THREE.Vector2(2, 2)).onRenderUpdate(frame => {
    frame.renderer?.getDrawingBufferSize?.(_bufSize);
    return _bufSize;
  });

  // Runtime A/B strengths (1 = full effect, 0 = off) — no pipeline rebuild.
  const uAoStrength = runiform(1);
  const uContactStrength = runiform(1);

  // GTAO fragment expression (heavy loops live inside an If(depth<1)).
  // Runtime-tuned parameters: 16 samples cost ~50 ms on terrain vistas, so 8
  // samples / 1.6 m radius (PostStack Phase-2 finding).
  const aoExpr = enabled.gtao
    ? gtaoLayer(depthNode, camera, uResolution, {
        samples: 8,
        radius: 1.6,
        distanceFallOff: 0.6,
      })
    : null;

  const groundingMask = Fn(() => {
    const d = depthNode.x.toVar();
    // Tolerate either depth convention at far.
    const isSky = d.lessThanEqual(1e-7).or(d.greaterThanEqual(0.9999999));
    const grounding = float(1).toVar();

    If(isSky.not(), () => {
      const viewPos = getViewPosition(screenUV, d, uProjInv).toVar();
      const dist = viewPos.length().toVar();
      // Grounding is a near-field cue: fade to 1 well before the cascades
      // and aerial perspective own the look.
      const nearFade = smoothstep(GROUND_FADE_FAR_M, GROUND_FADE_NEAR_M, dist).toVar();

      if (aoExpr != null) {
        grounding.mulAssign(mix(float(1), aoExpr, nearFade.mul(uAoStrength)));
      }

      if (enabled.contact) {
        const result = float(1).toVar();
        If(dist.lessThan(GROUND_FADE_FAR_M), () => {
          const sunV = vec3(uSunView).normalize();
          const jit = hash12(
            screenUV.mul(vec2(517.7, 893.3)).add(float(uFrame).mul(0.7548)),
          )
            .mul(0.8)
            .add(0.4);
          // The original 1.7 m ray was tuned for grass/feet and did not span
          // Greenland's 2-5 m scaled boulders. A 3 m march costs the same 12
          // taps but restores the contact penumbra that tells the eye a large
          // rock is bedded into the terrain rather than hovering above it.
          const range = float(3.0);
          // First-hit-wins early exit: the contribution 1−f·0.5 strictly
          // decreases with step index, so once any step hits, later steps
          // can never raise the max. hitF sentinel 2 = no hit yet.
          const hitF = float(2).toVar();
          for (let s = 1; s <= SSCS_STEPS; s++) {
            // quadratic step distribution: dense near the surface
            const f = (s / SSCS_STEPS) ** 1.6;
            If(hitF.greaterThan(1.5), () => {
              const sampleV = viewPos.add(sunV.mul(range).mul(jit).mul(f));
              const uvS = getScreenPosition(sampleV, uProj);
              const inFrame = uvS.x
                .greaterThan(0.001)
                .and(uvS.x.lessThan(0.999))
                .and(uvS.y.greaterThan(0.001))
                .and(uvS.y.lessThan(0.999));
              const dS = texture(depthNode.value, uvS).x;
              const bufV = getViewPosition(uvS, dS, uProjInv);
              const dz = bufV.z.sub(sampleV.z); // >0: buffer closer to camera
              const hit = dz.greaterThan(0.05).and(dz.lessThan(2.6)).and(inFrame);
              If(hit, () => {
                hitF.assign(f);
              });
            });
          }
          const occl = hitF
            .lessThan(1.5)
            .select(float(1).sub(hitF.mul(0.5)), float(0));
          // 0.6 ceiling retains a no-black-shadows floor.
          result.assign(
            float(1).sub(occl.mul(0.6).mul(nearFade).mul(uContactStrength)),
          );
        });
        grounding.mulAssign(result);
      }
    });

    return vec4(grounding, 0, 0, 1);
  });

  // The source post stack evaluates GTAO at half resolution. Keep scene
  // color and depth full resolution, but evaluate the low-frequency scalar
  // occlusion/contact mask at one quarter the pixel count and bilinearly
  // reconstruct it for composition. ?groundingFull=1 retains a compile-time
  // A/B path for visual/performance comparisons.
  const maskSource = fullRes
    ? groundingMask()
    : new ScaledRTTNode(groundingMask(), GROUNDING_RESOLUTION_SCALE);
  const node = Fn(() => {
    const base = vec4(colorNode).toVar();
    return vec4(base.rgb.mul(maskSource.x), base.a);
  })();

  return { node, uniforms: { uAoStrength, uContactStrength } };
}
