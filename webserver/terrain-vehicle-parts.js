const DEFAULT_PARTS = Object.freeze({
  wheels: Object.freeze(['Object_8', 'Object_9', 'Object_10']),
  turret: 'Object_3',
  gun: 'Object_2',
  body: Object.freeze(['Object_4', 'Object_5', 'Object_6']),
  shield: Object.freeze(['Object_7']),
});
const DEFAULT_WHEEL_CLUSTER_SPLIT_THRESHOLD = 3500;

function cleanName(value) {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  return name || undefined;
}

function cleanNames(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  const names = value
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean);
  return [...new Set(names)];
}

function cleanVector3(value) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const numbers = value.map(Number);
  return numbers.every(Number.isFinite) ? numbers : null;
}

export function normalizeVehiclePartDefinition(definition = {}) {
  const source = definition?.parts;
  const parts = source != null && typeof source === 'object' ? source : {};
  const optionalPart = (value, fallback) => {
    const name = cleanName(value);
    return name === undefined ? fallback : name;
  };
  // A missing/non-number threshold falls back to 3500. Returning null here
  // grouped paired wheel
  // meshes into five clusters instead of the Patria's eight wheels, so each
  // merged pair rotated around the wrong shared centre.
  const configuredSplitThreshold = definition?.wheelClusterSplitThreshold;
  const splitThreshold = Number.isFinite(configuredSplitThreshold)
    ? configuredSplitThreshold
    : DEFAULT_WHEEL_CLUSTER_SPLIT_THRESHOLD;
  return {
    wheels: cleanNames(parts.wheels, DEFAULT_PARTS.wheels),
    turret: optionalPart(parts.turret, DEFAULT_PARTS.turret),
    gun: optionalPart(parts.gun, DEFAULT_PARTS.gun),
    body: cleanNames(parts.body, DEFAULT_PARTS.body),
    shield: cleanNames(parts.shield, DEFAULT_PARTS.shield),
    turretPivot: cleanVector3(parts.turretPivot),
    gunPivot: cleanVector3(parts.gunPivot),
    muzzle: cleanVector3(parts.muzzle),
    wheelClusterSplitThreshold: splitThreshold,
  };
}

function indexObjectsByName(root) {
  const byName = new Map();
  root?.traverse?.(object => {
    if (typeof object?.name !== 'string' || object.name === '') return;
    const matches = byName.get(object.name);
    if (matches == null) {
      byName.set(object.name, [object]);
    } else {
      matches.push(object);
    }
  });
  return byName;
}

function resolveMany(names, byName, missing, kind, { meshesOnly = false } = {}) {
  const resolved = [];
  for (const name of names) {
    const matches = byName.get(name) ?? [];
    const accepted = meshesOnly ? matches.filter(object => object.isMesh) : matches;
    if (accepted.length === 0) {
      missing.push({ kind, name });
      continue;
    }
    resolved.push(...accepted);
  }
  return resolved;
}

function resolveOne(name, byName, missing, kind) {
  if (name === null) return null;
  const matches = byName.get(name) ?? [];
  if (matches.length === 0) {
    missing.push({ kind, name });
    return null;
  }
  return matches[0];
}

export function discoverVehicleParts(root, definition = {}) {
  const config = normalizeVehiclePartDefinition(definition);
  const byName = indexObjectsByName(root);
  const missing = [];
  const wheels = resolveMany(config.wheels, byName, missing, 'wheel', {
    meshesOnly: true,
  });
  const turret = resolveOne(config.turret, byName, missing, 'turret');
  const gun = resolveOne(config.gun, byName, missing, 'gun');
  const body = resolveMany(config.body, byName, missing, 'body');
  const shield = resolveMany(config.shield, byName, missing, 'shield');
  return {
    config,
    wheels,
    turret,
    gun,
    body,
    shield,
    missing,
  };
}

