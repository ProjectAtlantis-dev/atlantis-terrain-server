import { create } from 'zustand';

export interface UIState {
  // HUD visibility
  hudVisible: boolean;

  // Crosshair
  crosshairVisible: boolean;

  // Tuning panel
  tuningOpen: boolean;
  tuningState: Record<string, number | boolean>;

  // Google Maps panel
  gmapsPanelOpen: boolean;
  gmapsPanelMinimized: boolean;
  gmapsActiveTab: number;

  // Tile inspector (map mode)
  tileInfoVisible: boolean;
  tileInfoContent: string;

  // Houses
  housesVisible: boolean;

  // Actions
  setHudVisible: (v: boolean) => void;
  setCrosshairVisible: (v: boolean) => void;
  setTuningOpen: (v: boolean) => void;
  setTuningValue: (key: string, value: number | boolean) => void;
  setGmapsPanelOpen: (v: boolean) => void;
  setGmapsPanelMinimized: (v: boolean) => void;
  setGmapsActiveTab: (v: number) => void;
  setTileInfo: (visible: boolean, content?: string) => void;
  setHousesVisible: (v: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  hudVisible: true,
  crosshairVisible: false,
  tuningOpen: false,
  tuningState: {},
  gmapsPanelOpen: false,
  gmapsPanelMinimized: false,
  gmapsActiveTab: 0,
  tileInfoVisible: false,
  tileInfoContent: '',
  housesVisible: false, // enabled from asset server config

  setHudVisible: (v) => set({ hudVisible: v }),
  setCrosshairVisible: (v) => set({ crosshairVisible: v }),
  setTuningOpen: (v) => set({ tuningOpen: v }),
  setTuningValue: (key, value) =>
    set((s) => ({
      tuningState: { ...s.tuningState, [key]: value },
    })),
  setGmapsPanelOpen: (v) => set({ gmapsPanelOpen: v }),
  setGmapsPanelMinimized: (v) => set({ gmapsPanelMinimized: v }),
  setGmapsActiveTab: (v) => set({ gmapsActiveTab: v }),
  setTileInfo: (visible, content) =>
    set({ tileInfoVisible: visible, tileInfoContent: content ?? '' }),
  setHousesVisible: (v) => set({ housesVisible: v }),
}));
