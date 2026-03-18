// Types matching the asset server schema (assetserver/src/types.ts)

export interface VehicleHeadlights {
  color: number;
  intensity: number;
  distanceM: number;
  angleDeg: number;
  penumbra: number;
  decay: number;
  mountFrontRatio: number;
  mountHeightM: number;
  mountSpacingM: number;
  targetForwardM: number;
  targetHeightM: number;
  targetXScale: number;
}

export interface VehicleParts {
  wheels: string[];
  turret?: string | null;
  gun?: string | null;
  body?: string[];
  shield?: string[];
}

export interface VehicleDefinition {
  url: string;
  displayName?: string;
  realLengthM: number;
  tireDiameterM: number;
  altOffsetM: number;
  parts?: VehicleParts;
  wheelClusterSplitThreshold?: number | null;
  headlights?: VehicleHeadlights;
}

export interface StructureDefinition {
  url: string;
  altOffsetM: number;
  hotReloadMs: number;
  enabled: boolean;
}

export interface VehicleInstance {
  id: string;
  lat: number;
  lon: number;
  headingDeg: number;
  z?: number;
  terrainDepth?: number;
  terrainTileId?: string;
  headlightsOn: boolean;
  savedAt: number;
}

export interface StructureInstance {
  id: string;
  lat: number;
  lon: number;
  headingDeg: number;
  scale: number;
  tileId?: string;
}

export interface AssetsResponse {
  ok: true;
  source: string;
  schemaVersion: number;
  seeded: {
    structureInstances: boolean;
    vehicleInstances: boolean;
  };
  vehicle_definition: VehicleDefinition;
  structure_definition: StructureDefinition;
  vehicle_instances: VehicleInstance[];
  structure_instances: StructureInstance[];
}

export interface SaveVehicleRequest {
  lat: number;
  lon: number;
  headingDeg: number;
  z?: number;
  terrainDepth?: number;
  terrainTileId?: string;
  reason?: string;
}
