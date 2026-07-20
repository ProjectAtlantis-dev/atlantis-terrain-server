/**
 * Player trample — vegetation bends away from the walker's legs, the way
 * every modern open-world game does it: no physics, no CPU spatial queries
 * (instances only exist on the GPU) — a world-position uniform sampled in
 * the vegetation VERTEX stage.
 *
 * Model: within ~1 m of the feet, plants SHEAR radially away (push grows
 * with height along the stem, so the base stays planted — same mechanism as
 * the wind lean) and dip down slightly (crushed, not translated). Radial +
 * vertical falloffs are smooth so blades ease out of the way as you
 * approach and spring back as you pass; a camera flying overhead leaves the
 * sward untouched.
 *
 * Module singleton like windU: materials sample the uniform whenever they
 * build; main.ts refreshes it from the camera every frame.
 */

import { Vector3 } from 'three';
import { smoothstep, vec2, vec3 } from 'three/tsl';
import type { NF, NV2, NV3 } from '../gpu/TSLTypes';
import { runiform } from '../gpu/RenderUniform';

/** eye world position (starts far underground = no effect until first update) */
export const trampleU = {
  eye: runiform(new Vector3(0, -9999, 0)),
};

/** matches FlyCamera walk tuning — feet = eye − EYE_HEIGHT */
const EYE_HEIGHT = 1.7;
/** legs' influence radius (m) — user-tuned: 1.05 read as too tight */
const RADIUS = 1.7;

export function updateTrample(eyeWorld: Vector3): void {
  trampleU.eye.value.copy(eyeWorld);
}

/**
 * World-space shear offset for a vegetation vertex `localY` meters above a
 * plant base at world (baseXZ, baseY). Vertex-stage safe (uniform + ALU).
 */
export function trampleOffset(baseXZ: NV2, baseY: NF, localY: NF): NV3 {
  const e = vec3(trampleU.eye as unknown as NV3);
  const d = baseXZ.sub(vec2(e.x, e.z));
  const r = d.length().max(0.001);
  const radial = smoothstep(RADIUS, 0.3, r);
  // only plants near the walker's FEET bend — kills the effect when flying
  const feetY = e.y.sub(EYE_HEIGHT);
  const vGate = smoothstep(1.6, 0.7, baseY.sub(feetY).abs());
  const push = radial.mul(vGate).mul(localY);
  return vec3(
    d.x.div(r).mul(push).mul(1.15),
    push.mul(-0.6),
    d.y.div(r).mul(push).mul(1.15),
  );
}
