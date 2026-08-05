import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";
import {
  type AssetMetadata,
  type AssetRow,
  type AssetType,
  type AssetsResponse,
  type JsonObject,
  type PatchAssetRequest,
  type PatchAssetResponse,
  type SaveVehicleRequest,
  type SaveVehicleStateResponse,
  type StructureDefinition,
  type StructureInstance,
  type StructureProperties,
  type VehicleDefinition,
  type VehicleHeadlights,
  type VehicleInstance,
  type VehicleProperties,
  type VehicleSeedInstance,
  type VehicleStateCommon,
} from "./types.js";

const ASSETS_RESPONSE_SCHEMA_VERSION = 4;
const DEFAULT_VEHICLE_INSTANCE_ID = "amv-01";
type SqliteDb = Database<sqlite3.Database, sqlite3.Statement>;

type SeedVehicleMetadata = VehicleStateCommon & { id: string; headlightsOn: boolean };

const FALLBACK_VEHICLE_DEFINITION: VehicleDefinition = {
  url: "/models/patria_amv.glb",
  realLengthM: 7.7,
  tireDiameterM: 1.27,
  altOffsetM: 0.05,
};

const FALLBACK_STRUCTURE_DEFINITION: StructureDefinition = {
  url: "/models/house_test.glb",
  altOffsetM: 0.4,
  hotReloadMs: 2000,
  enabled: false,
};

const DEFAULT_VEHICLE_HEADLIGHTS: VehicleHeadlights = {
  color: 0xfff4e0,
  intensity: 800,
  distanceM: 120,
  angleDeg: 39.6,
  penumbra: 0.4,
  decay: 2,
  mountFrontRatio: 0.48,
  mountHeightM: 1.4,
  mountSpacingM: 0.95,
  targetForwardM: 60,
  targetHeightM: -0.5,
  targetXScale: 0.3,
};

const FALLBACK_SEED_VEHICLE_INSTANCES: SeedVehicleMetadata[] = [
  {
    id: "amv-01",
    lat: 64.18423381,
    lon: -51.70139232,
    headingDeg: 234.341,
    z: 16.279,
    headlightsOn: true,
  },
];

const FALLBACK_SEED_STRUCTURE_INSTANCES: StructureInstance[] = [];

const ASSETSERVER_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ROOT_DIR = path.resolve(ASSETSERVER_DIR, "..");
const DEFAULT_DB_PATH = path.join(ASSETSERVER_DIR, "assets.db");
const DEFAULT_METADATA_PATH = path.join(ASSETSERVER_DIR, "assets_metadata.json");
const LEGACY_METADATA_PATH = path.join(ROOT_DIR, "flaskserver", "assets_metadata.json");

const DB_PATH = process.env.ASSET_DB_PATH?.trim() || DEFAULT_DB_PATH;
const METADATA_PATH = process.env.ASSET_METADATA_PATH?.trim() || DEFAULT_METADATA_PATH;
const HOST = process.env.ASSET_SERVER_HOST?.trim() || "127.0.0.1";
const PORT = toPort(process.env.ASSET_SERVER_PORT, 8787);

function toPort(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function coerceFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function coerceBool(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
  }
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(text)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(text)) {
      return false;
    }
  }
  return null;
}

function coerceColor(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    return clamp(Math.trunc(value), 0, 0xffffff);
  }
  if (typeof value !== "string") {
    return null;
  }
  let text = value.trim().toLowerCase();
  if (!text) {
    return null;
  }
  let forceHex = false;
  if (text.startsWith("#")) {
    forceHex = true;
    text = text.slice(1);
  }
  if (text.startsWith("0x")) {
    forceHex = true;
    text = text.slice(2);
  }
  if (!text) {
    return null;
  }
  if (forceHex || /[a-f]/.test(text)) {
    if (!/^[0-9a-f]+$/.test(text)) {
      return null;
    }
    return clamp(Number.parseInt(text, 16), 0, 0xffffff);
  }
  if (!/^\d+$/.test(text)) {
    return null;
  }
  return clamp(Number.parseInt(text, 10), 0, 0xffffff);
}

