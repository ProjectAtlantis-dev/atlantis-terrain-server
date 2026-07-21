import * as THREE from 'three';

// CPU-side sun/sky palette for the water surface, derived from the real sun
// elevation (port of ~/work/ocean2 updateSun). The water's Fresnel reflection
// needs an analytic sky because the Takram atmosphere only exists as a post
// pass — it cannot be sampled from a surface shader. Haze/fog is NOT part of
// this palette: aerial perspective is owned by the scene pipeline.
//
// Two horizon colors on purpose: only the sky near the sun warms at dusk; the
// anti-sun horizon cools and dims. Open water mostly reflects the cool side —
// one shared horizon color turns the whole ocean red at sunset.

// Keep dusk radiance chromatic before AGX compresses it.  The old red-heavy,
// low-saturation values landed in the tone mapper's copper/brown range once
// mixed with the dark satellite water.
const DUSK_SUN = new THREE.Color(1.0, 0.30, 0.045);
const DAY_SUN = new THREE.Color(1.0, 0.96, 0.90);
const DUSK_ZENITH = new THREE.Color(0.12, 0.09, 0.25);
const DAY_ZENITH = new THREE.Color(0.115, 0.30, 0.62);
// Orange is confined to the sunward path; the surrounding dusk water reflects
// the violet sky on either side.
const DUSK_HORIZON = new THREE.Color(1.0, 0.27, 0.025);
const DAY_HORIZON = new THREE.Color(0.55, 0.70, 0.84);
const DUSK_HORIZON_COOL = new THREE.Color(0.20, 0.035, 0.44);
const CLEAR_DEEP = new THREE.Color(0.032, 0.046, 0.048);
const OVERCAST_DEEP = new THREE.Color(0.024, 0.035, 0.037);
const CLEAR_SCATTER = new THREE.Color(0.020, 0.16, 0.18);
const OVERCAST_SCATTER = new THREE.Color(0.05, 0.14, 0.14);
const scratch = new THREE.Color();

export function createWaterPalette() {
  return {
    sun: new THREE.Color(),
    zenith: new THREE.Color(),
    horizon: new THREE.Color(),      // sunward horizon (goes warm at dusk)
    horizonCool: new THREE.Color(),  // anti-sun horizon (stays cool, just dims)
    deep: new THREE.Color(),
    scatter: new THREE.Color(),
  };
}

export function computeWaterPalette(palette, { sunElevationDeg, cloudiness = 0 }) {
  const day = THREE.MathUtils.smoothstep(sunElevationDeg, 3, 28);
  palette.sun.copy(DUSK_SUN).lerp(DAY_SUN, day).multiplyScalar(3.2);
  palette.zenith.copy(DUSK_ZENITH).lerp(DAY_ZENITH, day);
  palette.horizon.copy(DUSK_HORIZON).lerp(DAY_HORIZON, day);
  palette.horizonCool.copy(DUSK_HORIZON_COOL).lerp(DAY_HORIZON, day);

  // Overcast REMOVES light: the disk diffuses away and the gray dome is
  // dimmer than the clear sky it replaces, so the water darkens and dulls
  // toward teal-gray. Matching a bright overcast photo is the camera's
  // exposure job, not the clouds adding radiance. Lerping after the
  // elevation palette lets cloudiness stack on any sun angle.
  const c = cloudiness;
  const dayLevel = 0.35 + 0.65 * day;
  palette.sun.lerp(scratch.setRGB(0.5 * dayLevel, 0.5 * dayLevel, 0.5 * dayLevel), c);
  palette.zenith.lerp(scratch.setRGB(0.42, 0.44, 0.465).multiplyScalar(dayLevel), c);
  palette.horizon.lerp(scratch.setRGB(0.31, 0.33, 0.35).multiplyScalar(dayLevel), c);
  palette.horizonCool.lerp(scratch.setRGB(0.31, 0.33, 0.35).multiplyScalar(dayLevel), c);
  palette.deep.copy(CLEAR_DEEP).lerp(OVERCAST_DEEP, c);
  palette.scatter.copy(CLEAR_SCATTER).lerp(OVERCAST_SCATTER, c);
  return palette;
}
