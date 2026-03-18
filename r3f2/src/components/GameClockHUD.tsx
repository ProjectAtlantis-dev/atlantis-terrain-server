import { useEffect, useRef } from 'react';
import { useGameClockStore } from '@/stores/gameClockStore';

/**
 * Game clock HUD with transport controls (rewind, stop, play, fast-forward).
 */
export function GameClockHUD() {
  const elRef = useRef<HTMLDivElement>(null);
  const intervalRef = useRef<number>(0);

  useEffect(() => {
    const update = () => {
      if (!elRef.current) return;
      const state = useGameClockStore.getState();
      const gameDate = state.useRealtime ? state.getGameDate() : state.currentDate;

      const nuukTime = gameDate.toLocaleString('en-GB', {
        timeZone: 'America/Nuuk',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const [hh, mm] = nuukTime.split(':');

      const btnStyle = 'cursor:pointer;padding:0 4px;border:none;background:none;font-size:12px;line-height:1;vertical-align:middle;';
      const activeClr = '#5af';

      elRef.current.innerHTML =
        `<button data-gc="rw" style="${btnStyle}color:${activeClr}" title="−15 min"><i class="fa-solid fa-backward"></i></button>` +
        ` <b>${hh}:${mm}</b>` +
        (state.useRealtime
          ? `<button data-gc="stop" style="${btnStyle}color:${activeClr}" title="Pause"><i class="fa-solid fa-pause"></i></button>`
          : `<button data-gc="play" style="${btnStyle}color:${activeClr}" title="Play 24×"><i class="fa-solid fa-play"></i></button>`) +
        `<button data-gc="ff" style="${btnStyle}color:${activeClr}" title="+15 min"><i class="fa-solid fa-forward"></i></button>`;
    };

    intervalRef.current = window.setInterval(update, 500);
    update();

    const el = elRef.current;
    const handleClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest('button[data-gc]') as HTMLElement | null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const action = btn.dataset.gc;
      const store = useGameClockStore.getState();
      if (action === 'rw') store.rewind();
      else if (action === 'stop') store.stop();
      else if (action === 'play') store.play();
      else if (action === 'ff') store.fastForward();
    };

    el?.addEventListener('mousedown', handleClick);
    return () => {
      clearInterval(intervalRef.current);
      el?.removeEventListener('mousedown', handleClick);
    };
  }, []);

  return (
    <div
      ref={elRef}
      style={{
        position: 'absolute',
        left: 12,
        bottom: 12,
        padding: '8px 10px',
        background: 'rgba(0,0,0,0.7)',
        color: '#5af',
        font: "13px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
        borderRadius: 6,
        pointerEvents: 'auto',
        zIndex: 5,
        userSelect: 'none',
      }}
    />
  );
}
