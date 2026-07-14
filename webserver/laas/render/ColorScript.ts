/**
 * Color script — per-time-of-day grading (Pillar E). Keyframed parameters
 * lerped by ToD and fed as uniforms into the grade node: white balance,
 * teal–orange split toning, saturation, contrast. The references use warm
 * lit rock/foliage against cool shadow/snow — strongest at golden hour.
 */

import { Vector3 } from 'three';

export interface GradeParams {
  whiteBalance: [number, number, number];
  shadowTint: [number, number, number];
  shadowAmt: number;
  highlightTint: [number, number, number];
  highlightAmt: number;
  saturation: number;
  contrast: number;
}

interface Keyframe extends GradeParams {
  t: number;
}

const KEYFRAMES: Keyframe[] = [
  // night
  { t: 0, whiteBalance: [0.82, 0.9, 1.12], shadowTint: [0.85, 0.92, 1.15], shadowAmt: 0.45, highlightTint: [0.95, 0.98, 1.1], highlightAmt: 0.2, saturation: 0.8, contrast: 1.06 },
  // dawn
  { t: 6.2, whiteBalance: [1.05, 0.97, 0.95], shadowTint: [0.85, 0.95, 1.12], shadowAmt: 0.4, highlightTint: [1.12, 1.0, 0.88], highlightAmt: 0.32, saturation: 1.1, contrast: 1.05 },
  // morning/noon — vibrant but neutral; cool shadows
  { t: 11, whiteBalance: [1.0, 1.0, 1.0], shadowTint: [0.92, 0.98, 1.06], shadowAmt: 0.28, highlightTint: [1.04, 1.01, 0.96], highlightAmt: 0.16, saturation: 1.13, contrast: 1.07 },
  { t: 15.5, whiteBalance: [1.01, 1.0, 0.99], shadowTint: [0.92, 0.98, 1.06], shadowAmt: 0.28, highlightTint: [1.05, 1.01, 0.95], highlightAmt: 0.18, saturation: 1.13, contrast: 1.07 },
  // golden — full teal–orange split per references
  { t: 19.0, whiteBalance: [1.09, 1.0, 0.9], shadowTint: [0.72, 0.91, 1.2], shadowAmt: 0.58, highlightTint: [1.22, 1.03, 0.8], highlightAmt: 0.5, saturation: 1.15, contrast: 1.1 },
  // dusk
  { t: 20.6, whiteBalance: [0.95, 0.95, 1.06], shadowTint: [0.82, 0.92, 1.16], shadowAmt: 0.5, highlightTint: [1.08, 0.98, 0.9], highlightAmt: 0.3, saturation: 0.95, contrast: 1.05 },
  // wrap to night
  { t: 24, whiteBalance: [0.82, 0.9, 1.12], shadowTint: [0.85, 0.92, 1.15], shadowAmt: 0.45, highlightTint: [0.95, 0.98, 1.1], highlightAmt: 0.2, saturation: 0.8, contrast: 1.06 },
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function lerp3(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export function gradeParamsAt(tod: number): GradeParams {
  const t = ((tod % 24) + 24) % 24;
  let i = 0;
  while (i < KEYFRAMES.length - 2 && (KEYFRAMES[i + 1] as Keyframe).t < t) i++;
  const a = KEYFRAMES[i] as Keyframe;
  const b = KEYFRAMES[i + 1] as Keyframe;
  const k = b.t === a.t ? 0 : Math.min(Math.max((t - a.t) / (b.t - a.t), 0), 1);
  return {
    whiteBalance: lerp3(a.whiteBalance, b.whiteBalance, k),
    shadowTint: lerp3(a.shadowTint, b.shadowTint, k),
    shadowAmt: lerp(a.shadowAmt, b.shadowAmt, k),
    highlightTint: lerp3(a.highlightTint, b.highlightTint, k),
    highlightAmt: lerp(a.highlightAmt, b.highlightAmt, k),
    saturation: lerp(a.saturation, b.saturation, k),
    contrast: lerp(a.contrast, b.contrast, k),
  };
}

/** mutable uniform targets for the grade node */
export class GradeUniforms {
  whiteBalance = new Vector3(1, 1, 1);
  shadowTint = new Vector3(1, 1, 1);
  highlightTint = new Vector3(1, 1, 1);
  shadowAmt = 0.3;
  highlightAmt = 0.2;
  saturation = 1;
  contrast = 1.03;

  apply(p: GradeParams): void {
    this.whiteBalance.set(...p.whiteBalance);
    this.shadowTint.set(...p.shadowTint);
    this.highlightTint.set(...p.highlightTint);
    this.shadowAmt = p.shadowAmt;
    this.highlightAmt = p.highlightAmt;
    this.saturation = p.saturation;
    this.contrast = p.contrast;
  }
}
