import { create } from 'zustand';
import {
  REFERENCE_DATE,
  GAME_TIME_SCALE,
  GAME_CLOCK_STORAGE_KEY,
} from '@/utils/constants';

export interface GameClockState {
  gameClockStartMs: number;
  browserTimeStartMs: number;
  currentDate: Date;
  useRealtime: boolean;
  lastSaveMs: number;

  // Actions
  getGameDate: (nowMs?: number) => Date;
  rewind: () => void;
  stop: () => void;
  play: () => void;
  fastForward: () => void;
  tick: () => void;
  saveIfNeeded: () => void;
}

export const useGameClockStore = create<GameClockState>((set, get) => {
  const savedMs = Number(localStorage.getItem(GAME_CLOCK_STORAGE_KEY));
  const startMs = savedMs || REFERENCE_DATE.getTime();

  // Check if we have saved tuning month/hour that overrides realtime
  let savedTuning: Record<string, unknown> = {};
  try {
    savedTuning = JSON.parse(localStorage.getItem('tuning') || '{}');
  } catch {
    // ignore
  }
  const hasSavedMonth = 'month' in savedTuning;
  const hasSavedHour = 'hour (UTC)' in savedTuning;
  const initialRealtime = !(hasSavedMonth || hasSavedHour);

  return {
    gameClockStartMs: startMs,
    browserTimeStartMs: Date.now(),
    currentDate: new Date(startMs),
    useRealtime: initialRealtime,
    lastSaveMs: 0,

    getGameDate: (nowMs = Date.now()) => {
      const state = get();
      const elapsed = nowMs - state.browserTimeStartMs;
      return new Date(state.gameClockStartMs + elapsed * GAME_TIME_SCALE);
    },

    rewind: () => {
      const state = get();
      let date: Date;
      if (state.useRealtime) {
        date = state.getGameDate();
      } else {
        date = new Date(state.currentDate);
      }
      date.setTime(date.getTime() - 15 * 60 * 1000);
      set({ currentDate: date, useRealtime: false });
    },

    stop: () => {
      const state = get();
      if (state.useRealtime) {
        set({ currentDate: state.getGameDate(), useRealtime: false });
      } else {
        set({ useRealtime: false });
      }
    },

    play: () => {
      const state = get();
      if (!state.useRealtime) {
        set({
          gameClockStartMs: state.currentDate.getTime(),
          browserTimeStartMs: Date.now(),
          useRealtime: true,
        });
      }
    },

    fastForward: () => {
      const state = get();
      let date: Date;
      if (state.useRealtime) {
        date = state.getGameDate();
      } else {
        date = new Date(state.currentDate);
      }
      date.setTime(date.getTime() + 15 * 60 * 1000);
      set({ currentDate: date, useRealtime: false });
    },

    tick: () => {
      const state = get();
      if (state.useRealtime) {
        set({ currentDate: state.getGameDate() });
      }
    },

    saveIfNeeded: () => {
      const now = performance.now();
      const state = get();
      if (now - state.lastSaveMs > 5000) {
        localStorage.setItem(
          GAME_CLOCK_STORAGE_KEY,
          String(state.currentDate.getTime())
        );
        set({ lastSaveMs: now });
      }
    },
  };
});
