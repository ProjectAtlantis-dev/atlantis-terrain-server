import { useRef, useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { createENUFrame, computeTerrainRootTransform } from '@/utils/geodesy';
import { DEFAULT_LOCATION } from '@/utils/constants';
import { useTerrainStore } from '@/stores/terrainStore';

interface TerrainRootProps {
  lat?: number;
  lon?: number;
  children?: React.ReactNode;
}

/**
 * TerrainRoot: the ENU-anchored group that contains all terrain meshes,
 * vehicles, and structures. Z-up coordinate system.
 *
 * All children are positioned in meters relative to the anchor point:
 *   X = east, Y = north, Z = elevation
 */
export function TerrainRoot({
  lat = DEFAULT_LOCATION.lat,
  lon = DEFAULT_LOCATION.lon,
  children,
}: TerrainRootProps) {
  const groupRef = useRef<THREE.Group>(null);
  const setTerrainRoot = useTerrainStore((s) => s.setTerrainRoot);

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    const enu = createENUFrame(lat, lon);
    const { position, quaternion } = computeTerrainRootTransform(enu);

    group.position.copy(position);
    group.quaternion.copy(quaternion);
    group.updateMatrixWorld(true);

    // Store ref for other systems
    setTerrainRoot(group);

    // Also expose the ENU frame on userData for hooks to use
    group.userData.enu = enu;
    group.userData.anchorLat = lat;
    group.userData.anchorLon = lon;

    // Expose for Playwright tests
    (window as unknown as Record<string, unknown>).__terrainRoot = group;
  }, [lat, lon, setTerrainRoot]);

  return (
    <group ref={groupRef} name="terrainRoot">
      {children}
    </group>
  );
}
