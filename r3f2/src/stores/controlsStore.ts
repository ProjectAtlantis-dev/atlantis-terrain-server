import { create } from 'zustand';
import { DEFAULT_MAP_ZOOM } from '@/utils/constants';

export interface ControlsState {
  // Camera look
  yaw: number;
  pitch: number;
  speed: number;

  // Mouse
  dragging: boolean;
  dragButton: number;

  // Map mode
  mapMode: boolean;
  mapZoom: number;
  mapPanEast: number;
  mapPanNorth: number;

  // Key state
  keys: Record<string, boolean>;

  // Actions
  setYaw: (v: number) => void;
  setPitch: (v: number) => void;
  setSpeed: (v: number) => void;
  setDragging: (v: boolean, button?: number) => void;
  setMapMode: (v: boolean) => void;
  setMapZoom: (v: number) => void;
  setMapPan: (east: number, north: number) => void;
  setKey: (key: string, pressed: boolean) => void;
  clearKeys: () => void;
  isPressed: (key: string, alt?: string) => boolean;
}

export const useControlsStore = create<ControlsState>((set, get) => ({
  yaw: 0,
  pitch: -0.32,
  speed: 0,
  dragging: false,
  dragButton: 0,
  mapMode: false,
  mapZoom: DEFAULT_MAP_ZOOM,
  mapPanEast: 0,
  mapPanNorth: 0,
  keys: {},

  setYaw: (v) => set({ yaw: v }),
  setPitch: (v) => set({ pitch: v }),
  setSpeed: (v) => set({ speed: v }),
  setDragging: (v, button = 0) => set({ dragging: v, dragButton: button }),
  setMapMode: (v) =>
    set({
      mapMode: v,
      mapPanEast: 0,
      mapPanNorth: 0,
    }),
  setMapZoom: (v) => set({ mapZoom: Math.max(500, Math.min(40000, v)) }),
  setMapPan: (east, north) => set({ mapPanEast: east, mapPanNorth: north }),
  setKey: (key, pressed) =>
    set((state) => ({
      keys: { ...state.keys, [key]: pressed },
    })),
  clearKeys: () => set({ keys: {} }),
  isPressed: (key, alt) => {
    const k = get().keys;
    return !!(k[key] || (alt && k[alt]));
  },
}));
