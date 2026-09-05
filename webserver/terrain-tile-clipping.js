import {
  isTerrainTileAncestor,
  parseTerrainTileId,
  terrainTileDepth,
} from './terrain-tile-address.js';

function terrainMeshByDepth(meshes) {
  return [...(meshes ?? [])]
    .filter(mesh => (
      mesh?.isMesh
      && parseTerrainTileId(mesh.userData?.tileId)
    ))
    .sort((a, b) => (
      terrainTileDepth(a.userData.tileId) - terrainTileDepth(b.userData.tileId)
      || a.userData.tileId.localeCompare(b.userData.tileId)
    ));
}

function appendSurfaceCell(indices, resolution, row, column) {
  const a = row * resolution + column;
  const b = a + 1;
  const d = a + resolution;
  const f = d + 1;
  indices.push(a, b, d, b, f, d);
}

function appendSkirtSegment(indices, start, segment, outwardWinding) {
  const topA = start + segment * 2;
  const bottomA = topA + 1;
  const topB = topA + 2;
  const bottomB = topA + 3;
  if (outwardWinding) {
    indices.push(topA, bottomA, topB, topB, bottomA, bottomB);
  } else {
    indices.push(topA, topB, bottomA, topB, bottomB, bottomA);
  }
}

function maskSignature(mask, activeSurfaceIndexCount) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < mask.length; index += 1) {
    hash ^= mask[index];
    hash = Math.imul(hash, 0x01000193);
  }
  return `${activeSurfaceIndexCount}:${(hash >>> 0).toString(16)}`;
}

function activeSkirtIndexCount(covered, cells) {
  let segments = 0;
  for (let column = 0; column < cells; column += 1) {
    if (!covered[column]) segments += 1;
    if (!covered[(cells - 1) * cells + column]) segments += 1;
  }
  for (let row = 0; row < cells; row += 1) {
    if (!covered[row * cells]) segments += 1;
    if (!covered[row * cells + cells - 1]) segments += 1;
  }
  return segments * 6;
}

function reportClipDiagnostic(onDiagnostic, details) {
  onDiagnostic?.({
    ...details,
    descendantIds: details.descendantIds?.slice(0, 32) ?? [],
    descendantsTruncated: (details.descendantIds?.length ?? 0) > 32,
  });
}

function normalizedDrawRangeCount(geometry, fullIndexCount) {
  const count = geometry?.drawRange?.count;
  return Number.isFinite(count) ? count : fullIndexCount;
}

/**
 * Carve every resident descendant footprint out of one lower-resolution tile.
 *
 * Descendants are deliberately treated as a flat union. A depth-9 parent can
 * therefore be clipped directly by depth-11 and depth-12 arrivals without a
 * depth-10 tile ever existing, and the result is independent of arrival order.
 */