function normalizeHeading(value: number): number {
  const normalized = value % 360;
  return normalized >= 0 ? normalized : normalized + 360;
}

function normalizeTileId(raw: unknown): string | undefined {
  if (raw == null) {
    return undefined;
  }
  const text = String(raw).trim();
  return text || undefined;
}

function normalizeReason(raw: unknown): string | undefined {
  if (raw == null) {
    return undefined;
  }
  const text = String(raw).trim();
  return text || undefined;
}

function sanitizeVehicleHeadlights(raw: unknown): VehicleHeadlights {
  const source: JsonObject = raw != null && typeof raw === "object" ? (raw as JsonObject) : {};
  const out: VehicleHeadlights = { ...DEFAULT_VEHICLE_HEADLIGHTS };

  const color = coerceColor(source.color);
  if (color != null) {
    out.color = color;
  }

  for (const key of [
    "intensity",
    "distanceM",
    "angleDeg",
    "penumbra",
    "decay",
    "mountFrontRatio",
    "mountHeightM",
    "mountSpacingM",
    "targetForwardM",
    "targetHeightM",
    "targetXScale",
  ] as Array<Exclude<keyof VehicleHeadlights, "color">>) {
    const value = coerceFiniteNumber(source[key]);
    if (value != null) {
      out[key] = value;
    }
  }

  out.intensity = Math.max(0, Number(out.intensity));
  out.distanceM = Math.max(0, Number(out.distanceM));
  out.angleDeg = clamp(Number(out.angleDeg), 1, 85);
  out.penumbra = clamp(Number(out.penumbra), 0, 1);
  out.decay = Math.max(0, Number(out.decay));
  out.mountFrontRatio = clamp(Number(out.mountFrontRatio), 0, 1);
  out.mountSpacingM = Math.max(0, Number(out.mountSpacingM));
  out.targetForwardM = Math.max(0, Number(out.targetForwardM));
  out.targetXScale = clamp(Number(out.targetXScale), 0, 1);

  return out;
}

function sanitizeVehicleDefinition(raw: unknown): VehicleDefinition {
  const source: JsonObject = raw != null && typeof raw === "object" ? (raw as JsonObject) : {};
  const out: VehicleDefinition = { ...FALLBACK_VEHICLE_DEFINITION };

  if (typeof source.url === "string" && source.url.trim()) {
    out.url = source.url.trim();
  }

  const realLengthM = coerceFiniteNumber(source.realLengthM);
  if (realLengthM != null && realLengthM > 0) {
    out.realLengthM = realLengthM;
  }

  const tireDiameterM = coerceFiniteNumber(source.tireDiameterM);
  if (tireDiameterM != null && tireDiameterM > 0) {
    out.tireDiameterM = tireDiameterM;
  }

  const altOffsetM = coerceFiniteNumber(source.altOffsetM);
  if (altOffsetM != null) {
    out.altOffsetM = altOffsetM;
  }

  return out;
}

function sanitizeStructureDefinition(raw: unknown): StructureDefinition {
  const source: JsonObject = raw != null && typeof raw === "object" ? (raw as JsonObject) : {};
  const out: StructureDefinition = { ...FALLBACK_STRUCTURE_DEFINITION };

  if (typeof source.url === "string" && source.url.trim()) {
    out.url = source.url.trim();
  }

  const altOffsetM = coerceFiniteNumber(source.altOffsetM);
  if (altOffsetM != null) {
    out.altOffsetM = altOffsetM;
  }

  const hotReloadMs = coerceFiniteNumber(source.hotReloadMs);
  if (hotReloadMs != null) {
    out.hotReloadMs = Math.max(500, Math.trunc(hotReloadMs));
  }

  const enabled = coerceBool(source.enabled);
  if (enabled != null) {
    out.enabled = enabled;
  }

  return out;
}

