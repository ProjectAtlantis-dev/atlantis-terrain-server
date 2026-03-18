import { create } from 'zustand';
import * as THREE from 'three';
import type { TileData } from '@/types/terrain';

export interface TerrainTileState {
  mesh: THREE.Mesh;
  tileId: string;
  depth: number;
  bbox: [number, number, number, number];
  hasTexture: boolean;
  textureSource: string | null;
}

export interface TerrainState {
  // Origin offset (set on first tile fetch)
  originX: number;
  originY: number;
  frameOffsetX: number;
  frameOffsetY: number;
  originSet: boolean;

  // Camera stereo coords
  camStereoX: number;
  camStereoY: number;
  lastFetchX: number;
  lastFetchY: number;

  // Tiles
  tiles: Map<string, TerrainTileState>;
  currentTileIds: Set<string>;
  lastTiles: TileData[] | null;

  // Loading state
  loadPass: number; // 1 = preview, 2 = full
  isFirstLoad: boolean;
  fetching: boolean;
  lastFetchTriggerMs: number;

  // Texture cache
  texCache: Map<string, THREE.Texture>;
  texSource: Map<string, string>;
  texInflight: Map<string, AbortController>;

  // Deferred tiles (heightmap ready, no texture yet)
  deferredTiles: Map<string, TileData>;

  // terrainRoot ref (set by TerrainRoot component)
  terrainRoot: THREE.Group | null;

  // Actions
  setOrigin: (x: number, y: number) => void;
  setFrameOffset: (x: number, y: number) => void;
  setCamStereo: (x: number, y: number) => void;
  setLastFetch: (x: number, y: number) => void;
  setTerrainRoot: (root: THREE.Group) => void;
  addTile: (id: string, state: TerrainTileState) => void;
  removeTile: (id: string) => void;
  setTileTexture: (id: string, texture: THREE.Texture, source: string) => void;
  setLastTiles: (tiles: TileData[]) => void;
  setLoadPass: (pass: number) => void;
  setFirstLoad: (v: boolean) => void;
  setFetching: (v: boolean) => void;
  cacheTexture: (tileId: string, texture: THREE.Texture, source: string) => void;
  addDeferred: (tileId: string, tile: TileData) => void;
  removeDeferred: (tileId: string) => void;
}

export const useTerrainStore = create<TerrainState>((set, get) => ({
  originX: 0,
  originY: 0,
  frameOffsetX: 0,
  frameOffsetY: 0,
  originSet: false,
  camStereoX: 0,
  camStereoY: 0,
  lastFetchX: 0,
  lastFetchY: 0,
  tiles: new Map(),
  currentTileIds: new Set(),
  lastTiles: null,
  loadPass: 1,
  isFirstLoad: true,
  fetching: false,
  lastFetchTriggerMs: 0,
  texCache: new Map(),
  texSource: new Map(),
  texInflight: new Map(),
  deferredTiles: new Map(),
  terrainRoot: null,

  setOrigin: (x, y) => set({ originX: x, originY: y, originSet: true }),
  setFrameOffset: (x, y) => set({ frameOffsetX: x, frameOffsetY: y }),
  setCamStereo: (x, y) => set({ camStereoX: x, camStereoY: y }),
  setLastFetch: (x, y) => set({ lastFetchX: x, lastFetchY: y }),
  setTerrainRoot: (root) => set({ terrainRoot: root }),

  addTile: (id, state) =>
    set((s) => {
      const tiles = new Map(s.tiles);
      tiles.set(id, state);
      const currentTileIds = new Set(s.currentTileIds);
      currentTileIds.add(id);
      return { tiles, currentTileIds };
    }),

  removeTile: (id) =>
    set((s) => {
      const tiles = new Map(s.tiles);
      const removed = tiles.get(id);
      if (removed) {
        removed.mesh.geometry.dispose();
        if (removed.mesh.material instanceof THREE.Material) {
          removed.mesh.material.dispose();
        }
        removed.mesh.removeFromParent();
      }
      tiles.delete(id);
      const currentTileIds = new Set(s.currentTileIds);
      currentTileIds.delete(id);
      return { tiles, currentTileIds };
    }),

  setTileTexture: (id, texture, source) =>
    set((s) => {
      const tiles = new Map(s.tiles);
      const tile = tiles.get(id);
      if (tile) {
        tiles.set(id, { ...tile, hasTexture: true, textureSource: source });
      }
      return { tiles };
    }),

  setLastTiles: (tiles) => set({ lastTiles: tiles }),
  setLoadPass: (pass) => set({ loadPass: pass }),
  setFirstLoad: (v) => set({ isFirstLoad: v }),
  setFetching: (v) => set({ fetching: v }),

  cacheTexture: (tileId, texture, source) =>
    set((s) => {
      const texCache = new Map(s.texCache);
      texCache.set(tileId, texture);
      const texSource = new Map(s.texSource);
      texSource.set(tileId, source);
      return { texCache, texSource };
    }),

  addDeferred: (tileId, tile) =>
    set((s) => {
      const deferredTiles = new Map(s.deferredTiles);
      deferredTiles.set(tileId, tile);
      return { deferredTiles };
    }),

  removeDeferred: (tileId) =>
    set((s) => {
      const deferredTiles = new Map(s.deferredTiles);
      deferredTiles.delete(tileId);
      return { deferredTiles };
    }),
}));
