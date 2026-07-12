import { meshUsesTextureClassification } from './terrain-tile-runtime.js';

function applyDepthOffset(mesh, depth) {
  if (!mesh?.material || !Number.isFinite(depth)) return;
  mesh.material.polygonOffset = true;
  mesh.material.polygonOffsetFactor = -depth;
  mesh.material.polygonOffsetUnits = -depth;
}

export function createTerrainMeshRuntime({
  terrainRoot,
  deferredTiles,
  buildMesh,
  applyMaterial,
  lifecycle,
  log,
  getWaterMask,
  getCurrentTileIds,
  tileDepth,
  onMeshAdded = () => {},
  vehicleNearTile = () => false,
  getVehicleDepth = () => -1,
  requestVehicleResnap = () => {},
}) {
  function rebuildWithTexture(mesh, tile, texture) {
    if (!mesh || !tile?.heightmap || !texture) return mesh;
    if (meshUsesTextureClassification(mesh, texture)) return mesh;
    const rebuilt = buildMesh(tile, texture);
    if (!rebuilt) return mesh;
    applyDepthOffset(rebuilt, tileDepth(tile.id));
    rebuilt.userData.waterMask = mesh.userData?.waterMask ?? null;
    terrainRoot.add(rebuilt);
    onMeshAdded(rebuilt);
    lifecycle.evict(mesh);
    return rebuilt;
  }

  function materialize(tileId, texture) {
    const tile = deferredTiles.get(tileId);
    if (!tile) return null;
    deferredTiles.delete(tileId);
    log(tileId, `materialize tex=${texture.image.width}x${texture.image.height}`);
    const mesh = buildMesh(tile, texture);
    if (!mesh) return null;
    applyMaterial(mesh, texture);
    mesh.userData.waterMask = getWaterMask(tileId) || null;
    const depth = tileDepth(tileId);
    applyDepthOffset(mesh, depth);
    lifecycle.replaceForMaterialized(mesh, getCurrentTileIds());
    if (vehicleNearTile(mesh.userData?.bbox)) {
      const previousDepth = getVehicleDepth();
      const reason = Number.isFinite(depth) && depth > previousDepth
        ? `terrain-refined-${previousDepth}->${depth}`
        : 'terrain-materialized-near-vehicle';
      requestVehicleResnap(reason);
    }
    return mesh;
  }

  return { rebuildWithTexture, materialize };
}
