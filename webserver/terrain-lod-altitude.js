export const DEFAULT_LOD_ALTITUDE_HYSTERESIS = 0.15;

/**
 * Hold the LOD altitude steady until clearance genuinely changes.
 *
 * The server caps LOD depth with a hard step: a depth is dropped the moment
 * AGL exceeds a fixed multiple of that depth's tile width. That step was
 * harmless while the input was camera altitude, which is flat during level
 * flight. Switching the input to AGL made it terrain-relative, so a camera
 * holding altitude over undulating ground now sweeps across a threshold every
 * few seconds — and each crossing swaps the whole resident tile set.
 *
 * LOD should follow sustained clearance, not every ridge and fjord passing
 * underneath. Holding the previous value until the measurement leaves a
 * relative band keeps a boundary-straddling cruise on one side of the step
 * while still tracking a real climb or descent, which necessarily leaves the
 * band. Damping the request rather than the server's rule keeps the fix in one
 * place and needs no protocol change.
 */
export function createLodAltitudeStabilizer({
  hysteresis = DEFAULT_LOD_ALTITUDE_HYSTERESIS,
  minimumBandAltitude = 100,
} = {}) {
  if (!Number.isFinite(hysteresis) || hysteresis < 0) {
    throw new RangeError('hysteresis must be a non-negative fraction');
  }
  let held = null;

  return {
    get held() { return held; },

    stabilize(measured) {
      if (!Number.isFinite(measured) || measured < 0) return measured;
      if (held == null) {
        held = measured;
        return held;
      }
      // Near the ground a proportional band collapses to nothing, so floor it:
      // low-level flight should not re-request topology on every hillock.
      const band = hysteresis * Math.max(held, minimumBandAltitude);
      if (Math.abs(measured - held) > band) held = measured;
      return held;
    },

    reset() { held = null; },
  };
}
