import * as THREE from 'three';

// Shared runtime for settlement vector layers (buildings, roads) served with
// the /api/tiles origin convention: poll the camera's last tile-fetch
// position, fetch items in range, rebuild one merged unlit mesh in
// terrainRoot when the item set or frame changes.

const REFETCH_DISTANCE_M = 5000;
const FETCH_RANGE_M = 25000;
const POLL_MS = 2000;

export function createTerrainVectorLayerRuntime({
  terrainRoot, pipelineState,
  endpoint, itemsKey, logLabel,
  buildGeometry,
  buildKeyForItem = item => item.id,
  bootLog = () => {}, onMutated = () => {}, requestRender = () => {},
  fetchImpl = (...args) => fetch(...args),
}) {
  let mesh = null;
  let visible = true;
  let fetching = false;
  let lastFetchX = null;
  let lastFetchY = null;
  let lastBuildKey = null;
  let timer = null;

  function disposeMesh() {
    if (!mesh) return;
    terrainRoot.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
    mesh = null;
  }

  function applyItems(items) {
    const buildKey = `${pipelineState.originX},${pipelineState.originY},`
      + `${pipelineState.frameOffsetX},${pipelineState.frameOffsetY}:`
      + items.map(buildKeyForItem).join(',');
    if (buildKey === lastBuildKey) return;
    lastBuildKey = buildKey;
    disposeMesh();
    const geometry = buildGeometry(items, {
      offsetX: pipelineState.frameOffsetX,
      offsetY: pipelineState.frameOffsetY,
    });
    if (!geometry) return;
    const material = new THREE.MeshBasicMaterial({ vertexColors: true });
    mesh = new THREE.Mesh(geometry, material);
    mesh.visible = visible;
    mesh.userData[`is${logLabel}`] = true;
    terrainRoot.add(mesh);
    onMutated();
    requestRender();
  }

  async function maybeFetch({ force = false } = {}) {
    if (fetching || !pipelineState.ready || !pipelineState.frameOffsetReady) return;
    const queryX = pipelineState.lastFetchX;
    const queryY = pipelineState.lastFetchY;
    if (!Number.isFinite(queryX) || !Number.isFinite(queryY)) return;
    if (!force && lastFetchX !== null
      && Math.hypot(queryX - lastFetchX, queryY - lastFetchY) < REFETCH_DISTANCE_M) return;
    fetching = true;
    try {
      const url = `${endpoint}?sx=${queryX}&sy=${queryY}&range=${FETCH_RANGE_M}`
        + `&ox=${pipelineState.originX}&oy=${pipelineState.originY}`;
      const response = await fetchImpl(url);
      if (!response.ok) return;
      const data = await response.json();
      lastFetchX = queryX;
      lastFetchY = queryY;
      applyItems(Array.isArray(data[itemsKey]) ? data[itemsKey] : []);
      bootLog(`${logLabel.toLowerCase()}.fetch`, { count: data.count ?? 0, queryX, queryY });
    } catch (error) {
      bootLog(`${logLabel.toLowerCase()}.fetch.error`, { message: error.message }, 'warn');
    } finally {
      fetching = false;
    }
  }

  return {
    start() {
      if (timer == null) timer = setInterval(maybeFetch, POLL_MS);
      return maybeFetch();
    },
    stop() {
      if (timer != null) clearInterval(timer);
      timer = null;
    },
    setVisible(value) {
      visible = Boolean(value);
      if (mesh) {
        mesh.visible = visible;
        onMutated();
        requestRender();
      }
    },
    getVisible: () => visible,
    getMesh: () => mesh,
    reconcile(items) {
      if (Array.isArray(items)) applyItems(items);
    },
    refresh: () => maybeFetch({ force: true }),
  };
}
