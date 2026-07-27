// Small-area equirectangular approximation used for the scene's local ENU
// frame. This is deliberately not an EPSG:3413 or ellipsoid conversion; use
// terrain-polar-stereo.js or three-geospatial when exact coordinates matter.
export const METRES_PER_DEGREE = 111320;

export function approximateLatLonToLocalMeters({
  lat,
  lon,
  anchorLat,
  anchorLon,
}) {
  return {
    eastM: (lon - anchorLon)
      * METRES_PER_DEGREE
      * Math.cos(anchorLat * Math.PI / 180),
    northM: (lat - anchorLat) * METRES_PER_DEGREE,
  };
}

export function localMetersToApproximateLatLon({
  eastM,
  northM,
  anchorLat,
  anchorLon,
}) {
  return {
    lat: anchorLat + northM / METRES_PER_DEGREE,
    lon: anchorLon + eastM / (
      METRES_PER_DEGREE * Math.cos(anchorLat * Math.PI / 180)
    ),
  };
}

