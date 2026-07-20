/**
 * uniform() tagged into three's shared per-render-call update group (the
 * same group its own cameraViewMatrix & co. live in). Bind groups in the
 * default objectGroup re-validate EVERY uniform for EVERY render object
 * each frame (Bindings._update + UniformsGroup.update ≈ 3.7 ms/frame at
 * ~720 draws, CDP-profiled bm4) — renderGroup passes the
 * NodeManager.updateGroup version gate once per shader per render call
 * instead.
 *
 * ONLY for values that are stable within a frame (mutated at most once, in
 * updateFns / render-start, before any pass renders). Never use it for a
 * value that must differ between passes of the same frame.
 */

import { renderGroup, uniform } from 'three/tsl';

type UniformFn = typeof uniform;

export const runiform: UniformFn = ((...args: unknown[]) => {
  const node = (uniform as unknown as (...a: unknown[]) => unknown)(...args) as {
    setGroup(g: unknown): unknown;
  };
  return node.setGroup(renderGroup);
}) as unknown as UniformFn;