function sanitizeStructureSite(raw: unknown, index: number): StructureInstance | null {
  if (raw == null || typeof raw !== "object") {
    return null;
  }
  const source = raw as JsonObject;

  const lat = coerceFiniteNumber(source.lat);
  const lon = coerceFiniteNumber(source.lon);
  if (lat == null || lon == null) {
    return null;
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null;
  }

  const headingRaw = coerceFiniteNumber(source.headingDeg);
  const scaleRaw = coerceFiniteNumber(source.scale);
  const tileId = normalizeTileId(source.tileId);

  const idRaw = typeof source.id === "string" ? source.id.trim() : "";
  const id = idRaw || `site-${String(index + 1).padStart(2, "0")}`;

  const out: StructureInstance = {
    id,
    lat,
    lon,
    headingDeg: headingRaw != null ? normalizeHeading(headingRaw) : 0,
    scale: clamp(scaleRaw ?? 1, 0.05, 10),
  };
  if (tileId) {
    out.tileId = tileId;
  }

  return out;
}

function sanitizeStructureSites(raw: unknown): StructureInstance[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: StructureInstance[] = [];
  raw.slice(0, 512).forEach((item, index) => {
    const site = sanitizeStructureSite(item, index);
    if (site != null) {
      out.push(site);
    }
  });
  return out;
}

function validateStateCommon(payload: JsonObject): VehicleStateCommon | null {
  const lat = coerceFiniteNumber(payload.lat);
  const lon = coerceFiniteNumber(payload.lon);
  const headingDeg = coerceFiniteNumber(payload.headingDeg);

  if (lat == null || lat < -90 || lat > 90) {
    return null;
  }
  if (lon == null || lon < -180 || lon > 180) {
    return null;
  }
  if (headingDeg == null) {
    return null;
  }

  const zRaw = payload.z;
  let z: number | undefined;
  if (zRaw != null) {
    const zCoerced = coerceFiniteNumber(zRaw);
    if (zCoerced == null) {
      return null;
    }
    z = zCoerced;
  }

  const terrainDepthRaw = payload.terrainDepth;
  let terrainDepth: number | undefined;
  if (terrainDepthRaw != null) {
    const coerced = coerceFiniteNumber(terrainDepthRaw);
    if (coerced == null || coerced < 0) {
      return null;
    }
    terrainDepth = Math.floor(coerced);
  }

  const terrainTileId = normalizeTileId(payload.terrainTileId);

  return {
    lat,
    lon,
    headingDeg: normalizeHeading(headingDeg),
    ...(z != null ? { z } : {}),
    ...(terrainDepth != null ? { terrainDepth } : {}),
    ...(terrainTileId ? { terrainTileId } : {}),
  };
}

function sanitizeSeedVehicleInstance(raw: unknown, index: number, fallbackSeed: SeedVehicleMetadata): VehicleSeedInstance | null {
  if (raw == null || typeof raw !== "object") {
    return null;
  }
  const source = raw as JsonObject;
  const idRaw = typeof source.id === "string" ? source.id.trim() : "";
  const vehicleId = idRaw || `vehicle-${String(index + 1).padStart(2, "0")}`;

  const state = validateStateCommon({
    lat: source.lat ?? fallbackSeed.lat,
    lon: source.lon ?? fallbackSeed.lon,
    headingDeg: source.headingDeg ?? fallbackSeed.headingDeg,
    z: source.z ?? fallbackSeed.z,
    terrainDepth: source.terrainDepth,
    terrainTileId: source.terrainTileId,
  });

  if (state == null) {
    return null;
  }

  return {
    vehicleId,
    headlightsOn: coerceBool(source.headlightsOn) ?? true,
    state,
  };
}

