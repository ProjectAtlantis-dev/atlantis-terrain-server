import * as THREE from 'three';

// Shared runtime for settlement vector layers (buildings, roads) served with
// the /api/tiles origin convention: poll the camera's last tile-fetch
// position, fetch items in range, rebuild one merged unlit mesh in
// terrainRoot when the item set or frame changes.

const REFETCH_DISTANCE_M = 5000;
const FETCH_RANGE_M = 25000;
const POLL_MS = 2000;
const RETRY_MAX_MS = 30000;

export function createTerrainVectorLayerRuntime({
  terrainRoot, pipelineState,
  endpoint, itemsKey, logLabel,
  buildGeometry,
  buildKeyForItem = item => item.id,
  // Applies presentation-only changes to an existing mesh. Without it, such a
  // change has to fall through to a full rebuild.
  updateColors = null,
  fetchRangeM = FETCH_RANGE_M,
  refetchDistanceM = REFETCH_DISTANCE_M,
  pollMs = POLL_MS,
  retryBaseMs = pollMs,
  retryMaxMs = RETRY_MAX_MS,
  now = () => Date.now(),
  decodeResponse = response => response.json(),
  scheduleApply = callback => callback(),
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
  let unavailable = false;
  let consecutiveFailures = 0;
  let retryAtMs = 0;
  let serverPending = false;

  function disposeMesh() {
    if (!mesh) return;
    terrainRoot.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
    mesh = null;
  }

  function applyItems(items) {
    // Identity only. The frame offset is a translation and colour is a vertex
    // attribute; folding either into this key made every step of the floating
    // origin, and every roof colour that arrived late, re-triangulate the
    // whole settlement. The server origin stays in it because the item
    // coordinates themselves are expressed relative to it.
    const buildKey = `${pipelineState.originX},${pipelineState.originY}:`
      + items.map(buildKeyForItem).join(',');
    let rebuilt = false;
    if (buildKey !== lastBuildKey) {
      lastBuildKey = buildKey;
      disposeMesh();
      // Built at the origin; the frame offset is applied to the mesh below.
      const geometry = buildGeometry(items, { offsetX: 0, offsetY: 0 });
      if (geometry) {
        const material = new THREE.MeshBasicMaterial({ vertexColors: true });
        mesh = new THREE.Mesh(geometry, material);
        mesh.visible = visible;
        mesh.userData[`is${logLabel}`] = true;
        terrainRoot.add(mesh);
        rebuilt = true;
      }
    }
    if (!mesh) return;

    // A fresh build already carries the current colours.
    const recoloured = rebuilt ? false : Boolean(updateColors?.(mesh.geometry, items));

    const offsetX = pipelineState.frameOffsetX;
    const offsetY = pipelineState.frameOffsetY;
    const moved = mesh.position.x !== offsetX || mesh.position.y !== offsetY;
    if (moved) mesh.position.set(offsetX, offsetY, 0);

    if (!rebuilt && !recoloured && !moved) return;
    onMutated();
    requestRender();
  }

  async function maybeFetch({ force = false } = {}) {
    if (
      !endpoint || unavailable || fetching
      || !pipelineState.ready || !pipelineState.frameOffsetReady
      || now() < retryAtMs
    ) return;
    const queryX = pipelineState.lastFetchX;
    const queryY = pipelineState.lastFetchY;
    if (!Number.isFinite(queryX) || !Number.isFinite(queryY)) return;
    if (!force && !serverPending && lastFetchX !== null
      && Math.hypot(queryX - lastFetchX, queryY - lastFetchY) < refetchDistanceM) return;
    fetching = true;
    try {
      const url = `${endpoint}?sx=${queryX}&sy=${queryY}&range=${fetchRangeM}`
        + `&ox=${pipelineState.originX}&oy=${pipelineState.originY}`;
      const response = await fetchImpl(url);
      if (!response.ok) {
        if (response.status === 404) {
          unavailable = true;
          bootLog(`${logLabel.toLowerCase()}.unavailable`, {
            endpoint,
            status: response.status,
          }, 'warn');
          return;
        }
        const error = new Error(`${logLabel} request failed (${response.status})`);
        error.status = response.status;
        throw error;
      }
      const data = await decodeResponse(response);
      serverPending = data.shouldPoll === true;
      consecutiveFailures = 0;
      retryAtMs = 0;
      lastFetchX = queryX;
      lastFetchY = queryY;
      const items = Array.isArray(data[itemsKey]) ? data[itemsKey] : [];
      scheduleApply(() => applyItems(items));
      bootLog(`${logLabel.toLowerCase()}.fetch`, { count: data.count ?? 0, queryX, queryY });
    } catch (error) {
      consecutiveFailures += 1;
      const retryInMs = Math.min(
        retryMaxMs,
        retryBaseMs * (2 ** Math.min(consecutiveFailures - 1, 16)),
      );
      retryAtMs = now() + retryInMs;
      bootLog(`${logLabel.toLowerCase()}.fetch.error`, {
        message: error?.message ?? String(error),
        status: error?.status ?? null,
        consecutiveFailures,
        retryInMs,
      }, 'warn');
    } finally {
      fetching = false;
    }
  }

  return {
    start() {
      if (timer == null) timer = setInterval(maybeFetch, pollMs);
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
    getTransportStatus: () => ({
      unavailable,
      consecutiveFailures,
      retryAtMs,
    }),
    reconcile(items) {
      if (Array.isArray(items)) applyItems(items);
    },
    refresh: () => maybeFetch({ force: true }),
  };
}
