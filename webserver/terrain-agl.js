import { terrainTileDepth } from './terrain-tile-address.js';

export const MAX_TERRAIN_AGL_M = 10_000;

export function terrainAglFromIntersections(
  intersections,
  maxDistance = MAX_TERRAIN_AGL_M,
) {
  const distance = intersections?.[0]?.distance;
  if (
    !Number.isFinite(distance)
    || distance < 0
    || distance > maxDistance
  ) {
    return null;
  }
  return distance;
}

function tileDepth(mesh) {
  return terrainTileDepth(mesh?.userData?.tileId);
}

function positionZ(attribute, index) {
  if (typeof attribute?.getZ === 'function') return attribute.getZ(index);
  return attribute?.array?.[index * (attribute.itemSize ?? 3) + 2];
}

export function terrainSurfaceHeightAt(meshes, x, y) {
  let selected = null;
  let selectedDepth = -1;
  for (const mesh of meshes ?? []) {
    const bbox = mesh?.userData?.bbox;
    if (
      !Array.isArray(bbox)
      || bbox.length !== 4
      || x < bbox[0]
      || x > bbox[2]
      || y < bbox[1]
      || y > bbox[3]
    ) continue;
    const depth = tileDepth(mesh);
    if (selected == null || depth > selectedDepth) {
      selected = mesh;
      selectedDepth = depth;
    }
  }
  if (selected == null) return null;

  const [xMin, yMin, xMax, yMax] = selected.userData.bbox;
  const resolution = selected.userData.resolution;
  const positions = selected.geometry?.getAttribute?.('position')
    ?? selected.geometry?.attributes?.position;
  if (
    !Number.isInteger(resolution)
    || resolution < 2
    || !(xMax > xMin)
    || !(yMax > yMin)
    || positions == null
  ) return null;

  const gridX = Math.max(0, Math.min(
    resolution - 1,
    ((x - xMin) / (xMax - xMin)) * (resolution - 1),
  ));
  const gridY = Math.max(0, Math.min(
    resolution - 1,
    ((y - yMin) / (yMax - yMin)) * (resolution - 1),
  ));
  const column = Math.min(resolution - 2, Math.floor(gridX));
  const row = Math.min(resolution - 2, Math.floor(gridY));
  const fractionX = gridX - column;
  const fractionY = gridY - row;
  const southwest = row * resolution + column;
  const southeast = southwest + 1;
  const northwest = southwest + resolution;
  const northeast = northwest + 1;

  const zSouthwest = positionZ(positions, southwest);
  const zSoutheast = positionZ(positions, southeast);
  const zNorthwest = positionZ(positions, northwest);
  const zNortheast = positionZ(positions, northeast);
  if (![zSouthwest, zSoutheast, zNorthwest, zNortheast].every(Number.isFinite)) {
    return null;
  }

  // Match the two triangles emitted by terrain-mesh-builder exactly.
  if (fractionX + fractionY <= 1) {
    return zSouthwest
      + (zSoutheast - zSouthwest) * fractionX
      + (zNorthwest - zSouthwest) * fractionY;
  }
  return (
    (1 - fractionY) * zSoutheast
    + (1 - fractionX) * zNorthwest
    + (fractionX + fractionY - 1) * zNortheast
  );
}

export function terrainAglFromSurface(
  cameraHeight,
  surfaceHeight,
  maxDistance = MAX_TERRAIN_AGL_M,
) {
  return terrainAglFromIntersections(
    surfaceHeight == null ? [] : [{ distance: cameraHeight - surfaceHeight }],
    maxDistance,
  );
}