export function summarizeVehicleParts(parts) {
  const names = objects => objects.map(object => object.name || object.type);
  return {
    wheels: names(parts?.wheels ?? []),
    turret: parts?.turret?.name ?? null,
    gun: parts?.gun?.name ?? null,
    body: names(parts?.body ?? []),
    shield: names(parts?.shield ?? []),
    missing: (parts?.missing ?? []).map(item => ({ ...item })),
    wheelClusterSplitThreshold:
      parts?.config?.wheelClusterSplitThreshold ?? null,
  };
}

function clusterVertexIndicesByY(position, splitThreshold, gap = 0.15) {
  const vertices = Array.from({ length: position.count }, (_, index) => ({
    index,
    y: position.getY(index),
  })).sort((a, b) => a.y - b.y);
  if (vertices.length === 0) return [];
  const rawClusters = [[vertices[0]]];
  for (let index = 1; index < vertices.length; index++) {
    const vertex = vertices[index];
    const previous = vertices[index - 1];
    if (vertex.y - previous.y > gap) {
      rawClusters.push([vertex]);
    } else {
      rawClusters[rawClusters.length - 1].push(vertex);
    }
  }
  const clusters = [];
  for (const cluster of rawClusters) {
    if (splitThreshold != null && cluster.length > splitThreshold) {
      const midpoint = (cluster[0].y + cluster[cluster.length - 1].y) * 0.5;
      const lower = cluster.filter(vertex => vertex.y <= midpoint);
      const upper = cluster.filter(vertex => vertex.y > midpoint);
      if (lower.length > 0) clusters.push(lower);
      if (upper.length > 0) clusters.push(upper);
    } else {
      clusters.push(cluster);
    }
  }
  return clusters.map(cluster => cluster.map(vertex => vertex.index));
}

function copyAttributeSubset(THREE, attribute, sourceIndices) {
  const itemSize = attribute.itemSize;
  if (!attribute.isInterleavedBufferAttribute) {
    const array = new attribute.array.constructor(sourceIndices.length * itemSize);
    for (let destinationIndex = 0; destinationIndex < sourceIndices.length; destinationIndex++) {
      const sourceOffset = sourceIndices[destinationIndex] * itemSize;
      const destinationOffset = destinationIndex * itemSize;
      for (let component = 0; component < itemSize; component++) {
        array[destinationOffset + component] = attribute.array[sourceOffset + component];
      }
    }
    const copy = new THREE.BufferAttribute(array, itemSize, attribute.normalized);
    copy.setUsage(attribute.usage);
    if ('gpuType' in attribute) copy.gpuType = attribute.gpuType;
    copy.name = attribute.name;
    return copy;
  }

  // GLTFLoader does not currently interleave this vehicle, but retain correctness
  // if a future asset does by materializing the decoded attribute values.
  const array = new Float32Array(sourceIndices.length * itemSize);
  const readers = [
    index => attribute.getX(index),
    index => attribute.getY(index),
    index => attribute.getZ(index),
    index => attribute.getW(index),
  ];
  for (let destinationIndex = 0; destinationIndex < sourceIndices.length; destinationIndex++) {
    for (let component = 0; component < itemSize; component++) {
      array[destinationIndex * itemSize + component] = readers[component](
        sourceIndices[destinationIndex]
      );
    }
  }
  const copy = new THREE.BufferAttribute(array, itemSize, false);
  copy.name = attribute.name;
  return copy;
}

