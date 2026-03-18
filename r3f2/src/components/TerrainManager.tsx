import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useTerrainStore } from '@/stores/terrainStore';
import { useControlsStore } from '@/stores/controlsStore';
import { buildTileMesh, applyTextureToMesh } from '@/utils/terrain';
import { localToLatLon } from '@/utils/geodesy';
import type { TileData } from '@/types/terrain';
import {
  REFETCH_DIST,
  PREVIEW_MAX_DEPTH,
  MESH_BUILD_BUDGET,
  TEX_MAX,
  DEFAULT_LOCATION,
} from '@/utils/constants';

/**
 * TerrainManager: fetches tile data from the Flask server,
 * builds meshes, applies textures, manages the tile lifecycle.
 */
export function TerrainManager() {
  const fetchingRef = useRef(false);
  const lastTexRefreshRef = useRef(0);
  const lastFetchTriggerMs = useRef(0);

  useEffect(() => {
    // Initial tile fetch
    const terrainRoot = useTerrainStore.getState().terrainRoot;
    if (terrainRoot) {
      fetchTiles();
    }

    // Subscribe to terrainRoot changes
    let prevRoot = useTerrainStore.getState().terrainRoot;
    const unsub = useTerrainStore.subscribe((state) => {
      if (state.terrainRoot && state.terrainRoot !== prevRoot) {
        prevRoot = state.terrainRoot;
        fetchTiles();
      }
    });

    return unsub;
  }, []);

  useFrame((state, delta) => {
    const tStore = useTerrainStore.getState();
    const terrainRoot = tStore.terrainRoot;
    if (!terrainRoot || tStore.isFirstLoad) return;

    const enu = terrainRoot.userData.enu;
    if (!enu) return;
    const anchorLat = terrainRoot.userData.anchorLat ?? DEFAULT_LOCATION.lat;
    const anchorLon = terrainRoot.userData.anchorLon ?? DEFAULT_LOCATION.lon;

    // Camera position in stereo coords
    const camera = state.camera;
    const rel = camera.position.clone().sub(enu.anchorPosition);
    const eastM = rel.dot(enu.east);
    const northM = rel.dot(enu.north);
    const camLat = anchorLat + northM / 111320;
    const camLon = anchorLon + eastM / (111320 * Math.cos(anchorLat * Math.PI / 180));
    const approxStereoX = tStore.originX + (camLon - anchorLon) * 111320 * Math.cos(anchorLat * Math.PI / 180);
    const approxStereoY = tStore.originY + (camLat - anchorLat) * 111320;

    tStore.setCamStereo(approxStereoX, approxStereoY);

    const fdx = approxStereoX - tStore.lastFetchX;
    const fdy = approxStereoY - tStore.lastFetchY;
    const fetchDist = Math.sqrt(fdx * fdx + fdy * fdy);
    const nowMs = performance.now();

    if (fetchDist > REFETCH_DIST && nowMs - lastFetchTriggerMs.current > 500) {
      lastFetchTriggerMs.current = nowMs;
      fetchTiles(camLat, camLon);
    }

    // Periodic texture refresh (~1 Hz)
    const elapsed = state.clock.elapsedTime;
    if (tStore.lastTiles && elapsed - lastTexRefreshRef.current > 1.0) {
      lastTexRefreshRef.current = elapsed;
      updateTextures(tStore.lastTiles);
    }
  });

  return null;
}

