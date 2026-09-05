// Values that must remain identical across the deliberately separate GLSL
// and TSL terrain renderers. Backend-specific shader expression code stays in
// its own module; shared behavior and calibration values live here.
export const TERRAIN_BATHYMETRY_LAYER = 31;

export const WATER_RENDER_CONTRACT = Object.freeze({
  // Ready composition guarantees a gap: accepted water is at most -1 m in
  // terrain coordinates after the shoreline drop, while rejected
  // nonpositive DEM samples are clipped to exactly 0 m. Relative to the
  // +0.5 m waterline those become <= -1.5 m and -0.5 m respectively. Fade
  // inside that empty interval so the FFT surface cannot paint or z-fight on
  // the zero plate. Uncovered capture pixels retain the explicit -5 m ocean
  // fallback and bypass this covered-terrain mask.
  waterCoverageSeabedStartM: -1.25,
  waterCoverageSeabedEndM: -0.75,
  fetchFractionScale: 3,
  shoreFoamDistanceStartM: 700,
  shoreFoamDistanceEndM: 2800,
  shoreFoamAlphaMaximum: 0.75,
  microGateMinimum: 0.22,
  microGateStart: 0.02,
  microGateEnd: 0.25,
  facetGainMaximum: 1.35,
  facetGainStartM: 300,
  facetGainEndM: 2500,
  crestExponent: 96,
  crestFilterStartM: 450,
  crestFilterEndM: 2200,
});