function buildClusterGeometry(THREE, source, clusterVertices, vertexToCluster, clusterIndex) {
  const sourceIndex = source.getIndex();
  const triangleVertexCount = sourceIndex?.count ?? source.getAttribute('position').count;
  const triangleIndices = [];
  let crossingTriangleCount = 0;
  for (let offset = 0; offset + 2 < triangleVertexCount; offset += 3) {
    const a = sourceIndex ? sourceIndex.getX(offset) : offset;
    const b = sourceIndex ? sourceIndex.getX(offset + 1) : offset + 1;
    const c = sourceIndex ? sourceIndex.getX(offset + 2) : offset + 2;
    const clusterA = vertexToCluster[a];
    if (clusterA === clusterIndex && clusterA === vertexToCluster[b] && clusterA === vertexToCluster[c]) {
      triangleIndices.push(a, b, c);
    } else if (
      clusterA === clusterIndex ||
      vertexToCluster[b] === clusterIndex ||
      vertexToCluster[c] === clusterIndex
    ) {
      crossingTriangleCount++;
    }
  }
  if (triangleIndices.length === 0) {
    return { geometry: null, crossingTriangleCount };
  }

  const usedSet = new Set(triangleIndices);
  const usedSourceIndices = clusterVertices.filter(index => usedSet.has(index));
  const remap = new Map(usedSourceIndices.map((sourceVertex, index) => [sourceVertex, index]));
  const geometry = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) {
    geometry.setAttribute(name, copyAttributeSubset(THREE, attribute, usedSourceIndices));
  }
  const IndexArray = usedSourceIndices.length > 65535 ? Uint32Array : Uint16Array;
  geometry.setIndex(new THREE.BufferAttribute(
    new IndexArray(triangleIndices.map(index => remap.get(index))),
    1
  ));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, crossingTriangleCount };
}

function copyRenderableProperties(source, destination) {
  destination.castShadow = source.castShadow;
  destination.receiveShadow = source.receiveShadow;
  destination.frustumCulled = source.frustumCulled;
  destination.renderOrder = source.renderOrder;
  destination.visible = source.visible;
  destination.layers.mask = source.layers.mask;
  destination.userData = { ...source.userData };
}

/** Preserve the accepted Patria wheel animation: rotate the original vertex clusters. */
export function createVehicleWheelRig(THREE, parts) {
  const splitThreshold = parts?.config?.wheelClusterSplitThreshold ?? null;
  const clusters = [];
  const sources = [];
  const skipped = [];

  for (const sourceMesh of parts?.wheels ?? []) {
    const position = sourceMesh?.geometry?.getAttribute?.('position');
    if (
      !sourceMesh?.isMesh ||
      sourceMesh.isSkinnedMesh ||
      position == null ||
      sourceMesh.geometry.morphAttributes?.position?.length > 0
    ) {
      skipped.push({ name: sourceMesh?.name ?? null, reason: 'unsupported-wheel-mesh' });
      continue;
    }

    const sourceClusters = clusterVertexIndicesByY(position, splitThreshold);
    for (const indices of sourceClusters) {
      if (indices.length === 0) continue;
      const basePositions = new Float32Array(indices.length * 3);
      let sumX = 0;
      let sumY = 0;
      let sumZ = 0;
      indices.forEach((vertexIndex, index) => {
        const x = position.getX(vertexIndex);
        const y = position.getY(vertexIndex);
        const z = position.getZ(vertexIndex);
        basePositions[index * 3] = x;
        basePositions[index * 3 + 1] = y;
        basePositions[index * 3 + 2] = z;
        sumX += x;
        sumY += y;
        sumZ += z;
      });
      clusters.push({
        mesh: sourceMesh,
        sourceName: sourceMesh.name,
        indices,
        centerX: sumX / indices.length,
        centerY: sumY / indices.length,
        centerZ: sumZ / indices.length,
        basePositions,
      });
    }
    if (sourceClusters.length === 0) {
      skipped.push({ name: sourceMesh.name, reason: 'no-wheel-triangles' });
      continue;
    }
    sources.push({
      name: sourceMesh.name,
      sourceVertexCount: position.count,
      clusterCount: sourceClusters.length,
    });
  }

  return {
    angle: 0,
    pivots: [],
    clusters,
    sources,
    skipped,
    crossingTriangleCount: 0,
  };
}