function parseSaveVehicleRequest(raw: unknown): { ok: true; value: SaveVehicleRequest } | { ok: false; error: string } {
  if (raw == null || typeof raw !== "object") {
    return { ok: false, error: "invalid vehicle state payload: payload must be an object" };
  }
  const source = raw as JsonObject;
  const state = validateStateCommon(source);
  if (state == null) {
    return { ok: false, error: "invalid vehicle state payload: lat/lon/headingDeg (and optional z/terrainDepth) are invalid" };
  }

  const reason = normalizeReason(source.reason);
  return {
    ok: true,
    value: {
      ...state,
      ...(reason ? { reason } : {}),
    },
  };
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function resolveMetadataFilePath(): Promise<string | null> {
  if (await fileExists(METADATA_PATH)) {
    return METADATA_PATH;
  }

  if (METADATA_PATH != LEGACY_METADATA_PATH && await fileExists(LEGACY_METADATA_PATH)) {
    return LEGACY_METADATA_PATH;
  }

  return null;
}

function coerceSchemaVersion(value: unknown): number | null {
  const parsed = coerceFiniteNumber(value);
  if (parsed == null || parsed < 0 || !Number.isInteger(parsed)) {
    return null;
  }
  return parsed;
}

async function loadAssetsMetadata(): Promise<AssetMetadata> {
  const metadataPath = await resolveMetadataFilePath();
  let payload: JsonObject = {};
  let source = "defaults";

  if (metadataPath != null) {
    const parsed = await readJsonFile(metadataPath);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError(`metadata root must be an object: ${metadataPath}`);
    }
    payload = parsed as JsonObject;
    source = "metadata_file";
  } else {
    log.warn("no metadata file found; using defaults", {
      phase: "assets.metadata.missing",
      metadataPath: METADATA_PATH,
    });
  }

  const metadataVersion = coerceSchemaVersion(payload.metadataVersion);

  let rawVehicleDef: unknown = {};
  let rawStructureDef: unknown = {};
  let rawSeedVehicles: unknown = undefined;
  let rawSeedStructures: unknown = undefined;
  let vehicleHeadlights: VehicleHeadlights = { ...DEFAULT_VEHICLE_HEADLIGHTS };

  if (metadataVersion != null && metadataVersion >= 2) {
    rawVehicleDef = payload.vehicle_definition;
    rawStructureDef = payload.structure_definition;
    rawSeedVehicles = payload.seed_vehicle_instances;
    rawSeedStructures = payload.seed_structure_instances;

    const vehicleDefObject = rawVehicleDef != null && typeof rawVehicleDef === "object"
      ? (rawVehicleDef as JsonObject)
      : {};
    vehicleHeadlights = sanitizeVehicleHeadlights(vehicleDefObject.headlights);
  } else {
    const structureMetadata = payload.structure_metadata;
    const vehicleMetadata = payload.vehicle_metadata;

    rawStructureDef = structureMetadata != null && typeof structureMetadata === "object"
      ? (structureMetadata as JsonObject).model
      : {};
    rawVehicleDef = vehicleMetadata != null && typeof vehicleMetadata === "object"
      ? (vehicleMetadata as JsonObject).model
      : {};

    rawSeedVehicles = payload.seed_vehicle_instances;
    rawSeedStructures = payload.seed_structure_instances;
  }

  const structureDefinition = sanitizeStructureDefinition(rawStructureDef);
  const vehicleDefinition = sanitizeVehicleDefinition(rawVehicleDef);

  let seedStructureInstances = sanitizeStructureSites(rawSeedStructures);
  if (seedStructureInstances.length === 0) {
    seedStructureInstances = sanitizeStructureSites(FALLBACK_SEED_STRUCTURE_INSTANCES);
  }

  const fallbackSeed = FALLBACK_SEED_VEHICLE_INSTANCES[0];
  const seedVehicleInstances: VehicleSeedInstance[] = [];
  if (Array.isArray(rawSeedVehicles)) {
    rawSeedVehicles.slice(0, 256).forEach((item, index) => {
      const instance = sanitizeSeedVehicleInstance(item, index, fallbackSeed);
      if (instance != null) {
        seedVehicleInstances.push(instance);
      }
    });
  }
  if (seedVehicleInstances.length === 0) {
    const defaultState = validateStateCommon({
      lat: fallbackSeed.lat,
      lon: fallbackSeed.lon,
      headingDeg: fallbackSeed.headingDeg,
      z: fallbackSeed.z,
    });
    if (defaultState != null) {
      seedVehicleInstances.push({
        vehicleId: DEFAULT_VEHICLE_INSTANCE_ID,
        headlightsOn: coerceBool(fallbackSeed.headlightsOn) ?? true,
        state: defaultState,
      });
    }
  }

  const vehicleAssetType = typeof payload.vehicle_asset_type === "string"
    ? payload.vehicle_asset_type.trim() : "";
  const structureAssetType = typeof payload.structure_asset_type === "string"
    ? payload.structure_asset_type.trim() : "";
  if (!vehicleAssetType || !structureAssetType) {
    throw new Error("asset metadata must define runtime asset type strings");
  }

  return {
    source,
    vehicleAssetType,
    structureAssetType,
    vehicleDefinition,
    vehicleHeadlights,
    structureDefinition,
    seedVehicleInstances,
    seedStructureInstances,
  };
}

