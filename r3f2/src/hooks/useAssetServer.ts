import { useEffect, useRef, useState } from 'react';
import { ASSETS_ENDPOINT, ASSETS_FETCH_TIMEOUT_MS } from '@/utils/constants';
import type { AssetsResponse, VehicleDefinition, VehicleHeadlights, VehicleInstance, StructureDefinition, StructureInstance } from '@/types/assets';
import { useVehicleStore } from '@/stores/vehicleStore';
import { useUIStore } from '@/stores/uiStore';

export interface StartupAssets {
  source: string;
  schemaVersion: number;
  seeded: { structureInstances: boolean; vehicleInstances: boolean } | null;
  vehicleDefinition: VehicleDefinition;
  headlightsConfig: VehicleHeadlights | null;
  structureDefinition: StructureDefinition;
  vehicleInstances: VehicleInstance[];
  structureInstances: StructureInstance[];
}

const DEFAULT_VEHICLE_DEFINITION: VehicleDefinition = {
  url: '/models/patria_amv.glb',
  displayName: 'Patria AMV',
  realLengthM: 7.7,
  tireDiameterM: 1.27,
  altOffsetM: 0.05,
};

const DEFAULT_STRUCTURE_DEFINITION: StructureDefinition = {
  url: '/models/house_test.glb',
  altOffsetM: 0.4,
  hotReloadMs: 2000,
  enabled: false,
};

async function fetchAssets(): Promise<StartupAssets> {
  const fallback: StartupAssets = {
    source: 'defaults',
    schemaVersion: 4,
    seeded: null,
    vehicleDefinition: DEFAULT_VEHICLE_DEFINITION,
    headlightsConfig: null,
    structureDefinition: DEFAULT_STRUCTURE_DEFINITION,
    vehicleInstances: [],
    structureInstances: [],
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ASSETS_FETCH_TIMEOUT_MS);
    const response = await fetch(ASSETS_ENDPOINT, {
      cache: 'no-store',
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) throw new Error(`status ${response.status}`);
    const payload: AssetsResponse = await response.json();

    const vehicleDef = payload.vehicle_definition ?? DEFAULT_VEHICLE_DEFINITION;
    const headlights =
      vehicleDef.headlights != null && typeof vehicleDef.headlights === 'object'
        ? vehicleDef.headlights
        : null;

    return {
      source: payload.source ?? 'metadata',
      schemaVersion: payload.schemaVersion ?? 4,
      seeded: payload.seeded ?? null,
      vehicleDefinition: vehicleDef,
      headlightsConfig: headlights,
      structureDefinition: payload.structure_definition ?? DEFAULT_STRUCTURE_DEFINITION,
      vehicleInstances: Array.isArray(payload.vehicle_instances)
        ? payload.vehicle_instances
        : [],
      structureInstances: Array.isArray(payload.structure_instances)
        ? payload.structure_instances
        : [],
    };
  } catch {
    console.warn('[ASSETS] startup fallback — asset server unreachable');
    return fallback;
  }
}

/**
 * Fetches startup assets from the asset server once on mount.
 * Populates vehicle and UI stores.
 */
export function useAssetServer(): StartupAssets | null {
  const [assets, setAssets] = useState<StartupAssets | null>(null);
  const fetched = useRef(false);

  useEffect(() => {
    if (fetched.current) return;
    fetched.current = true;

    fetchAssets().then((result) => {
      useVehicleStore.getState().setDefinition(result.vehicleDefinition);
      useVehicleStore.getState().setHeadlightsConfig(result.headlightsConfig);
      useVehicleStore.getState().setInstances(result.vehicleInstances);
      useUIStore.getState().setHousesVisible(result.structureDefinition.enabled);
      setAssets(result);
    });
  }, []);

  return assets;
}