export function spinVehicleWheelRig(rig, signedDistanceM, tireRadiusM) {
  if (
    rig == null ||
    rig.clusters.length === 0 ||
    !Number.isFinite(signedDistanceM) ||
    !Number.isFinite(tireRadiusM) ||
    tireRadiusM <= 0
  ) return false;
  rig.angle = (rig.angle - signedDistanceM / tireRadiusM) % (Math.PI * 2);
  const cos = Math.cos(rig.angle);
  const sin = Math.sin(rig.angle);
  const dirtyMeshes = new Set();
  for (const cluster of rig.clusters) {
    const position = cluster.mesh.geometry.getAttribute('position');
    cluster.indices.forEach((vertexIndex, index) => {
      const y = cluster.basePositions[index * 3 + 1] - cluster.centerY;
      const z = cluster.basePositions[index * 3 + 2] - cluster.centerZ;
      position.setY(vertexIndex, cluster.centerY + y * cos - z * sin);
      position.setZ(vertexIndex, cluster.centerZ + y * sin + z * cos);
    });
    dirtyMeshes.add(cluster.mesh);
  }
  for (const mesh of dirtyMeshes) {
    mesh.geometry.getAttribute('position').needsUpdate = true;
  }
  return signedDistanceM !== 0;
}

export function summarizeVehicleWheelRig(rig) {
  return {
    mode: 'vertex-cluster',
    pivotCount: 0,
    clusterCount: rig?.clusters?.length ?? 0,
    sources: (rig?.sources ?? []).map(source => ({ ...source })),
    skipped: (rig?.skipped ?? []).map(item => ({ ...item })),
    crossingTriangleCount: rig?.crossingTriangleCount ?? 0,
  };
}

export function getVehicleWheelContactSnapshot(THREE, rig, terrainRoot, vehicleGroup, tireRadiusM) {
  if (rig == null || terrainRoot == null || vehicleGroup == null) return [];
  terrainRoot.updateWorldMatrix(true, false);
  vehicleGroup.updateWorldMatrix(true, true);
  const downWorld = new THREE.Vector3(0, 0, -1)
    .transformDirection(vehicleGroup.matrixWorld)
    .normalize();
  return (rig.clusters ?? []).map((wheel, index) => {
    const centerWorld = wheel.mesh.localToWorld(new THREE.Vector3(
      wheel.centerX, wheel.centerY, wheel.centerZ,
    ));
    const contactWorld = centerWorld.clone().addScaledVector(downWorld, tireRadiusM);
    const centerTerrainLocal = terrainRoot.worldToLocal(centerWorld.clone());
    const contactTerrainLocal = terrainRoot.worldToLocal(contactWorld.clone());
    return {
      index,
      sourceName: wheel.sourceName,
      centerWorld: centerWorld.toArray(),
      contactWorld: contactWorld.toArray(),
      centerTerrainLocal: centerTerrainLocal.toArray(),
      contactTerrainLocal: contactTerrainLocal.toArray(),
    };
  });
}

function meanPosition(attribute, THREE) {
  const mean = new THREE.Vector3();
  if (attribute == null || attribute.count === 0) return mean;
  for (let index = 0; index < attribute.count; index++) {
    mean.x += attribute.getX(index);
    mean.y += attribute.getY(index);
    mean.z += attribute.getZ(index);
  }
  return mean.multiplyScalar(1 / attribute.count);
}

