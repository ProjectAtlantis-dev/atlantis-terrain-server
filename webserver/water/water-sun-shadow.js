// A cached, coarse height-field shadow for direct water glint. The surface
// pays one filtered lookup; only terrain captures or a changed sun rerun the
// march. No additional terrain draw, depth readback, or per-pixel ray march.
export const WATER_SUN_SHADOW_SIZE = 256;
export const WATER_SUN_SHADOW_STEPS = 64;
export const WATER_SUN_SHADOW_REACH_M = 15000;
export const WATER_SUN_SHADOW_BIAS_M = 2;
export const WATER_SUN_SHADOW_SOFTNESS_M = 20;
export const WATER_SUN_SHADOW_ANGULAR_SOFTNESS = 0.00465;
const SUN_CHANGE_CHORD_SQ = (2 * Math.sin(0.1 * Math.PI / 360)) ** 2;

export function createWaterSunShadowCache(render) {
  let captured = false;
  let dirty = false;
  let previousSun = null;
  let previousWaterline = null;
  return {
    invalidate() { captured = true; dirty = true; },
    update(sun, waterline) {
      if (!captured) return false;
      const changed = !previousSun
        || (sun.x - previousSun.x) ** 2 + (sun.y - previousSun.y) ** 2
          + (sun.z - previousSun.z) ** 2 >= SUN_CHANGE_CHORD_SQ;
      if (!dirty && !changed && waterline === previousWaterline) return false;
      render();
      previousSun = { x: sun.x, y: sun.y, z: sun.z };
      previousWaterline = waterline;
      dirty = false;
      return true;
    },
  };
}
