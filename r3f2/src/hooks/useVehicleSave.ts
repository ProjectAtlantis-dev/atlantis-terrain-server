import { useRef, useEffect } from 'react';
import { useVehicleStore } from '@/stores/vehicleStore';
import { useTerrainStore } from '@/stores/terrainStore';
import {
  VEHICLE_STATE_ENDPOINT,
  VEHICLE_SAVE_THROTTLE_MS,
  VEHICLE_SAVE_TRAILING_MS,
  VEHICLE_SAVE_FETCH_TIMEOUT_MS,
  VEHICLE_SAVE_FAILURE_COOLDOWN_MS,
  DEFAULT_LOCATION,
} from '@/utils/constants';
import { localToLatLon } from '@/utils/geodesy';
import { getTerrainMeshes, tileDepthFromId } from '@/utils/terrain';
import * as THREE from 'three';

const _downRaycaster = new THREE.Raycaster();

function getVehicleStateSnapshot(vehicleId: string) {
  const vStore = useVehicleStore.getState();
  const vehicle = vStore.registry.get(vehicleId);
  if (!vehicle || !vehicle.loaded) return null;

  const tStore = useTerrainStore.getState();
  const terrainRoot = tStore.terrainRoot;
  if (!terrainRoot) return null;

  const anchorLat = terrainRoot.userData.anchorLat ?? DEFAULT_LOCATION.lat;
  const anchorLon = terrainRoot.userData.anchorLon ?? DEFAULT_LOCATION.lon;

  const ll = localToLatLon(
    vehicle.group.position.x,
    vehicle.group.position.y,
    anchorLat,
    anchorLon
  );

  return {
    id: vehicle.id,
    lat: Number(ll.lat.toFixed(7)),
    lon: Number(ll.lon.toFixed(7)),
    headingDeg: Number((((-vehicle.headingRad * 180) / Math.PI) % 360 + 360) % 360).toFixed(2),
    z: Number(vehicle.group.position.z.toFixed(3)),
    speed: Number((vehicle.speed * 3.6).toFixed(1)),
  };
}

function sampleBestTerrainHit(vehicleId: string): { depth: number; tileId: string | null } {
  const vStore = useVehicleStore.getState();
  const vehicle = vStore.registry.get(vehicleId);
  if (!vehicle || !vehicle.loaded) return { depth: -1, tileId: null };

  const tStore = useTerrainStore.getState();
  const terrainRoot = tStore.terrainRoot;
  if (!terrainRoot) return { depth: -1, tileId: null };

  const enu = terrainRoot.userData.enu;
  if (!enu) return { depth: -1, tileId: null };

  const downDir = enu.up.clone().negate();
  const origin = vehicle.group.position.clone();
  origin.z = 20000;
  const originWorld = origin.clone();
  terrainRoot.localToWorld(originWorld);

  _downRaycaster.set(originWorld, downDir);
  const meshes = getTerrainMeshes(terrainRoot);
  const hits = _downRaycaster.intersectObjects(meshes);

  let bestDepth = -1;
  let bestTileId: string | null = null;
  for (const hit of hits) {
    const tileId = hit.object.userData?.tileId;
    if (!tileId) continue;
    const depth = tileDepthFromId(tileId);
    if (depth > bestDepth) {
      bestDepth = depth;
      bestTileId = tileId;
    }
  }
  return { depth: bestDepth, tileId: bestTileId };
}

/**
 * Vehicle state persistence hook — saves active vehicle position to asset server.
 * Throttled with trailing save on exit.
 */
export function useVehicleSave() {
  const failureUntilRef = useRef(0);
  const failureReportedRef = useRef(false);
  const lastSaveRef = useRef(0);
  const trailingRef = useRef<number>(0);

  useEffect(() => {
    // Periodic throttled save
    const interval = setInterval(() => {
      const vStore = useVehicleStore.getState();
      const activeVehicle = vStore.getActiveVehicle();
      if (!activeVehicle?.controlActive || !activeVehicle.loaded) return;

      const now = Date.now();
      if (now - lastSaveRef.current < VEHICLE_SAVE_THROTTLE_MS) return;
      if (failureUntilRef.current > now) return;

      doSave(activeVehicle.id, 'periodic');
    }, VEHICLE_SAVE_THROTTLE_MS);

    // Subscribe to vehicle control changes for trailing save
    const unsub = useVehicleStore.subscribe((state, prevState) => {
      const prev = prevState.getActiveVehicle();
      const curr = state.getActiveVehicle();
      if (prev?.controlActive && !curr?.controlActive && prev.loaded) {
        // Vehicle control just deactivated — schedule trailing save
        clearTimeout(trailingRef.current);
        trailingRef.current = window.setTimeout(() => {
          doSave(prev.id, 'exit-trailing');
        }, VEHICLE_SAVE_TRAILING_MS);
      }
    });

    return () => {
      clearInterval(interval);
      clearTimeout(trailingRef.current);
      unsub();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function doSave(vehicleId: string, reason: string) {
    const now = Date.now();
    if (failureUntilRef.current > now) return;

    const state = getVehicleStateSnapshot(vehicleId);
    if (!state) return;

    const terrainSample = sampleBestTerrainHit(vehicleId);
    const payload: any = { ...state, reason };
    if (terrainSample.depth >= 0) payload.terrainDepth = terrainSample.depth;
    if (terrainSample.tileId) payload.terrainTileId = terrainSample.tileId;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), VEHICLE_SAVE_FETCH_TIMEOUT_MS);

      const response = await fetch(VEHICLE_STATE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (!response.ok) throw new Error(`status ${response.status}`);

      lastSaveRef.current = Date.now();
      failureUntilRef.current = 0;
      failureReportedRef.current = false;
    } catch (error: any) {
      failureUntilRef.current = Date.now() + VEHICLE_SAVE_FAILURE_COOLDOWN_MS;
      if (!failureReportedRef.current) {
        console.warn('[VEHICLE SAVE] failed:', error?.message ?? error);
        failureReportedRef.current = true;
      }
    }
  }
}
