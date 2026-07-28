// Values that must remain identical across the deliberately separate GLSL
// and TSL terrain renderers. Backend-specific shader expression code stays in
// its own module; shared behavior and calibration values live here.
export const TERRAIN_BATHYMETRY_LAYER = 31;

export const WATER_RENDER_CONTRACT = Object.freeze({
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