/** Creates yaw/pitch pivots for the authored Patria turret and gun meshes. */
export function createVehicleTurretRig(THREE, parts) {
  const turretMesh = parts?.turret;
  const gunMesh = parts?.gun;
  const result = {
    turretMesh: turretMesh?.isMesh ? turretMesh : null,
    gunMesh: gunMesh?.isMesh ? gunMesh : null,
    turretPivot: null,
    gunPivot: null,
    barrelTipLocal: new THREE.Vector3(),
    warnings: [],
  };
  if (!result.turretMesh) {
    result.warnings.push('turret-mesh-missing');
    return result;
  }
  const turretPosition = result.turretMesh.geometry?.getAttribute?.('position');
  if (turretPosition == null || result.turretMesh.parent == null) {
    result.warnings.push('turret-geometry-unsupported');
    return result;
  }
  if (
    result.turretMesh.position.lengthSq() > 1e-12 ||
    result.turretMesh.quaternion.angleTo(new THREE.Quaternion()) > 1e-8 ||
    result.turretMesh.scale.distanceTo(new THREE.Vector3(1, 1, 1)) > 1e-8
  ) {
    result.warnings.push('turret-nonidentity-transform');
    return result;
  }

  const authoredTurretPivot = parts.config?.turretPivot;
  const turretCenter = authoredTurretPivot != null
    ? new THREE.Vector3().fromArray(authoredTurretPivot)
    : meanPosition(turretPosition, THREE);
  if (authoredTurretPivot == null) result.warnings.push('turret-pivot-derived');
  const turretParent = result.turretMesh.parent;
  const turretSiblingIndex = turretParent.children.indexOf(result.turretMesh);
  const turretPivot = new THREE.Group();
  turretPivot.name = `${result.turretMesh.name}-yaw-pivot`;
  turretPivot.position.copy(turretCenter);
  turretParent.remove(result.turretMesh);
  turretParent.add(turretPivot);
  if (turretSiblingIndex >= 0) {
    const pivotIndex = turretParent.children.indexOf(turretPivot);
    turretParent.children.splice(pivotIndex, 1);
    turretParent.children.splice(turretSiblingIndex, 0, turretPivot);
  }
  result.turretMesh.position.copy(turretCenter).multiplyScalar(-1);
  turretPivot.add(result.turretMesh);
  result.turretPivot = turretPivot;

  if (!result.gunMesh) {
    result.warnings.push('gun-mesh-missing');
    return result;
  }
  const gunPosition = result.gunMesh.geometry?.getAttribute?.('position');
  if (gunPosition == null || result.gunMesh.parent == null) {
    result.warnings.push('gun-geometry-unsupported');
    return result;
  }
  if (
    result.gunMesh.position.lengthSq() > 1e-12 ||
    result.gunMesh.quaternion.angleTo(new THREE.Quaternion()) > 1e-8 ||
    result.gunMesh.scale.distanceTo(new THREE.Vector3(1, 1, 1)) > 1e-8
  ) {
    result.warnings.push('gun-nonidentity-transform');
    return result;
  }

  const authoredGunPivot = parts.config?.gunPivot;
  const gunCenter = authoredGunPivot != null
    ? new THREE.Vector3().fromArray(authoredGunPivot)
    : meanPosition(gunPosition, THREE);
  if (authoredGunPivot == null) result.warnings.push('gun-pivot-derived');
  let muzzleIndex = 0;
  for (let index = 1; index < gunPosition.count; index++) {
    if (gunPosition.getY(index) > gunPosition.getY(muzzleIndex)) muzzleIndex = index;
  }
  const authoredMuzzle = parts.config?.muzzle;
  const muzzle = authoredMuzzle != null
    ? new THREE.Vector3().fromArray(authoredMuzzle)
    : new THREE.Vector3(
      gunPosition.getX(muzzleIndex),
      gunPosition.getY(muzzleIndex),
      gunPosition.getZ(muzzleIndex),
    );
  if (authoredMuzzle == null) result.warnings.push('muzzle-derived');
  result.barrelTipLocal.copy(muzzle).sub(gunCenter);
  const gunPivot = new THREE.Group();
  gunPivot.name = `${result.gunMesh.name}-pitch-pivot`;
  gunPivot.position.copy(gunCenter).sub(turretCenter);
  result.gunMesh.parent.remove(result.gunMesh);
  result.gunMesh.position.copy(gunCenter).multiplyScalar(-1);
  turretPivot.add(gunPivot);
  gunPivot.add(result.gunMesh);
  result.gunPivot = gunPivot;
  return result;
}

export function summarizeVehicleTurretRig(rig) {
  return {
    turret: rig?.turretMesh?.name ?? null,
    gun: rig?.gunMesh?.name ?? null,
    hasTurretPivot: rig?.turretPivot != null,
    hasGunPivot: rig?.gunPivot != null,
    barrelTipLocal: rig?.gunPivot != null ? rig.barrelTipLocal.toArray() : null,
    warnings: [...(rig?.warnings ?? [])],
  };
}
