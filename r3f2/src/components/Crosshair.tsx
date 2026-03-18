import { useUIStore } from '@/stores/uiStore';

/**
 * Turret crosshair overlay — visible when in turret control mode.
 */
export function Crosshair() {
  const visible = useUIStore((s) => s.crosshairVisible);

  return (
    <div
      style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%,-50%)',
        pointerEvents: 'none',
        zIndex: 10,
        display: visible ? 'block' : 'none',
      }}
    >
      <svg width="60" height="60" viewBox="0 0 60 60">
        <circle cx="30" cy="30" r="18" stroke="#0f0" strokeWidth="1.5" fill="none" opacity="0.8" />
        <line x1="30" y1="6" x2="30" y2="22" stroke="#0f0" strokeWidth="1.5" opacity="0.8" />
        <line x1="30" y1="38" x2="30" y2="54" stroke="#0f0" strokeWidth="1.5" opacity="0.8" />
        <line x1="6" y1="30" x2="22" y2="30" stroke="#0f0" strokeWidth="1.5" opacity="0.8" />
        <line x1="38" y1="30" x2="54" y2="30" stroke="#0f0" strokeWidth="1.5" opacity="0.8" />
        <circle cx="30" cy="30" r="2" fill="#0f0" opacity="0.6" />
      </svg>
    </div>
  );
}