async function fetchTiles(lat?: number, lon?: number) {
  const tStore = useTerrainStore.getState();
  if (tStore.fetching) return;
  tStore.setFetching(true);

  const terrainRoot = tStore.terrainRoot;
  if (!terrainRoot) {
    tStore.setFetching(false);
    return;
  }

  const anchorLat = terrainRoot.userData.anchorLat ?? DEFAULT_LOCATION.lat;
  const anchorLon = terrainRoot.userData.anchorLon ?? DEFAULT_LOCATION.lon;
  const fetchLat = lat ?? anchorLat;
  const fetchLon = lon ?? anchorLon;

  try {
    const response = await fetch(`/api/tiles?lat=${fetchLat}&lon=${fetchLon}`);
    if (!response.ok) throw new Error(`status ${response.status}`);
    const data = await response.json();

    if (!Array.isArray(data.tiles)) throw new Error('no tiles array');

    // Set origin on first load
    if (!tStore.originSet && data.tiles.length > 0) {
      const first = data.tiles[0];
      const ox = (first.bbox[0] + first.bbox[2]) / 2;
      const oy = (first.bbox[1] + first.bbox[3]) / 2;
      tStore.setOrigin(ox, oy);
      // Frame offset: shift server stereo coords into ENU-local frame
      const local = { x: 0, y: 0 }; // anchor is at ENU origin
      tStore.setFrameOffset(-ox + local.x, -oy + local.y);
    }

    tStore.setLastFetch(
      tStore.originX + (fetchLon - anchorLon) * 111320 * Math.cos(anchorLat * Math.PI / 180),
      tStore.originY + (fetchLat - anchorLat) * 111320
    );
    tStore.setLastTiles(data.tiles);
    processTileData(data.tiles);

    if (tStore.isFirstLoad) {
      tStore.setFirstLoad(false);
      // Trigger a second pass for full-depth tiles
      setTimeout(() => fetchTiles(fetchLat, fetchLon), 500);
    }
  } catch (err) {
    console.warn('[TERRAIN] fetch failed:', err);
  } finally {
    tStore.setFetching(false);
  }
}

function processTileData(tiles: TileData[]) {
  const tStore = useTerrainStore.getState();
  const terrainRoot = tStore.terrainRoot;
  if (!terrainRoot) return;

  const newTileIds = new Set(tiles.map((t) => t.id));
  const currentTiles = tStore.tiles;

  // Remove tiles that are no longer in the response
  for (const [id] of currentTiles) {
    if (!newTileIds.has(id)) {
      tStore.removeTile(id);
    }
  }

  // Add new tiles
  const { frameOffsetX, frameOffsetY, texCache } = tStore;
  let meshCount = 0;

  for (const tile of tiles) {
    if (currentTiles.has(tile.id)) continue;
    if (!tile.heightmap) continue;
    if (meshCount >= MESH_BUILD_BUDGET) {
      tStore.addDeferred(tile.id, tile);
      continue;
    }

    const cachedTex = texCache.get(tile.id) ?? null;
    const mesh = buildTileMesh(tile, cachedTex, frameOffsetX, frameOffsetY);
    terrainRoot.add(mesh);

    tStore.addTile(tile.id, {
      mesh,
      tileId: tile.id,
      depth: tile.depth,
      bbox: tile.bbox as [number, number, number, number],
      hasTexture: cachedTex !== null,
      textureSource: cachedTex ? (tStore.texSource.get(tile.id) ?? null) : null,
    });
    meshCount++;
  }
}

async function updateTextures(tiles: TileData[]) {
  const tStore = useTerrainStore.getState();
  const terrainRoot = tStore.terrainRoot;
  if (!terrainRoot) return;

  for (const tile of tiles) {
    const tileState = tStore.tiles.get(tile.id);
    if (!tileState || tileState.hasTexture) continue;

    // Check texture cache first
    const cached = tStore.texCache.get(tile.id);
    if (cached) {
      applyTextureToMesh(tileState.mesh, cached);
      tStore.setTileTexture(tile.id, cached, tStore.texSource.get(tile.id) ?? 'cache');
      continue;
    }

    // Check if already in-flight
    if (tStore.texInflight.has(tile.id)) continue;

    // Fetch texture
    const controller = new AbortController();
    const inflight = new Map(tStore.texInflight);
    inflight.set(tile.id, controller);
    useTerrainStore.setState({ texInflight: inflight });

    try {
      const response = await fetch(`/api/texture/${tile.id}`, { signal: controller.signal });
      if (!response.ok) continue;
      const blob = await response.blob();
      const imageBitmap = await createImageBitmap(blob);
      const texture = new THREE.CanvasTexture(imageBitmap as any);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;

      tStore.cacheTexture(tile.id, texture, 'fetched');

      // Apply to mesh if still present
      const currentState = useTerrainStore.getState().tiles.get(tile.id);
      if (currentState) {
        applyTextureToMesh(currentState.mesh, texture);
        tStore.setTileTexture(tile.id, texture, 'fetched');
      }
    } catch {
      // Texture fetch failed — will retry next cycle
    } finally {
      const inflight = new Map(useTerrainStore.getState().texInflight);
      inflight.delete(tile.id);
      useTerrainStore.setState({ texInflight: inflight });
    }
  }
}
