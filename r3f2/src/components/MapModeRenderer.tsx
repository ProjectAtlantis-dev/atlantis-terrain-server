import { useRef, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useControlsStore } from '@/stores/controlsStore';
import { useTerrainStore } from '@/stores/terrainStore';
import { useVehicleStore } from '@/stores/vehicleStore';
import { MAX_VIEW_DIST, DEFAULT_MAP_ZOOM, VEHICLE_MARKER_MAP_SCALE } from '@/utils/constants';

const _mapBg = new THREE.Color(0x222222);

/**
 * Handles map mode rendering: orthographic camera, markers, direct renderer.render().
 */
export function MapModeRenderer() {
  const { gl, scene, camera } = useThree();
  const mapCamRef = useRef<THREE.OrthographicCamera | null>(null);
  const camMarkerRef = useRef<THREE.Mesh | null>(null);

  useEffect(() => {
    // Create orthographic camera for map mode
    const mapCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, MAX_VIEW_DIST + 5000);
    mapCamRef.current = mapCam;

    // Camera marker cone
    const camMarkerGeo = new THREE.ConeGeometry(200, 600, 4);
    const camMarker = new THREE.Mesh(
      camMarkerGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffff00,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    camMarker.visible = false;
    camMarker.frustumCulled = false;
    camMarker.renderOrder = 1000;
    camMarkerRef.current = camMarker;

    const terrainRoot = useTerrainStore.getState().terrainRoot;
    if (terrainRoot) {
      terrainRoot.add(camMarker);
      // Set up mapCam orientation
      const enu = terrainRoot.userData.enu;
      if (enu) {
        mapCam.up.copy(enu.north);
      }
    }

    return () => {
      camMarker.removeFromParent();
      camMarkerGeo.dispose();
    };
  }, []);

  useFrame(() => {
    const controls = useControlsStore.getState();
    if (!controls.mapMode) {
      if (camMarkerRef.current) camMarkerRef.current.visible = false;
      return;
    }

    const mapCam = mapCamRef.current;
    if (!mapCam) return;

    const terrainRoot = useTerrainStore.getState().terrainRoot;
    if (!terrainRoot) return;

    const enu = terrainRoot.userData.enu;
    if (!enu) return;
    const { east, north, up, anchorPosition } = enu;

    // Update map camera
    const aspect = gl.domElement.width / gl.domElement.height;
    const half = controls.mapZoom;
    mapCam.left = -half * aspect;
    mapCam.right = half * aspect;
    mapCam.top = half;
    mapCam.bottom = -half;
    mapCam.updateProjectionMatrix();

    // Position map camera above the scene looking down
    const camRel = camera.position.clone().sub(anchorPosition);
    const camEastM = camRel.dot(east) + controls.mapPanEast;
    const camNorthM = camRel.dot(north) + controls.mapPanNorth;

    mapCam.position.copy(anchorPosition)
      .addScaledVector(east, camEastM)
      .addScaledVector(north, camNorthM)
      .addScaledVector(up, MAX_VIEW_DIST);

    const lookTarget = anchorPosition.clone()
      .addScaledVector(east, camEastM)
      .addScaledVector(north, camNorthM);
    mapCam.up.copy(north);
    mapCam.lookAt(lookTarget);
    mapCam.updateMatrixWorld(true);

    // Camera position marker
    if (camMarkerRef.current) {
      camMarkerRef.current.visible = true;
      const markerRel = camera.position.clone().sub(anchorPosition);
      camMarkerRef.current.position.set(
        markerRel.dot(east),
        markerRel.dot(north),
        5000
      );
      const markerScale = controls.mapZoom / DEFAULT_MAP_ZOOM;
      camMarkerRef.current.scale.setScalar(markerScale);

      // Vehicle marker scaling
      const vStore = useVehicleStore.getState();
      for (const [, vehicle] of vStore.registry) {
        vehicle.marker.scale.setScalar(markerScale * VEHICLE_MARKER_MAP_SCALE);
      }
    }

    // Render map mode
    const prevFog = scene.fog;
    const prevBg = scene.background;
    scene.fog = null;
    scene.background = _mapBg;
    gl.render(scene, mapCam);
    scene.fog = prevFog;
    scene.background = prevBg;
  }, 2); // After atmosphere (priority 1)

  return null;
}
