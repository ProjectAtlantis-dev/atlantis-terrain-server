import { create } from 'zustand';
import * as THREE from 'three';
import type { VehicleEntry } from '@/types/vehicle';
import type { VehicleDefinition, VehicleHeadlights, VehicleInstance } from '@/types/assets';
import { VEHICLE_CAM_MODES } from '@/utils/constants';

export interface VehicleState {
  // Registry
  registry: Map<string, VehicleEntry>;
  activeVehicleId: string | null;

  // Definition (from asset server)
  definition: VehicleDefinition | null;
  headlightsConfig: VehicleHeadlights | null;
  instances: VehicleInstance[];

  // Shared temp vectors (reused per frame)
  targetWorld: THREE.Vector3;
  targetLocal: THREE.Vector3;
  groundNormal: THREE.Vector3;
  desiredForward: THREE.Vector3;
  desiredRight: THREE.Vector3;
  orientationMatrix: THREE.Matrix4;
  orientationTargetQuat: THREE.Quaternion;
  invQuat: THREE.Quaternion;
  normalMatrix: THREE.Matrix3;
  terrainInverse: THREE.Matrix4;

  // Camera orbit state
  cameraOrbitYaw: number;
  cameraOrbitPitch: number;

  // Snap timing
  lastSnapAttemptAt: number;

  // Actions
  setDefinition: (def: VehicleDefinition) => void;
  setHeadlightsConfig: (h: VehicleHeadlights | null) => void;
  setInstances: (i: VehicleInstance[]) => void;
  addVehicle: (entry: VehicleEntry) => void;
  removeVehicle: (id: string) => void;
  setActiveVehicle: (id: string | null) => void;
  getActiveVehicle: () => VehicleEntry | null;
  updateVehicle: (id: string, update: Partial<VehicleEntry>) => void;
  setCameraOrbit: (yaw: number, pitch: number) => void;
  setLastSnapAttempt: (t: number) => void;
}

export const useVehicleStore = create<VehicleState>((set, get) => ({
  registry: new Map(),
  activeVehicleId: null,
  definition: null,
  headlightsConfig: null,
  instances: [],

  // Shared temp vectors — allocated once, reused every frame
  targetWorld: new THREE.Vector3(),
  targetLocal: new THREE.Vector3(),
  groundNormal: new THREE.Vector3(0, 0, 1),
  desiredForward: new THREE.Vector3(),
  desiredRight: new THREE.Vector3(),
  orientationMatrix: new THREE.Matrix4(),
  orientationTargetQuat: new THREE.Quaternion(),
  invQuat: new THREE.Quaternion(),
  normalMatrix: new THREE.Matrix3(),
  terrainInverse: new THREE.Matrix4(),

  cameraOrbitYaw: 0,
  cameraOrbitPitch: Math.atan2(VEHICLE_CAM_MODES[1].height, VEHICLE_CAM_MODES[1].dist),
  lastSnapAttemptAt: 0,

  setDefinition: (def) => set({ definition: def }),
  setHeadlightsConfig: (h) => set({ headlightsConfig: h }),
  setInstances: (i) => set({ instances: i }),

  addVehicle: (entry) =>
    set((s) => {
      const registry = new Map(s.registry);
      registry.set(entry.id, entry);
      return { registry };
    }),

  removeVehicle: (id) =>
    set((s) => {
      const registry = new Map(s.registry);
      registry.delete(id);
      return {
        registry,
        activeVehicleId: s.activeVehicleId === id ? null : s.activeVehicleId,
      };
    }),

  setActiveVehicle: (id) => set({ activeVehicleId: id }),

  getActiveVehicle: () => {
    const s = get();
    return s.activeVehicleId ? s.registry.get(s.activeVehicleId) ?? null : null;
  },

  updateVehicle: (id, update) =>
    set((s) => {
      const registry = new Map(s.registry);
      const existing = registry.get(id);
      if (existing) {
        registry.set(id, { ...existing, ...update });
      }
      return { registry };
    }),

  setCameraOrbit: (yaw, pitch) => set({ cameraOrbitYaw: yaw, cameraOrbitPitch: pitch }),
  setLastSnapAttempt: (t) => set({ lastSnapAttemptAt: t }),
}));
