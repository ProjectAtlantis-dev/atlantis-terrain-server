export interface TileData {
  id: string;
  bbox: [number, number, number, number]; // [xMin, yMin, xMax, yMax]
  depth: number;
  center: [number, number];
  size: number;
  resolution: number;
  heightmap: string; // base64-encoded float32 array
  source: string;
  geometric_error: number;
}

export interface TileResponse {
  tiles: TileData[];
  missing: Array<[string, [number, number, number, number]]>;
  origin?: { x: number; y: number };
  cam?: { stereo_x: number; stereo_y: number };
}

export interface ParsedTileAddress {
  depth: number;
  col: number;
  row: number;
}

export interface TerrainMeshUserData {
  tileId: string;
  bbox: [number, number, number, number];
  isWater?: boolean;
  oceanCoverage?: number;
}
