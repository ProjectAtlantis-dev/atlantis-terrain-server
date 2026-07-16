export function applyTerrainAvailabilityStatus({
  terrainRoot, missing, downloading, applyStatus,
}) {
  const downloadingIds = new Set(downloading || []);
  const missingIds = new Set((missing || []).map(tile => tile.id));
  let changed = 0;
  for (const mesh of terrainRoot.children) {
    const tileId = mesh.userData?.tileId;
    if (!mesh.isMesh || !tileId || mesh.material?.map) continue;
    const status = downloadingIds.has(tileId)
      ? 'downloading'
      : (missingIds.has(tileId) ? 'missing' : null);
    if (!status) continue;
    applyStatus(mesh, status);
    changed += 1;
  }
  return changed;
}
