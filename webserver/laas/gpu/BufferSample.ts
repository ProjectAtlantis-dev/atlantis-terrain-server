/** Shared storage-buffer sampling helpers (buffers are not filterable — DIY). */

import { clamp, floor, fract, mix, vec2 } from 'three/tsl';
import type { NF, NV2 } from './TSLTypes';
import type { FloatBuffer } from './passes/HeightSynthesis';
import type { Vec2Buffer } from './passes/FlowRivers';

/**
 * Bilinear sample of a res×res float buffer at continuous grid coords
 * (texel units; (0,0) = center of texel 0). Clamps at edges.
 */
export function bilerpFloatBuffer(buf: FloatBuffer, res: number, g: NV2): NF {
  const gc = clamp(g, 0, res - 1);
  const i0 = floor(gc);
  const f = fract(gc);
  const x0 = i0.x.toInt();
  const y0 = i0.y.toInt();
  const x1 = clamp(i0.x.add(1), 0, res - 1).toInt();
  const y1 = clamp(i0.y.add(1), 0, res - 1).toInt();
  const s00 = buf.element(y0.mul(res).add(x0));
  const s10 = buf.element(y0.mul(res).add(x1));
  const s01 = buf.element(y1.mul(res).add(x0));
  const s11 = buf.element(y1.mul(res).add(x1));
  return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}

/** uv in [0,1]² → continuous grid coords for a res×res buffer */
export function uvToGrid(uv: NV2, res: number): NV2 {
  return vec2(uv.x, uv.y).mul(res).sub(0.5);
}

/** bilinear sample of a res×res vec2 buffer (e.g. the hydrology flow field) */
export function bilerpVec2Buffer(buf: Vec2Buffer, res: number, g: NV2): NV2 {
  const gc = clamp(g, 0, res - 1);
  const i0 = floor(gc);
  const f = gc.sub(i0);
  const x0 = i0.x.toInt();
  const y0 = i0.y.toInt();
  const x1 = clamp(i0.x.add(1), 0, res - 1).toInt();
  const y1 = clamp(i0.y.add(1), 0, res - 1).toInt();
  const s00 = buf.element(y0.mul(res).add(x0)) as unknown as NV2;
  const s10 = buf.element(y0.mul(res).add(x1)) as unknown as NV2;
  const s01 = buf.element(y1.mul(res).add(x0)) as unknown as NV2;
  const s11 = buf.element(y1.mul(res).add(x1)) as unknown as NV2;
  return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}