export function clipTerrainMeshToDescendants(mesh, descendants, {
  onDiagnostic = null,
} = {}) {
  const tileId = mesh?.userData?.tileId;
  const parent = parseTerrainTileId(tileId);
  const resolution = Number(mesh?.userData?.resolution);
  const geometry = mesh?.geometry;
  const indexAttribute = geometry?.getIndex?.();
  if (
    !parent
    || !Number.isInteger(resolution)
    || resolution < 2
    || indexAttribute == null
  ) return false;

  const childAddresses = [...(descendants ?? [])]
    .map(descendant => parseTerrainTileId(descendant?.userData?.tileId))
    .filter(address => (
      address != null
      && isTerrainTileAncestor(tileId, address.id)
    ));
  const cells = resolution - 1;
  const fullSurfaceIndexCount = cells * cells * 6;
  const fullIndexCount = fullSurfaceIndexCount + cells * 4 * 6;
  const priorSignature = geometry.userData?.terrainClipSignature ?? '';
  const drawRangeBefore = normalizedDrawRangeCount(geometry, fullIndexCount);
  if (childAddresses.length === 0 && priorSignature === '') {
    if (drawRangeBefore !== fullIndexCount) {
      reportClipDiagnostic(onDiagnostic, {
        kind: 'state-mismatch',
        reason: 'empty-signature-nonfull-draw-range',
        tileId,
        priorSignature,
        nextSignature: '',
        descendantIds: [],
        fullSurfaceIndexCount,
        activeSurfaceIndexCount: fullSurfaceIndexCount,
        fullIndexCount,
        expectedActiveIndexCount: fullIndexCount,
        drawRangeBefore,
        indexCapacity: indexAttribute.array.length,
      });
    }
    geometry.setDrawRange(0, fullIndexCount);
    Object.assign(mesh.userData, {
      terrainClippedDescendantIds: [],
      terrainActiveSurfaceIndexCount: fullSurfaceIndexCount,
      terrainActiveIndexCount: fullIndexCount,
      terrainClipSignature: '',
    });
    return true;
  }
  const covered = new Uint8Array(cells * cells);

  for (const child of childAddresses) {
    const scale = 2 ** (child.depth - parent.depth);
    const localColumn = child.col - parent.col * scale;
    const localRow = child.row - parent.row * scale;
    // Removing every intersected coarse cell guarantees there can never be a
    // coplanar overlap. Terrain grids currently have 64 cells per side and
    // depths 8..12, so normal footprints land exactly on cell boundaries; the
    // floor/ceil form remains safe if a still-deeper level is introduced.
    const firstColumn = Math.max(0, Math.floor((localColumn * cells) / scale));
    const pastColumn = Math.min(cells, Math.ceil(((localColumn + 1) * cells) / scale));
    const firstRow = Math.max(0, Math.floor((localRow * cells) / scale));
    const pastRow = Math.min(cells, Math.ceil(((localRow + 1) * cells) / scale));
    for (let row = firstRow; row < pastRow; row += 1) {
      covered.fill(1, row * cells + firstColumn, row * cells + pastColumn);
    }
  }

  let uncoveredCellCount = 0;
  for (const value of covered) {
    if (!value) uncoveredCellCount += 1;
  }
  const activeSurfaceIndexCount = uncoveredCellCount * 6;
  const expectedActiveIndexCount = activeSurfaceIndexCount
    + activeSkirtIndexCount(covered, cells);
  const nextSignature = childAddresses.length > 0
    ? maskSignature(covered, activeSurfaceIndexCount)
    : '';
  const clippedDescendantIds = childAddresses
    .map(address => address.id)
    .sort((a, b) => terrainTileDepth(a) - terrainTileDepth(b) || a.localeCompare(b));
  if (priorSignature === nextSignature) {
    const activeIndexCount = normalizedDrawRangeCount(geometry, fullIndexCount);
    if (activeIndexCount !== expectedActiveIndexCount) {
      reportClipDiagnostic(onDiagnostic, {
        kind: 'state-mismatch',
        reason: 'matching-signature-wrong-draw-range',
        tileId,
        priorSignature,
        nextSignature,
        descendantIds: clippedDescendantIds,
        descendantCount: clippedDescendantIds.length,
        fullSurfaceIndexCount,
        activeSurfaceIndexCount,
        fullIndexCount,
        expectedActiveIndexCount,
        drawRangeBefore,
        indexCapacity: indexAttribute.array.length,
      });
    }
    Object.assign(mesh.userData, {
      terrainClippedDescendantIds: clippedDescendantIds,
      terrainActiveSurfaceIndexCount: activeSurfaceIndexCount,
      terrainActiveIndexCount: activeIndexCount,
      terrainClipSignature: nextSignature,
    });
    return true;
  }

  const indices = [];
  for (let row = 0; row < cells; row += 1) {
    for (let column = 0; column < cells; column += 1) {
      if (covered[row * cells + column]) continue;
      appendSurfaceCell(indices, resolution, row, column);
    }
  }

  // Keep the original four outside skirts, except where the adjoining surface
  // cell was carved away. Descendant skirts then own the complete slot edge,
  // including slots that touch an ancestor boundary.
  const surfaceVertices = resolution * resolution;
  const southStart = surfaceVertices;
  const northStart = southStart + resolution * 2;
  const westStart = northStart + resolution * 2;
  const eastStart = westStart + resolution * 2;
  for (let column = 0; column < cells; column += 1) {
    if (!covered[column]) appendSkirtSegment(indices, southStart, column, true);
    if (!covered[(cells - 1) * cells + column]) {
      appendSkirtSegment(indices, northStart, column, false);
    }
  }
  for (let row = 0; row < cells; row += 1) {
    if (!covered[row * cells]) appendSkirtSegment(indices, westStart, row, false);
    if (!covered[row * cells + cells - 1]) {
      appendSkirtSegment(indices, eastStart, row, true);
    }
  }

  // The complete grid owns the largest possible index buffer. Reuse it so LOD
  // churn only changes its contents and draw range instead of allocating a new
  // GPU buffer on every descendant arrival.
  if (indices.length > indexAttribute.array.length) {
    reportClipDiagnostic(onDiagnostic, {
      kind: 'state-mismatch',
      reason: 'index-capacity-too-small',
      tileId,
      priorSignature,
      nextSignature,
      descendantIds: clippedDescendantIds,
      descendantCount: clippedDescendantIds.length,
      fullSurfaceIndexCount,
      activeSurfaceIndexCount,
      fullIndexCount,
      expectedActiveIndexCount,
      drawRangeBefore,
      indexCapacity: indexAttribute.array.length,
    });
    return false;
  }
  indexAttribute.array.set(indices);
  indexAttribute.needsUpdate = true;
  geometry.setDrawRange(0, indices.length);

  geometry.userData.terrainClipSignature = nextSignature;
  Object.assign(mesh.userData, {
    terrainClippedDescendantIds: clippedDescendantIds,
    terrainActiveSurfaceIndexCount: activeSurfaceIndexCount,
    terrainActiveIndexCount: indices.length,
    terrainClipSignature: nextSignature,
  });
  reportClipDiagnostic(onDiagnostic, {
    kind: nextSignature === '' ? 'restore' : 'apply',
    tileId,
    priorSignature,
    nextSignature,
    descendantIds: clippedDescendantIds,
    descendantCount: clippedDescendantIds.length,
    fullSurfaceIndexCount,
    activeSurfaceIndexCount,
    fullIndexCount,
    expectedActiveIndexCount,
    activeIndexCount: indices.length,
    drawRangeBefore,
    drawRangeAfter: geometry.drawRange?.count ?? null,
    indexCapacity: indexAttribute.array.length,
  });
  return true;
}

/** Recompute every slot from current residency; no previous arrival state is used. */
export function recomputeTerrainResidencyClipping(meshes, options = {}) {
  const ordered = terrainMeshByDepth(meshes);
  const failedPairs = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const ancestor = ordered[index];
    const ancestorId = ancestor.userData.tileId;
    const descendants = ordered.slice(index + 1).filter(descendant => (
      isTerrainTileAncestor(ancestorId, descendant.userData.tileId)
    ));
    if (clipTerrainMeshToDescendants(ancestor, descendants, options)) continue;
    for (const descendant of descendants) {
      failedPairs.push({
        ancestorId,
        descendantId: descendant.userData.tileId,
        depthGap: terrainTileDepth(descendant.userData.tileId) - terrainTileDepth(ancestorId),
      });
    }
  }
  return { failedPairs };
}
