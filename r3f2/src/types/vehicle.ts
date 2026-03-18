import * as THREE from 'three';
import type { VehicleDefinition, VehicleHeadlights, VehicleInstance } from './assets';

export interface WheelCluster {
  mesh: THREE.Mesh;
  centerY: number;
  centerZ: number;
  indices: number[];
  basePositions: Float32Array;
}

export interface VehicleEntry {
  // Identity
  id: string;
  definition: VehicleDefinition;
  instanceConfig: VehicleInstance;
  headlightsConfig: VehicleHeadlights | null;

  // Three.js scene objects
  group: THREE.Group;
  model: THREE.Object3D | null;
  meshes: THREE.Mesh[];
  marker: THREE.Group;
  sunLight: THREE.DirectionalLight;
  ambientLight: THREE.AmbientLight;

  // Loading state
  loaded: boolean;

  // Vehicle parts (populated during model load)
  wheelObjects: THREE.Mesh[];
  wheelClusters: WheelCluster[];
  wheelAngle: number;
  turretPivot: THREE.Group | null;
  gunPivot: THREE.Group | null;
  turretMesh: THREE.Mesh | null;
  gunMesh: THREE.Mesh | null;
  barrelTipLocal: THREE.Vector3;
  muzzleFlashSprite: THREE.Sprite | null;
  muzzleFlashTimer: number;
  headlightSpots: THREE.SpotLight[];

  // Config from definition.parts
  wheelNames: string[];
  turretName: string | null;
  gunName: string | null;
  wheelSplitThreshold: number | null;
  TIRE_RADIUS_M: number;
  TERRAIN_LIFT_M: number;

  // Dimensions (set during model load from bbox)
  bodyLengthM: number;
  bodyWidthM: number;
  shadowRadius: number;

  // Spatial state
  headingRad: number;
  speed: number;

  // Terrain snap state
  snapPending: boolean;
  groundZTarget: number | null;
  verticalVelocity: number;
  lastContactDepth: number;
  lastContactTileId: string | null;
  awaitingInitialSnap: boolean;
  restoreRequiresDepth: boolean;
  restoreDepthTarget: number;
  savedStatePending: {
    lat: number;
    lon: number;
    headingDeg: number;
    z: number | null;
    terrainDepth: number | null;
  } | null;

  // Player control state
  controlActive: boolean;
  turretControlActive: boolean;
  turretYawRad: number;
  turretPitchRad: number;
  fireHeld: boolean;
  lastFireTime: number;
  camModeIndex: number;
  cameraFollowDist: number;
  cameraFollowHeight: number;
  driftMode: boolean;
}

export interface CameraMode {
  name: string;
  dist: number;
  height: number;
}
