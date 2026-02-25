import cors from "cors";
import express, { type Request, type Response } from "express";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";
import {
  type AssetMetadata,
  type AssetsResponse,
  type JsonObject,
  type SaveVehicleRequest,
  type SaveVehicleStateResponse,
  type StructureDefinition,
  type StructureInstance,
  type VehicleDefinition,
  type VehicleHeadlights,
  type VehicleInstance,
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

const FALLBACK_SEED_STRUCTURE_INSTANCES: StructureInstance[] = [
  { id: "nuuk-01", lat: 64.179102, lon: -51.712988, headingDeg: 22, scale: 1.0, tileId: "12-1375-791" },
  { id: "nuuk-02", lat: 64.174556, lon: -51.703948, headingDeg: 58, scale: 0.96, tileId: "12-1376-791" },
  { id: "nuuk-03", lat: 64.18533, lon: -51.703495, headingDeg: 96, scale: 1.08, tileId: "12-1376-792" },
  { id: "nuuk-04", lat: 64.182984, lon: -51.726468, headingDeg: 144, scale: 1.03, tileId: "12-1374-792" },
  { id: "nuuk-05", lat: 64.173514, lon: -51.718454, headingDeg: 210, scale: 0.98, tileId: "12-1374-791" },
  { id: "nuuk-06", lat: 64.178473, lon: -51.724776, headingDeg: 288, scale: 1.04, tileId: "12-1374-791" },
];

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

async function resolveMetadataFilePath(): Promise<string | null> {
  try {
    await fs.access(METADATA_PATH);
    return METADATA_PATH;
  } catch {
    // ignore
  }

  if (METADATA_PATH != LEGACY_METADATA_PATH) {
    try {
      await fs.access(LEGACY_METADATA_PATH);
      return LEGACY_METADATA_PATH;
    } catch {
      return null;
    }
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
    try {
      const parsed = await readJsonFile(metadataPath);
      if (parsed != null && typeof parsed === "object") {
        payload = parsed as JsonObject;
        source = "metadata_file";
      } else {
        log.warn(`metadata root is not an object: ${metadataPath}`, {
          phase: "assets.metadata.invalid_root",
          metadataPath,
        });
      }
    } catch (error) {
      log.warn(`failed to load metadata ${metadataPath}`, {
        phase: "assets.metadata.load_failed",
        metadataPath,
        error,
      });
    }
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

  return {
    source,
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

    CREATE TABLE IF NOT EXISTS structure_sites (
      id TEXT PRIMARY KEY,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      heading_deg REAL NOT NULL DEFAULT 0,
      scale REAL NOT NULL DEFAULT 1,
      tile_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vehicle_instances (
      vehicle_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      heading_deg REAL NOT NULL,
      z REAL,
      terrain_depth INTEGER,
      terrain_tile_id TEXT,
      headlights_on INTEGER NOT NULL DEFAULT 1,
      saved_at REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

async function ensureStructureSeeds(db: SqliteDb, seedInstances: StructureInstance[]): Promise<boolean> {
  const row = await db.get<{ count: number }>("SELECT COUNT(*) as count FROM structure_sites");
  if ((row?.count ?? 0) > 0) {
    return false;
  }

  for (const site of seedInstances) {
    await db.run(
      `
      INSERT OR REPLACE INTO structure_sites
      (id, lat, lon, heading_deg, scale, tile_id, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      `,
      [site.id, site.lat, site.lon, site.headingDeg, site.scale, site.tileId ?? null],
    );
  }

  return true;
}

async function ensureVehicleSeeds(db: SqliteDb, seedInstances: VehicleSeedInstance[]): Promise<boolean> {
  const row = await db.get<{ count: number }>("SELECT COUNT(*) as count FROM vehicle_instances");
  if ((row?.count ?? 0) > 0) {
    return false;
  }

  const now = Date.now() / 1000;
  for (const instance of seedInstances) {
    await db.run(
      `
      INSERT OR REPLACE INTO vehicle_instances
      (vehicle_id, enabled, lat, lon, heading_deg, z, terrain_depth, terrain_tile_id, headlights_on, saved_at, updated_at)
      VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `,
      [
        instance.vehicleId,
        instance.state.lat,
        instance.state.lon,
        instance.state.headingDeg,
        instance.state.z ?? null,
        instance.state.terrainDepth ?? null,
        instance.state.terrainTileId ?? null,
        instance.headlightsOn ? 1 : 0,
        now,
      ],
    );
  }

  return true;
}

type VehicleRow = {
  vehicle_id: string;
  lat: number;
  lon: number;
  heading_deg: number;
  z: number | null;
  terrain_depth: number | null;
  terrain_tile_id: string | null;
  headlights_on: number;
  saved_at: number;
};

type StructureRow = {
  id: string;
  lat: number;
  lon: number;
  heading_deg: number;
  scale: number;
  tile_id: string | null;
};

async function loadVehicleInstances(db: SqliteDb): Promise<VehicleInstance[]> {
  const rows = await db.all<VehicleRow[]>(
    `
    SELECT vehicle_id, lat, lon, heading_deg, z, terrain_depth, terrain_tile_id, headlights_on, saved_at
    FROM vehicle_instances
    WHERE enabled = 1
    ORDER BY updated_at DESC, vehicle_id
    `,
  );

  const out: VehicleInstance[] = [];
  for (const row of rows) {
    const validated = validateStateCommon({
      lat: row.lat,
      lon: row.lon,
      headingDeg: row.heading_deg,
      z: row.z,
      terrainDepth: row.terrain_depth,
      terrainTileId: row.terrain_tile_id,
    });
    if (validated == null) {
      continue;
    }

    out.push({
      id: String(row.vehicle_id),
      headlightsOn: row.headlights_on === 1,
      ...validated,
      savedAt: row.saved_at,
    });
  }

  return out;
}

async function loadStructureInstances(db: SqliteDb): Promise<StructureInstance[]> {
  const rows = await db.all<StructureRow[]>(
    `
    SELECT id, lat, lon, heading_deg, scale, tile_id
    FROM structure_sites
    WHERE enabled = 1
    ORDER BY id
    `,
  );

  const out: StructureInstance[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const site = sanitizeStructureSite(
      {
        id: row.id,
        lat: row.lat,
        lon: row.lon,
        headingDeg: row.heading_deg,
        scale: row.scale,
        tileId: row.tile_id,
      },
      index,
    );
    if (site != null) {
      out.push(site);
    }
  }

  return out;
}

async function resolvePrimaryVehicleId(db: SqliteDb): Promise<string> {
  const primaryEnabled = await db.get<{ vehicle_id: string }>(
    `
    SELECT vehicle_id
    FROM vehicle_instances
    WHERE enabled = 1
    ORDER BY updated_at DESC, vehicle_id
    LIMIT 1
    `,
  );
  if (primaryEnabled?.vehicle_id) {
    return String(primaryEnabled.vehicle_id);
  }

  const anyVehicle = await db.get<{ vehicle_id: string }>(
    `
    SELECT vehicle_id
    FROM vehicle_instances
    ORDER BY updated_at DESC, vehicle_id
    LIMIT 1
    `,
  );
  if (anyVehicle?.vehicle_id) {
    return String(anyVehicle.vehicle_id);
  }

  return DEFAULT_VEHICLE_INSTANCE_ID;
}

async function getAssetsResponse(db: SqliteDb): Promise<AssetsResponse> {
  const metadata = await loadAssetsMetadata();
  const seededStructures = await ensureStructureSeeds(db, metadata.seedStructureInstances);
  const seededVehicles = await ensureVehicleSeeds(db, metadata.seedVehicleInstances);

  const structureInstances = await loadStructureInstances(db);
  const vehicleInstances = await loadVehicleInstances(db);

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
  const vehicleId = await resolvePrimaryVehicleId(db);
  const savedAt = Date.now() / 1000;

  const existingHeadlights = await db.get<{ headlights_on: number }>(
    "SELECT headlights_on FROM vehicle_instances WHERE vehicle_id = ?",
    [vehicleId],
  );
  const headlightsOn = existingHeadlights?.headlights_on === 0 ? 0 : 1;

  await db.run(
    `
    INSERT INTO vehicle_instances
    (vehicle_id, enabled, lat, lon, heading_deg, z, terrain_depth, terrain_tile_id, headlights_on, saved_at, updated_at)
    VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(vehicle_id) DO UPDATE SET
      enabled = 1,
      lat = excluded.lat,
      lon = excluded.lon,
      heading_deg = excluded.heading_deg,
      z = excluded.z,
      terrain_depth = excluded.terrain_depth,
      terrain_tile_id = excluded.terrain_tile_id,
      saved_at = excluded.saved_at,
      updated_at = CURRENT_TIMESTAMP
    `,
    [
      vehicleId,
      request.lat,
      request.lon,
      request.headingDeg,
      request.z ?? null,
      request.terrainDepth ?? null,
      request.terrainTileId ?? null,
      headlightsOn,
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

async function logStartupAssetSummary(db: SqliteDb): Promise<void> {
  try {
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
  } catch (error) {
    log.warn("startup assets summary failed", {
      phase: "assets.startup.summary_failed",
      error,
    });
  }
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

  app.get("/api/assets", async (_req: Request, res: Response) => {
    try {
      const payload = await getAssetsResponse(db);
      res.json(payload);
    } catch (error) {
      log.error("/api/assets failed", {
        phase: "assets.api.get_failed",
        error,
      });
      res.status(500).json({ error: "asset endpoint failed" });
    }
  });

  app.post("/api/vehicle_state", async (req: Request, res: Response) => {
    const parsed = parseSaveVehicleRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      const payload = await saveVehicleState(db, parsed.value);
      res.json(payload);
    } catch (error) {
      log.error("/api/vehicle_state failed", {
        phase: "assets.api.vehicle_state_failed",
        error,
      });
      res.status(500).json({ error: "vehicle state save failed" });
    }
  });

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, dbPath: DB_PATH });
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
