/**
 * Heightfield synthesis — bakes the macro terrain function into storage
 * buffers (height + hardness) at a given resolution. Used at HEIGHT_RES for
 * the final field and SIM_RES for the erosion working grid.
 */

import type { Renderer, StorageBufferNode } from 'three/webgpu';
import { Fn, If, Return, float, instanceIndex, instancedArray, vec2 } from 'three/tsl';
import type { MacroParams } from '../../world/MacroMap';
import { macroTerrain } from '../../world/MacroMap';
import { WORLD_SIZE } from '../../world/WorldConst';

export type FloatBuffer = StorageBufferNode<'float'>;

export interface SynthesisResult {
  /** height meters, res×res row-major */
  height: FloatBuffer;
  /** rock hardness 0..1 */
  hardness: FloatBuffer;
  res: number;
}

export async function runHeightSynthesis(
  renderer: Renderer,
  res: number,
  mp: MacroParams,
): Promise<SynthesisResult> {
  const height = instancedArray(res * res, 'float');
  const hardness = instancedArray(res * res, 'float');

  const kernel = Fn(() => {
    const i = instanceIndex;
    If(i.greaterThanEqual(res * res), () => {
      Return();
    });
    const x = i.mod(res);
    const y = i.div(res);
    const wpos = vec2(float(x).add(0.5), float(y).add(0.5))
      .div(res)
      .sub(0.5)
      .mul(WORLD_SIZE);
    const m = macroTerrain(wpos, mp, 'full');
    height.element(i).assign(m.height);
    hardness.element(i).assign(m.hardness);
  })().compute(res * res);
  kernel.setName(`heightSynthesis_${res}`);

  await renderer.computeAsync(kernel);
  return { height, hardness, res };
}