async function initDb(db: SqliteDb): Promise<void> {
  await db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;

    CREATE TABLE IF NOT EXISTS assets (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      lat         REAL NOT NULL,
      lon         REAL NOT NULL,
      heading_deg REAL NOT NULL DEFAULT 0,
      z           REAL,
      properties  TEXT NOT NULL DEFAULT '{}',
      saved_at    REAL,
      updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      cx          REAL,
      cy          REAL,
      min_x       REAL,
      min_y       REAL,
      max_x       REAL,
      max_y       REAL
    );
  `);

  const assetColumns = new Set(
    (await db.all<{ name: string }[]>("PRAGMA table_info(assets);")).map((column) => column.name),
  );
  const missingColumns = ["cx", "cy", "min_x", "min_y", "max_x", "max_y"]
    .filter((column) => !assetColumns.has(column));
  if (missingColumns.length > 0) {
    throw new Error(
      `assets.db has an obsolete schema; purge and reload it (missing: ${missingColumns.join(", ")})`,
    );
  }

  await db.exec("CREATE INDEX IF NOT EXISTS idx_assets_cxy ON assets(cx, cy);");
  await db.exec(
    "CREATE INDEX IF NOT EXISTS idx_assets_bounds ON assets(type, min_x, max_x, min_y, max_y);",
  );
}

async function ensureStructureSeeds(
  db: SqliteDb, assetType: string, seedInstances: StructureInstance[],
): Promise<boolean> {
  const row = await db.get<{ count: number }>("SELECT COUNT(*) as count FROM assets WHERE type = ?", [assetType]);
  if ((row?.count ?? 0) > 0) {
    return false;
  }

  let inserted = false;
  for (const site of seedInstances) {
    const props: StructureProperties = { scale: site.scale };
    if (site.tileId) {
      props.tileId = site.tileId;
    }
    await db.run(
      `
      INSERT OR REPLACE INTO assets
      (id, type, enabled, lat, lon, heading_deg, z, properties, saved_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?, NULL, ?, NULL, CURRENT_TIMESTAMP)
      `,
      [site.id, assetType, site.lat, site.lon, site.headingDeg, JSON.stringify(props)],
    );
    inserted = true;
  }

  return inserted;
}

async function ensureVehicleSeeds(
  db: SqliteDb, assetType: string, seedInstances: VehicleSeedInstance[],
): Promise<boolean> {
  const row = await db.get<{ count: number }>("SELECT COUNT(*) as count FROM assets WHERE type = ?", [assetType]);
  if ((row?.count ?? 0) > 0) {
    return false;
  }

  const now = Date.now() / 1000;
  let inserted = false;
  for (const instance of seedInstances) {
    const props: VehicleProperties = {
      headlightsOn: instance.headlightsOn,
    };
    if (instance.state.terrainDepth != null) {
      props.terrainDepth = instance.state.terrainDepth;
    }
    if (instance.state.terrainTileId) {
      props.terrainTileId = instance.state.terrainTileId;
    }
    await db.run(
      `
      INSERT OR REPLACE INTO assets
      (id, type, enabled, lat, lon, heading_deg, z, properties, saved_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `,
      [
        instance.vehicleId,
        assetType,
        instance.state.lat,
        instance.state.lon,
        instance.state.headingDeg,
        instance.state.z ?? null,
        JSON.stringify(props),
        now,
      ],
    );
    inserted = true;
  }

  return inserted;
}

function parseProperties<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

async function loadVehicleInstances(db: SqliteDb, assetType: string): Promise<VehicleInstance[]> {
  const rows = await db.all<AssetRow[]>(
    `
    SELECT id, lat, lon, heading_deg, z, properties, saved_at
    FROM assets
    WHERE type = ? AND enabled = 1
    ORDER BY updated_at DESC, id
    `,
    [assetType],
  );

  const out: VehicleInstance[] = [];
  for (const row of rows) {
    const props = parseProperties<VehicleProperties>(row.properties);
    const validated = validateStateCommon({
      lat: row.lat,
      lon: row.lon,
      headingDeg: row.heading_deg,
      z: row.z,
      terrainDepth: props.terrainDepth,
      terrainTileId: props.terrainTileId,
    });
    if (validated == null) {
      continue;
    }

    out.push({
      id: String(row.id),
      headlightsOn: props.headlightsOn !== false,
      ...validated,
      savedAt: row.saved_at ?? 0,
    });
  }

  return out;
}

async function loadStructureInstances(db: SqliteDb, assetType: string): Promise<StructureInstance[]> {
  const rows = await db.all<AssetRow[]>(
    `
    SELECT id, lat, lon, heading_deg, properties
    FROM assets
    WHERE type = ? AND enabled = 1
    ORDER BY id
    `,
    [assetType],
  );

  const out: StructureInstance[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const props = parseProperties<StructureProperties>(row.properties);
    const site = sanitizeStructureSite(
      {
        id: row.id,
        lat: row.lat,
        lon: row.lon,
        headingDeg: row.heading_deg,
        scale: props.scale ?? 1,
        tileId: props.tileId,
      },
      index,
    );
    if (site != null) {
      out.push(site);
    }
  }

  return out;
}

async function resolvePrimaryVehicleId(db: SqliteDb, assetType: string): Promise<string> {
  const primaryEnabled = await db.get<{ id: string }>(
    `
    SELECT id
    FROM assets
    WHERE type = ? AND enabled = 1
    ORDER BY updated_at DESC, id
    LIMIT 1
    `,
    [assetType],
  );
  if (primaryEnabled?.id) {
    return String(primaryEnabled.id);
  }

  const anyVehicle = await db.get<{ id: string }>(
    `
    SELECT id
    FROM assets
    WHERE type = ?
    ORDER BY updated_at DESC, id
    LIMIT 1
    `,
    [assetType],
  );
  if (anyVehicle?.id) {
    return String(anyVehicle.id);
  }

  return DEFAULT_VEHICLE_INSTANCE_ID;
}

async function getAssetsResponse(db: SqliteDb): Promise<AssetsResponse> {
  const metadata = await loadAssetsMetadata();
  const seededStructures = await ensureStructureSeeds(
    db, metadata.structureAssetType, metadata.seedStructureInstances,
  );
  const seededVehicles = await ensureVehicleSeeds(
    db, metadata.vehicleAssetType, metadata.seedVehicleInstances,
  );

  const structureInstances = await loadStructureInstances(db, metadata.structureAssetType);
  const vehicleInstances = await loadVehicleInstances(db, metadata.vehicleAssetType);

  return {
    ok: true,
    source: metadata.source,
    schemaVersion: ASSETS_RESPONSE_SCHEMA_VERSION,
    seeded: {
      structureInstances: seededStructures,
      vehicleInstances: seededVehicles,
    },
    vehicle_definition: {
      ...metadata.vehicleDefinition,
      headlights: metadata.vehicleHeadlights,
    },
    structure_definition: metadata.structureDefinition,
    vehicle_instances: vehicleInstances,
    structure_instances: structureInstances,
  };
}

async function saveVehicleState(db: SqliteDb, request: SaveVehicleRequest): Promise<SaveVehicleStateResponse> {
  const metadata = await loadAssetsMetadata();
  const vehicleId = await resolvePrimaryVehicleId(db, metadata.vehicleAssetType);
  const savedAt = Date.now() / 1000;

  // Preserve existing properties, just update spatial fields
  const existing = await db.get<{ properties: string }>(
    "SELECT properties FROM assets WHERE id = ?",
    [vehicleId],
  );
  const existingProps = existing ? parseProperties<VehicleProperties>(existing.properties) : { headlightsOn: true };
  const props: VehicleProperties = {
    headlightsOn: existingProps.headlightsOn !== false,
    ...(request.terrainDepth != null ? { terrainDepth: request.terrainDepth } : {}),
    ...(request.terrainTileId ? { terrainTileId: request.terrainTileId } : {}),
  };

  await db.run(
    `
    INSERT INTO assets
    (id, type, enabled, lat, lon, heading_deg, z, properties, saved_at, updated_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type,
      enabled = 1,
      lat = excluded.lat,
      lon = excluded.lon,
      heading_deg = excluded.heading_deg,
      z = excluded.z,
      properties = excluded.properties,
      saved_at = excluded.saved_at,
      updated_at = CURRENT_TIMESTAMP
    `,
    [
      vehicleId,
      metadata.vehicleAssetType,
      request.lat,
      request.lon,
      request.headingDeg,
      request.z ?? null,
      JSON.stringify(props),
      savedAt,
    ],
  );

  return {
    ok: true,
    vehicleId,
    state: {
      lat: request.lat,
      lon: request.lon,
      headingDeg: request.headingDeg,
      ...(request.z != null ? { z: request.z } : {}),
      ...(request.terrainDepth != null ? { terrainDepth: request.terrainDepth } : {}),
      ...(request.terrainTileId ? { terrainTileId: request.terrainTileId } : {}),
      savedAt,
    },
  };
}

async function patchAsset(db: SqliteDb, id: string, patch: PatchAssetRequest): Promise<PatchAssetResponse | null> {
  const row = await db.get<AssetRow>("SELECT * FROM assets WHERE id = ?", [id]);
  if (!row) {
    return null;
  }

  const enabled = patch.enabled != null ? (patch.enabled ? 1 : 0) : row.enabled;
  const lat = patch.lat ?? row.lat;
  const lon = patch.lon ?? row.lon;
  const headingDeg = patch.headingDeg != null ? normalizeHeading(patch.headingDeg) : row.heading_deg;
  const z = patch.z !== undefined ? patch.z : row.z;

  const existingProps = parseProperties<Record<string, unknown>>(row.properties);
  const properties = patch.properties != null
    ? { ...existingProps, ...patch.properties }
    : existingProps;

  await db.run(
    `
    UPDATE assets
    SET enabled = ?, lat = ?, lon = ?, heading_deg = ?, z = ?, properties = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
    `,
    [enabled, lat, lon, headingDeg, z ?? null, JSON.stringify(properties), id],
  );

  return {
    ok: true,
    id: row.id,
    type: row.type as AssetType,
    enabled: enabled === 1,
    lat,
    lon,
    headingDeg,
    z: z ?? null,
    properties,
  };
}

async function logStartupAssetSummary(db: SqliteDb): Promise<void> {
  const payload = await getAssetsResponse(db);
  const seeded = payload.seeded ?? { structureInstances: false, vehicleInstances: false };
  const structureInstances = Array.isArray(payload.structure_instances) ? payload.structure_instances : [];
  const vehicleInstances = Array.isArray(payload.vehicle_instances) ? payload.vehicle_instances : [];
  const structureDefinition = payload.structure_definition ?? FALLBACK_STRUCTURE_DEFINITION;
  const vehicleDefinition = payload.vehicle_definition ?? FALLBACK_VEHICLE_DEFINITION;

  log.info("startup assets summary", {
    phase: "assets.startup.summary",
  });
  log.info("asset catalog", {
    phase: "assets.startup.catalog",
    assetTypes: 2,
    schemaVersion: payload.schemaVersion,
    source: payload.source,
    structureInstances: structureInstances.length,
    structureSeeded: seeded.structureInstances,
    structureModelUrl: String(structureDefinition.url ?? ""),
    vehicleInstances: vehicleInstances.length,
    vehicleSeeded: seeded.vehicleInstances,
    vehicleModelUrl: String(vehicleDefinition.url ?? ""),
  });
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res).catch(next);
  };
}

async function main(): Promise<void> {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  const db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  });
  await initDb(db);
  await logStartupAssetSummary(db);

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "256kb" }));

  app.get("/api/assets", asyncRoute(async (_req: Request, res: Response) => {
    const payload = await getAssetsResponse(db);
    res.json(payload);
  }));

  app.post("/api/vehicle_state", asyncRoute(async (req: Request, res: Response) => {
    const parsed = parseSaveVehicleRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const payload = await saveVehicleState(db, parsed.value);
    res.json(payload);
  }));

  app.patch("/api/asset/:id", asyncRoute(async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: "missing asset id" });
      return;
    }

    const body = req.body as JsonObject | null;
    if (body == null || typeof body !== "object") {
      res.status(400).json({ error: "request body must be a JSON object" });
      return;
    }

    const patch: PatchAssetRequest = {};

    const enabledRaw = coerceBool(body.enabled);
    if (enabledRaw != null) {
      patch.enabled = enabledRaw;
    }

    const latRaw = coerceFiniteNumber(body.lat);
    if (latRaw != null) {
      if (latRaw < -90 || latRaw > 90) {
        res.status(400).json({ error: "lat must be between -90 and 90" });
        return;
      }
      patch.lat = latRaw;
    }

    const lonRaw = coerceFiniteNumber(body.lon);
    if (lonRaw != null) {
      if (lonRaw < -180 || lonRaw > 180) {
        res.status(400).json({ error: "lon must be between -180 and 180" });
        return;
      }
      patch.lon = lonRaw;
    }

    const headingRaw = coerceFiniteNumber(body.headingDeg);
    if (headingRaw != null) {
      patch.headingDeg = headingRaw;
    }

    if (body.z !== undefined) {
      if (body.z === null) {
        patch.z = null;
      } else {
        const zRaw = coerceFiniteNumber(body.z);
        if (zRaw != null) {
          patch.z = zRaw;
        }
      }
    }

    if (body.properties != null && typeof body.properties === "object") {
      patch.properties = body.properties as PatchAssetRequest["properties"];
    }

    const result = await patchAsset(db, id, patch);
    if (result == null) {
      res.status(404).json({ error: `asset '${id}' not found` });
      return;
    }
    res.json(result);
  }));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, dbPath: DB_PATH });
  });

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    log.error(`${req.method} ${req.originalUrl} failed`, {
      phase: "assets.api.failed",
      error,
    });
    res.status(500).json({ error: "internal server error" });
  });

  const server = app.listen(PORT, HOST, () => {
    log.info(`listening on http://${HOST}:${PORT}`, {
      phase: "assets.startup.listen",
      host: HOST,
      port: PORT,
    });
    log.info(`sqlite db: ${DB_PATH}`, {
      phase: "assets.startup.db_path",
      dbPath: DB_PATH,
    });
    log.info(`metadata path preference: ${METADATA_PATH}`, {
      phase: "assets.startup.metadata_path",
      metadataPath: METADATA_PATH,
    });
  });

  const shutdown = async () => {
    server.close(() => {
      void db.close();
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  log.error("startup failed", {
    phase: "assets.startup.failed",
    error,
  });
  process.exit(1);
});
