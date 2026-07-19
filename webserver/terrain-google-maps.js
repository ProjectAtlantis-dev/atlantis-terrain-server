const RAD_TO_DEG = 180 / Math.PI;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function googleMaps3dCamera({ alt, directionEast, directionNorth, directionUp, fov }) {
  const heading = (Math.atan2(directionEast, directionNorth) * RAD_TO_DEG + 360) % 360;
  const elevation = Math.asin(clamp(directionUp, -1, 1)) * RAD_TO_DEG;
  return {
    altitude: clamp(Number(alt) || 0, 25, 10_000_000),
    fov: clamp(Number(fov) || 60, 10, 100),
    heading,
    tilt: clamp(90 + elevation, 0, 90),
  };
}

export function googleMaps3dUrl({ lat, lon, ...pose }) {
  const camera = googleMaps3dCamera(pose);
  const values = [
    Number(lat).toFixed(7),
    Number(lon).toFixed(7),
    `${camera.altitude.toFixed(1)}a`,
    `${camera.fov.toFixed(1)}y`,
    `${camera.heading.toFixed(2)}h`,
    `${camera.tilt.toFixed(2)}t`,
  ];
  return `https://www.google.com/maps/@${values.join(',')}/data=!3m1!1e3`;
}
