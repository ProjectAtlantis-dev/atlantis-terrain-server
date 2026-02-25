export type JsonObject = Record<string, unknown>;

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

export interface VehicleDefinition {
  url: string;
  realLengthM: number;
  tireDiameterM: number;
  altOffsetM: number;
}

export interface StructureDefinition {
  url: string;
  altOffsetM: number;
  hotReloadMs: number;
  enabled: boolean;
}

export interface StructureInstance {
  id: string;
  lat: number;
  lon: number;
  headingDeg: number;
  scale: number;
  tileId?: string;
}

export interface VehicleStateCommon {
  lat: number;
  lon: number;
  headingDeg: number;
  z?: number;
  terrainDepth?: number;
  terrainTileId?: string;
}

export interface VehicleInstance extends VehicleStateCommon {
  id: string;
  headlightsOn: boolean;
  savedAt: number;
}

export interface VehicleSeedInstance {
  vehicleId: string;
  headlightsOn: boolean;
  state: VehicleStateCommon;
}

export interface AssetMetadata {
  source: string;
  vehicleDefinition: VehicleDefinition;
  vehicleHeadlights: VehicleHeadlights;
  structureDefinition: StructureDefinition;
  seedVehicleInstances: VehicleSeedInstance[];
  seedStructureInstances: StructureInstance[];
}

export interface SaveVehicleRequest extends VehicleStateCommon {
  reason?: string;
}

export interface SaveVehicleStateResponse {
  ok: true;
  vehicleId: string;
  state: VehicleStateCommon & {
    savedAt: number;
  };
}

export interface AssetsResponse {
  ok: true;
  source: string;
  schemaVersion: number;
  seeded: {
    structureInstances: boolean;
    vehicleInstances: boolean;
  };
  vehicle_definition: VehicleDefinition & {
    headlights: VehicleHeadlights;
  };
  structure_definition: StructureDefinition;
  vehicle_instances: VehicleInstance[];
  structure_instances: StructureInstance[];
}

// --- Unified asset types ---

export type AssetType = "vehicle" | "structure";

export interface VehicleProperties {
  headlightsOn: boolean;
  terrainDepth?: number;
  terrainTileId?: string;
}

export interface StructureProperties {
  scale: number;
  tileId?: string;
}

export interface AssetRow {
  id: string;
  type: AssetType;
  enabled: number;
  lat: number;
  lon: number;
  heading_deg: number;
  z: number | null;
  properties: string;
  saved_at: number | null;
  updated_at: string;
}

export interface PatchAssetRequest {
  enabled?: boolean;
  lat?: number;
  lon?: number;
  headingDeg?: number;
  z?: number | null;
  properties?: Partial<VehicleProperties> | Partial<StructureProperties>;
}

export interface PatchAssetResponse {
  ok: true;
  id: string;
  type: AssetType;
  enabled: boolean;
  lat: number;
  lon: number;
  headingDeg: number;
  z: number | null;
  properties: Record<string, unknown>;
}
