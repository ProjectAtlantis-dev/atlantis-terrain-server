import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { StartupAssets } from '@/hooks/useAssetServer';
import { useTerrainStore } from '@/stores/terrainStore';
import { useControlsStore } from '@/stores/controlsStore';
import { useUIStore } from '@/stores/uiStore';
import { latLonToLocal } from '@/utils/geodesy';
import { getTerrainMeshes, tileDepthFromId } from '@/utils/terrain';
import {
  HOUSE_MARKER_HEIGHT,
  HOUSE_MARKER_BASE_LIFT,
  DEFAULT_LOCATION,
} from '@/utils/constants';

interface StructuresLayerProps {
  assets: StartupAssets;
}

interface HouseInstance {
  site: any;
  group: THREE.Group;
  marker: THREE.Group;
  hasModel: boolean;
  snapPending: boolean;
}

const _downRaycaster = new THREE.Raycaster();

/**
 * Structures/houses layer: loads house models, snaps to terrain, hot reloads.
 */
export function StructuresLayer({ assets }: StructuresLayerProps) {
  const housesRef = useRef<HouseInstance[]>([]);
  const houseLayerRef = useRef<THREE.Group | null>(null);
  const houseMarkerLayerRef = useRef<THREE.Group | null>(null);
  const modelTemplateRef = useRef<THREE.Object3D | null>(null);
  const loadedRef = useRef(false);
  const lastPollRef = useRef(0);
  const modelSigRef = useRef('');

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;

    const tStore = useTerrainStore.getState();
    const terrainRoot = tStore.terrainRoot;
    if (!terrainRoot) return;

    const structureDef = assets.structureDefinition;
    if (!structureDef.enabled || !structureDef.url) return;

    const anchorLat = terrainRoot.userData.anchorLat ?? DEFAULT_LOCATION.lat;
    const anchorLon = terrainRoot.userData.anchorLon ?? DEFAULT_LOCATION.lon;

    // Create layers
    const houseLayer = new THREE.Group();
    houseLayer.name = 'houses';
    terrainRoot.add(houseLayer);
    houseLayerRef.current = houseLayer;

    const houseMarkerLayer = new THREE.Group();
    houseMarkerLayer.name = 'house-markers';
    houseMarkerLayer.visible = false;
    houseMarkerLayer.renderOrder = 1002;
    terrainRoot.add(houseMarkerLayer);
    houseMarkerLayerRef.current = houseMarkerLayer;

    // Create house instances
    const instances = assets.structureInstances;
    const colors = [0xff3b30, 0xff9500, 0xffcc00, 0x34c759, 0x0a84ff, 0xbf5af2];

    for (let i = 0; i < instances.length; i++) {
      const site = instances[i];
      const group = new THREE.Group();
      group.name = `house-${site.id}`;
      group.userData = { houseId: site.id, tileId: site.tileId };
      houseLayer.add(group);

      const local = latLonToLocal(site.lat, site.lon, anchorLat, anchorLon);
      group.position.set(local.x, local.y, 0);
      group.rotation.z = THREE.MathUtils.degToRad(site.headingDeg ?? 0);
      if (site.scale) group.scale.setScalar(site.scale);

      // Marker
      const marker = createHouseMarker(i, site.id, colors[i % colors.length]);
      marker.position.set(local.x, local.y, HOUSE_MARKER_BASE_LIFT);
      houseMarkerLayer.add(marker);

      housesRef.current.push({
        site,
        group,
        marker,
        hasModel: false,
        snapPending: true,
      });
    }

    // Load house model
    if (instances.length > 0) {
      loadHouseModel(structureDef.url, housesRef.current, structureDef.altOffsetM);
    }
  }, [assets]);

  useFrame(() => {
    const tStore = useTerrainStore.getState();
    const terrainRoot = tStore.terrainRoot;
    const uiStore = useUIStore.getState();
    const mapMode = useControlsStore_mapMode();

    if (!terrainRoot) return;

    // Toggle visibility
    if (houseLayerRef.current) {
      houseLayerRef.current.visible = uiStore.housesVisible;
    }
    if (houseMarkerLayerRef.current) {
      houseMarkerLayerRef.current.visible = mapMode && uiStore.housesVisible;
    }

    // Snap pending houses
    if (uiStore.housesVisible) {
      snapPendingHouses(housesRef.current, terrainRoot, assets.structureDefinition.altOffsetM);
    }

    // Hot reload polling
    const nowMs = performance.now();
    if (uiStore.housesVisible && nowMs - lastPollRef.current > (assets.structureDefinition.hotReloadMs ?? 2000)) {
      lastPollRef.current = nowMs;
      // Poll would go here
    }
  });

  return null;
}

function useControlsStore_mapMode(): boolean {
  return useControlsStore.getState().mapMode;
}

function createHouseMarker(index: number, id: string, color: number): THREE.Group {
  const marker = new THREE.Group();
  marker.name = `house-marker-${id}`;

  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, HOUSE_MARKER_HEIGHT),
    ]),
    new THREE.LineBasicMaterial({
      color,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    })
  );
  line.renderOrder = 1002;

  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(240, 14, 12),
    new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false })
  );
  dot.position.z = HOUSE_MARKER_HEIGHT;
  dot.renderOrder = 1004;

  marker.add(line, dot);
  return marker;
}

function loadHouseModel(url: string, houses: HouseInstance[], altOffsetM: number) {
  const loader = new GLTFLoader();
  loader.load(url, (gltf) => {
    const template = gltf.scene;
    for (const house of houses) {
      const clone = template.clone();
      clone.traverse((obj: any) => {
        if (obj.isMesh) {
          obj.castShadow = true;
          obj.receiveShadow = true;
        }
      });
      house.group.add(clone);
      house.hasModel = true;
    }
    console.log(`[STRUCTURES] loaded ${houses.length} houses from ${url}`);
  }, undefined, (error) => {
    console.warn('[STRUCTURES] load failed:', error);
  });
}

function snapPendingHouses(houses: HouseInstance[], terrainRoot: THREE.Group, altOffsetM: number) {
  const terrainMeshes = getTerrainMeshes(terrainRoot);
  if (terrainMeshes.length === 0) return;

  const enu = terrainRoot.userData.enu;
  if (!enu) return;
  const downDir = enu.up.clone().negate();

  for (const house of houses) {
    if (!house.snapPending || !house.hasModel) continue;

    const targetLocal = new THREE.Vector3(
      house.group.position.x,
      house.group.position.y,
      20000
    );
    const targetWorld = targetLocal.clone();
    terrainRoot.localToWorld(targetWorld);

    _downRaycaster.set(targetWorld, downDir);
    const hits = _downRaycaster.intersectObjects(terrainMeshes);
    if (hits.length === 0) continue;

    const hitLocal = hits[0].point.clone();
    terrainRoot.worldToLocal(hitLocal);
    house.group.position.z = hitLocal.z + (altOffsetM ?? 0.4);
    house.marker.position.z = house.group.position.z + HOUSE_MARKER_BASE_LIFT;
    house.snapPending = false;
  }
}
