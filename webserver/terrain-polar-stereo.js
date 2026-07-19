const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;
const ECCENTRICITY = Math.sqrt(WGS84_F * (2 - WGS84_F));
const STANDARD_PARALLEL = 70 * DEG_TO_RAD;
const CENTRAL_MERIDIAN = -45;
const MC = Math.cos(STANDARD_PARALLEL) / Math.sqrt(
  1 - ECCENTRICITY ** 2 * Math.sin(STANDARD_PARALLEL) ** 2,
);
const TC = Math.tan(Math.PI / 4 - STANDARD_PARALLEL / 2) / Math.pow(
  (1 - ECCENTRICITY * Math.sin(STANDARD_PARALLEL)) /
    (1 + ECCENTRICITY * Math.sin(STANDARD_PARALLEL)),
  ECCENTRICITY / 2,
);

export function wgs84ToEpsg3413(lat, lon) {
  const latitude = Number(lat) * DEG_TO_RAD;
  const longitudeDelta = (Number(lon) - CENTRAL_MERIDIAN) * DEG_TO_RAD;
  const sinLatitude = Math.sin(latitude);
  const t = Math.tan(Math.PI / 4 - latitude / 2) / Math.pow(
    (1 - ECCENTRICITY * sinLatitude) / (1 + ECCENTRICITY * sinLatitude),
    ECCENTRICITY / 2,
  );
  const rho = WGS84_A * MC * t / TC;
  return { x: rho * Math.sin(longitudeDelta), y: -rho * Math.cos(longitudeDelta) };
}

export function epsg3413ToWgs84(x, y) {
  const rho = Math.hypot(x, y);
  if (rho === 0) return { lat: 90, lon: CENTRAL_MERIDIAN };
  const t = rho * TC / (WGS84_A * MC);
  let latitude = Math.PI / 2 - 2 * Math.atan(t);
  for (let iteration = 0; iteration < 8; iteration += 1) {
    latitude = Math.PI / 2 - 2 * Math.atan(t * Math.pow(
      (1 - ECCENTRICITY * Math.sin(latitude)) /
        (1 + ECCENTRICITY * Math.sin(latitude)),
      ECCENTRICITY / 2,
    ));
  }
  let longitude = CENTRAL_MERIDIAN + Math.atan2(x, -y) * RAD_TO_DEG;
  longitude = ((longitude + 180) % 360 + 360) % 360 - 180;
  return { lat: latitude * RAD_TO_DEG, lon: longitude };
}

export function epsg3413DirectionBearing({ x, y, directionX, directionY }) {
  if (Math.hypot(directionX, directionY) < 1e-12) return 0;
  const { lon } = epsg3413ToWgs84(x, y);
  const gridBearing = Math.atan2(directionX, directionY) * RAD_TO_DEG;
  return (gridBearing + lon - CENTRAL_MERIDIAN + 360) % 360;
}
