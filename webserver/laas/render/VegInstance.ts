/**
 * VegInstance — turns a Phase-4 vegetation material into a GPU-driven
 * instanced draw: per-instance transform (pos/scale/yaw/lean-shear) is read
 * from the scatter buffers through a cull-compacted index list, LOD ring
 * transitions use stable per-instance stochastic thresholds, and a small
 * per-instance tint breaks population uniformity beyond the per-vertex vdata
 * jitter (per-instance variation law).
 *
 * Normals skip the yaw rotation deliberately: trunk normals are quasi-radial
 * and card normals are crown-sphere-bent (also radial), so rotating positions
 * but not normals is visually lossless at ring distances. Lean shear ≤ ~7° —
 * likewise skipped for normals.
 */

import { DoubleSide, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import type { MeshStandardNodeMaterial } from 'three/webgpu';
import type { StorageBufferNode } from 'three/webgpu';
import {
  Fn,
  attribute,
  bool,
  float,
  frontFacing,
  instanceIndex,
  mix,
  normalLocal,
  positionLocal,
  smoothstep,
  uint,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { NB, NF, NU, NV2, NV3, NV4 } from '../gpu/TSLTypes';
import { vegWindOffset, windContext, type WindBind } from './Wind';
import { trampleOffset } from './Trample';
import { seasonBloom, seasonU } from './Season';
import { runiform } from '../gpu/RenderUniform';
import { bootQuery } from '../core/BootQuery';

/**
 * Main-camera position for LOD-ring fades. NEVER use TSL `cameraPosition`
 * for fade distances: the shadow pass binds it to the CASCADE shadow camera
 * (~lightMargin = 700 m from everything), which pushes every ring past its
 * fade-out → the dither discards 100% of veg fragments in every cascade map
 * → vegetation casts no shadows anywhere while the main view looks perfect.
 * A uniform keeps the discard pattern identical across passes.
 */
export const vegViewPos = runiform(new Vector3());

/** per-frame update (Forests.update) — feeds every ring-fade distance */
export function updateVegViewPos(camera: PerspectiveCamera): void {
  (vegViewPos as unknown as { value: Vector3 }).value.copy(camera.position);
}

export interface RingFade {
  /** dither IN as distance exceeds this (far ring of a boundary) */
  fadeInAt?: number;
  /** dither OUT as distance exceeds this (near ring of a boundary) */
  fadeOutAt?: number;
  band: number;
  /** override band width for the fade-in edge (asymmetric boundaries) */
  inBand?: number;
}

export interface InstanceBinding {
  bufA: StorageBufferNode<'vec4'>;
  bufB: StorageBufferNode<'vec4'>;
  compact: StorageBufferNode<'uint'>;
  /** offset of this draw's region in the compact list */
  groupBase: number;
  fade?: RingFade | null;
  /** per-instance tint strength (0 disables) */
  tint?: number;
  /** Use a stable object-surface pattern for rigid LOD crossfades. Whole-rock
   * thresholds make an opaque boulder switch in one frame as distance moves. */
  surfaceDither?: boolean;
  /**
   * flower/tundra plants only (vdata.x = part id): collapse the flower-head
   * verts (vdata.x high) to the plant base OUT OF BLOOM, so petals physically
   * vanish in autumn/winter instead of just recolouring. NEVER set on shrubs /
   * grass / cards — their vdata.x is a hue jitter, not a part id.
   */
  bloomCollapse?: boolean;
  /**
   * herbaceous plants that DIE BACK to the ground in winter (dwarf fireweed,
   * fern, roseroot, horsetail, cloudberry): collapse the WHOLE plant to its base
   * when winter=1, so it vanishes entirely (no baked-blossom pink poking through
   * snow). Woody/evergreen plants (birch twigs, crowberry, willow, Dryas mats)
   * do NOT set this — they persist under snow.
   */
  winterDieback?: boolean;
  /**
   * wind response (undefined = rigid: rocks, deadfall, shadow proxies).
   * Uses the baked vdata flex/phase, so only living vegetation should
   * opt in.
   */
  wind?: WindBind;
}

/** cheap pcg-ish hash of the instance slot → 0..1 (pure expression) */
export function slotHash(slot: NU, salt: number): NF {
  const a = slot.add(uint(salt)).mul(uint(747796405)).add(uint(2891336453));
  const b = a.shiftRight(a.shiftRight(uint(28)).add(uint(4))).bitXor(a).mul(uint(277803737));
  const c = b.shiftRight(uint(22)).bitXor(b);
  return float(c.bitAnd(uint(0xffffff))).div(16777216);
}

export interface FetchedInstance {
  /** (x, y, z, scale) */
  A: NV4;
  /** (yaw, leanX, leanZ, idF) */
  B: NV4;
  slot: NU;
}

/** vertex-stage fetch of the instance record through the compact list */
export function fetchInstance(bind: InstanceBinding): FetchedInstance {
  const base = runiform(uint(bind.groupBase));
  const slot = bind.compact.element(
    instanceIndex.add(base as unknown as NU),
  ) as unknown as NU;
  return {
    A: bind.bufA.element(slot) as unknown as NV4,
    B: bind.bufB.element(slot) as unknown as NV4,
    slot,
  };
}

/**
 * Dithered LOD crossfade: discard by IGN screen noise vs distance fade.
 * Lives in maskNode so it runs in the MAIN pass only — the shadow pass picks
 * maskShadowNode instead (pinned in instanceVeg). Fading casters with the
 * same IGN pattern leaves correlated texel holes in the cascade maps where
 * NEITHER ring writes depth, and shadows visibly thin at every ring band.
 *
 * COMPLEMENTARY partition: the OUTGOING ring of a boundary draws where
 * IGN < fadeOut, the INCOMING ring where IGN >= 1 − fadeIn. With matching
 * band widths fadeOut + fadeIn = 1 at every distance, so the two rings split
 * the pixel set exactly — every pixel shows exactly one LOD through the
 * band. Masking both edges with the SAME comparison (the old bug) made the
 * incoming ring's pixels a subset of the outgoing's: at the 50/50 crossover
 * half the pixels drew NEITHER ring = transparent hole bands around the
 * camera.
 */
export function applyDitherFade(
  mat: MeshStandardNodeMaterial,
  dist: NF,
  fade: RingFade,
  stableNoise?: NF,
): void {
  // Screen-coordinate IGN made rigid rocks change their visible pixels when
  // the camera merely rotated (sparkle/VCR shimmer and apparent movement).
  // Instance draws provide a camera-stable threshold shared by both LODs.
  // Callers may opt flexible card vegetation into object-surface dissolve;
  // rigid meshes must keep the shared instance threshold across both LODs.
  const ign = stableNoise ?? varying(positionLocal.x.mul(12.9898).sin().mul(43758.5453).fract());
  let draw: NB | null = null;
  if (fade.fadeInAt !== undefined) {
    const b = fade.inBand ?? fade.band;
    const fIn = varying(
      smoothstep(fade.fadeInAt - b, fade.fadeInAt + b, dist),
    );
    draw = ign.greaterThanEqual(float(1).sub(fIn));
  }
  if (fade.fadeOutAt !== undefined) {
    const fOut = varying(
      float(1).sub(
        smoothstep(fade.fadeOutAt - fade.band, fade.fadeOutAt + fade.band, dist),
      ),
    );
    const c = ign.lessThan(fOut);
    draw = draw ? (draw.and(c) as NB) : c;
  }
  if (draw) mat.maskNode = draw as unknown as typeof mat.maskNode;
}

/** per-instance hue/value jitter on top of the per-vertex vdata jitter */
export function applyInstanceTint(
  mat: MeshStandardNodeMaterial,
  slot: NU,
  tintK: number,
  packedHashes?: NV3,
): void {
  if (tintK <= 0) return;
  // Tint and LOD stability share one vec3 interpolator. These materials sit
  // at WebGPU's 16-location vertex-output limit after atmosphere/shadows;
  // a separate scalar varying for the stable LOD threshold invalidates every
  // affected pipeline even though all three values are instance-constant.
  const hashes = packedHashes ?? varying(
    vec3(slotHash(slot, 17), slotHash(slot, 91), slotHash(slot, 333)),
  );
  const h1 = hashes.x;
  const h2 = hashes.y;
  const warmCool = mix(
    vec3(1 + tintK, 1, 1 - tintK * 0.8),
    vec3(1 - tintK * 0.8, 1, 1 + tintK),
    h1,
  );
  const value = h2.mul(tintK * 1.6).add(1 - tintK * 0.8);
  const prev = mat.colorNode as unknown as NV3 | null;
  if (prev) mat.colorNode = prev.mul(warmCool).mul(value);
}

export interface InstancedHandles {
  /** world-space instance origin (vertex stage) */
  origin: NV3;
  slot: NU;
  dist: NF;
}

/**
 * Rewires `mat` for compacted-indirect instancing (transform + fade + tint).
 * Returns vertex-stage handles for callers building further on top.
 */
export function instanceVeg(
  mat: MeshStandardNodeMaterial,
  bind: InstanceBinding,
): InstancedHandles {
  const { A, B, slot } = fetchInstance(bind);

  const c = B.x.cos();
  const s = B.x.sin();
  // seasonal bloom: collapse flower-head verts (vdata.x high) to the plant base
  // out of bloom, so the petals GEOMETRICALLY vanish (nothing to rasterise).
  let localP: NV3 = positionLocal as unknown as NV3;
  if (bind.bloomCollapse) {
    const vd = attribute('vdata', 'vec4') as unknown as NV4;
    const headMask = smoothstep(0.35, 0.55, vd.x);
    const collapse = headMask.mul(float(1).sub(seasonBloom() as unknown as NF));
    localP = mix(positionLocal, vec3(0, 0, 0), collapse) as unknown as NV3;
  }
  // herbaceous winter dieback: the whole plant collapses to its base in winter
  if (bind.winterDieback) {
    localP = mix(localP, vec3(0, 0, 0), seasonU.winter as unknown as NF) as unknown as NV3;
  }
  const ls = localP.mul(A.w);
  const rx = ls.x.mul(c).add(ls.z.mul(s));
  const rz = ls.z.mul(c).sub(ls.x.mul(s));
  // lean as shear: keeps the base planted, tips the crown
  const px = rx.add(B.y.mul(ls.y));
  const pz = rz.add(B.z.mul(ls.y));
  const dist = A.xyz.sub(vegViewPos as unknown as NV3).length();
  let wpos = vec3(px, ls.y, pz).add(A.xyz);
  // hierarchical wind (Phase 6): lean + natural-frequency sway + lagged
  // branch motion + aperiodic flutter via the baked vdata flex/phase. Same
  // node feeds castShadowPositionNode below — shadows sway with their trees.
  if (bind.wind && windContext()) {
    wpos = wpos.add(
      vegWindOffset({
        origin: A.xyz,
        localY: ls.y,
        scale: A.w,
        instPhase: slotHash(slot, 211),
        dist,
        bind: bind.wind,
      }),
    ) as typeof wpos;
  }
  // player trample: flexible plants (anything wind-bound) lean away from the
  // walker's legs; rigid props (rocks, deadfall, shadow proxies) stay put.
  // Shared wpos → castShadowPositionNode bends the shadow too.
  if (bind.wind) {
    wpos = wpos.add(
      trampleOffset(
        vec2(A.x, A.z) as unknown as NV2,
        A.y as unknown as NF,
        ls.y as unknown as NF,
      ),
    ) as typeof wpos;
  }
  // Normals MUST rotate with the instance (same mechanism as three's
  // InstanceNode: assign normalLocal before returning the position). With
  // unrotated normals a yawed trunk is lit from the wrong side — reads as
  // inverted faces ("seeing the far side of the trunk").
  mat.positionNode = Fn(() => {
    const n = vec3(
      normalLocal.x.mul(c).add(normalLocal.z.mul(s)),
      normalLocal.y,
      normalLocal.z.mul(c).sub(normalLocal.x.mul(s)),
    ).toVar();
    normalLocal.assign(n);
    return wpos;
  })();
  // shadow-map pass builds its own position pipeline — feed it the same
  // instance transform or casters render at the pool origin
  (mat as unknown as { castShadowPositionNode: unknown }).castShadowPositionNode = wpos;

  const f = bind.fade;
  const instanceHashes = varying(
    vec3(slotHash(slot, 17), slotHash(slot, 91), slotHash(slot, 333)),
  ) as unknown as NV3;
  if (f && (f.fadeInAt !== undefined || f.fadeOutAt !== undefined)) {
    // Surface dissolve is only safe when corresponding LODs share a surface.
    // Rigid rock meshes do not, so their caller leaves this disabled and both
    // rings use the same per-instance threshold.
    const surfaceNoise = positionLocal
      .mul(11.37)
      .dot(vec3(12.9898, 78.233, 37.719))
      .add(instanceHashes.z.mul(19.193))
      .sin()
      .mul(43758.5453)
      .fract() as unknown as NF;
    applyDitherFade(mat, dist, f, bind.surfaceDither ? surfaceNoise : instanceHashes.z);
  }
  applyInstanceTint(mat, slot, bind.tint ?? 0.12, instanceHashes);

  // ?facedbg=1 — winding diagnosis: front faces green, back faces red
  if (bootQuery().get('facedbg') === '1') {
    mat.colorNode = frontFacing.select(vec4(0, 1, 0, 1), vec4(1, 0, 0, 1));
    mat.side = DoubleSide;
  }

  // Shadow-pass contract: three derives the caster's alpha from colorNode.a
  // and copies alphaTest over — a vec3 colorNode yields a bogus alpha below
  // the threshold and every shadow fragment silently discards. Pin alpha=1
  // and express alpha-tested cutouts through maskShadowNode instead.
  // maskShadowNode is ALWAYS set when a ring fade exists: it overrides
  // maskNode in the shadow pass, so casters keep full density through LOD
  // bands (the union of both rings' geometry — no shadow thinning).
  //
  // Caster cutout threshold runs HIGH (0.45 vs the visual alphaTest): a
  // crown's shadow is the union of many card cutouts along the sun ray, so
  // the silhouette stays solid, while the half-transparent card gradients
  // stop stamping airtight slabs into the cascade maps — the noon forest
  // floor gets its dappled sun pools back (?shadcut=N to tune).
  const rgb = mat.colorNode as unknown as NV3 | null;
  if (rgb) mat.colorNode = vec4(rgb, 1);
  const op = mat.opacityNode as unknown as NF | null;
  if (op) {
    const cut = Number(
      bootQuery().get('shadcut') ?? 0.35,
    );
    (mat as unknown as { maskShadowNode: unknown }).maskShadowNode = op.greaterThan(
      Math.max(mat.alphaTest, Number.isFinite(cut) ? cut : 0.35),
    );
  } else if (mat.maskNode) {
    (mat as unknown as { maskShadowNode: unknown }).maskShadowNode = bool(true);
  }

  return { origin: A.xyz, slot, dist };
}
