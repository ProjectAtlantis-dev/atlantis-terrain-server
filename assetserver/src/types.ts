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

export interface VehicleParts {
  wheels?: string[];
  turret?: string | null;
  gun?: string | null;
  body?: string[];
  shield?: string[];
  leftNacelle?: string[];
  rightNacelle?: string[];
  leftRotor?: string | null;
  rightRotor?: string | null;
}

export type VehicleType = "ground" | "aircraft";

export interface AircraftFlightConfig {
  maxSpeedMs: number;
  hoverMaxSpeedMs: number;
  transitionLowMs: number;
  transitionHighMs: number;
  climbRateMs: number;
  descendRateMs: number;
  accelMs2: number;
  yawRateRad: number;
  pitchRateRad: number;
  rollRateRad: number;
}

export interface NacelleConfig {
  tiltSpeedDegS: number;
  rotorRadiusM: number;
  leftCenter: [number, number, number];
  rightCenter: [number, number, number];
}

export interface VehicleDefinition {
  url: string;
  displayName?: string;
  vehicleType?: VehicleType;
  realLengthM: number;
  tireDiameterM?: number;
  altOffsetM: number;
  headingOffsetDeg?: number;
  modelRotationDeg?: [number, number, number];
  parts?: VehicleParts;
  wheelClusterSplitThreshold?: number | null;
  flight?: AircraftFlightConfig;
  nacelles?: NacelleConfig;
}

export type VehicleDefinitionCatalog = Record<
  string,
  VehicleDefinition & { headlights?: VehicleHeadlights }
>;

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
  definitionId?: string;
  headlightsOn: boolean;
  savedAt: number;
}

export interface VehicleSeedInstance {
  vehicleId: string;
  definitionId?: string;
  headlightsOn: boolean;
  state: VehicleStateCommon;
}

export interface AssetMetadata {
  source: string;
  vehicleDefinition: VehicleDefinition;
  vehicleDefinitions: VehicleDefinitionCatalog;
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
  vehicle_definitions: VehicleDefinitionCatalog;
  structure_definition: StructureDefinition;
  vehicle_instances: VehicleInstance[];
  structure_instances: StructureInstance[];
}

// --- Unified asset types ---

export type AssetType = "vehicle" | "structure";

export interface VehicleProperties {
  headlightsOn: boolean;
  definitionId?: string;
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
