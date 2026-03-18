import { useState, useCallback, useRef, useEffect } from 'react';
import { useUIStore } from '@/stores/uiStore';

const TUNING_STORAGE_KEY = 'clouds-tuning';

interface SliderDef {
  label: string;
  section: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  format?: (v: number) => string;
  decimals?: number;
}

interface ToggleDef {
  label: string;
  section: string;
  defaultValue: boolean;
}

type TuningDef = (SliderDef & { type: 'slider' }) | (ToggleDef & { type: 'toggle' });

const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const TUNING_DEFS: TuningDef[] = [
  // Date / Time
  {
    type: 'slider', section: 'Date / Time', label: 'month',
    min: 1, max: 12, step: 1, defaultValue: 7, decimals: 0,
    format: (v) => monthNames[v - 1],
  },
  // Aerial Perspective
  {
    type: 'slider', section: 'Aerial Perspective', label: 'albedoScale',
    min: 0, max: 3, step: 0.05, defaultValue: 1.0,
  },
  {
    type: 'slider', section: 'Aerial Perspective', label: 'shadowRadius',
    min: 0, max: 5, step: 0.1, defaultValue: 1.0,
  },
  {
    type: 'toggle', section: 'Aerial Perspective', label: 'sunIrradiance', defaultValue: true,
  },
  {
    type: 'toggle', section: 'Aerial Perspective', label: 'skyIrradiance', defaultValue: true,
  },
  {
    type: 'toggle', section: 'Aerial Perspective', label: 'inscatter', defaultValue: true,
  },
  // Clouds
  {
    type: 'slider', section: 'Clouds', label: 'cloud altitude',
    min: -2000, max: 5000, step: 50, defaultValue: 0, decimals: 0,
    format: (v) => `${v > 0 ? '+' : ''}${v}m`,
  },
  {
    type: 'slider', section: 'Clouds', label: 'coverage',
    min: 0, max: 1, step: 0.01, defaultValue: 0.5,
  },
  {
    type: 'slider', section: 'Clouds', label: 'cirrus density',
    min: 0, max: 0.002, step: 0.0001, defaultValue: 0, decimals: 4,
  },
  {
    type: 'slider', section: 'Clouds', label: 'cirrus coverage',
    min: 0.1, max: 3, step: 0.05, defaultValue: 1.0, decimals: 2,
    format: (v) => v <= 0.1 ? 'full' : v >= 3 ? 'sparse' : v.toFixed(2),
  },
  {
    type: 'toggle', section: 'Clouds', label: 'cirrus', defaultValue: false,
  },
  {
    type: 'slider', section: 'Clouds', label: 'cirrus shape',
    min: 0, max: 1, step: 0.01, defaultValue: 0.5,
  },
  {
    type: 'slider', section: 'Clouds', label: 'drift speed',
    min: 0, max: 0.002, step: 0.00005, defaultValue: 0.00004, decimals: 6,
  },
  {
    type: 'slider', section: 'Clouds', label: 'drift direction',
    min: 0, max: 360, step: 5, defaultValue: 0, decimals: 0,
    format: (v) => `${v}°`,
  },
  // Terrain
  {
    type: 'slider', section: 'Terrain', label: 'terrain range',
    min: 10000, max: 50000, step: 1000, defaultValue: 30000, decimals: 0,
    format: (v) => `${(v / 1000).toFixed(0)}km`,
  },
  // Atmosphere
  {
    type: 'slider', section: 'Atmosphere', label: 'fog strength',
    min: 1, max: 10, step: 0.5, defaultValue: 4.5, decimals: 1,
  },
  {
    type: 'slider', section: 'Atmosphere', label: 'cloud distance',
    min: 5000, max: 200000, step: 5000, defaultValue: 80000, decimals: 0,
    format: (v) => `${(v / 1000).toFixed(0)}km`,
  },
  {
    type: 'slider', section: 'Atmosphere', label: 'turbulence',
    min: 0, max: 2000, step: 50, defaultValue: 500, decimals: 0,
  },
  {
    type: 'slider', section: 'Atmosphere', label: 'scattering',
    min: 0, max: 5, step: 0.1, defaultValue: 0, decimals: 1,
  },
  {
    type: 'slider', section: 'Atmosphere', label: 'absorption',
    min: 0, max: 5, step: 0.1, defaultValue: 0, decimals: 1,
  },
];

function loadSaved(): Record<string, number | boolean> {
  try {
    return JSON.parse(localStorage.getItem(TUNING_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function savePersistent(state: Record<string, number | boolean>) {
  localStorage.setItem(TUNING_STORAGE_KEY, JSON.stringify(state));
}

/**
 * Atmosphere/Clouds tuning panel — collapsible, persists to localStorage,
 * pushes values to uiStore.tuningState for AtmosphereEffects to consume.
 */
export function TuningPanel() {
  const open = useUIStore((s) => s.tuningOpen);
  const setTuningOpen = useUIStore((s) => s.setTuningOpen);
  const setTuningValue = useUIStore((s) => s.setTuningValue);

  const savedRef = useRef(loadSaved());
  const [values, setValues] = useState<Record<string, number | boolean>>(() => {
    const initial: Record<string, number | boolean> = {};
    for (const def of TUNING_DEFS) {
      const saved = savedRef.current[def.label];
      initial[def.label] = saved != null ? saved : def.defaultValue;
    }
    return initial;
  });

  // Push initial values to store
  useEffect(() => {
    for (const [key, val] of Object.entries(values)) {
      setTuningValue(key, val);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSlider = useCallback((label: string, v: number) => {
    setValues((prev) => ({ ...prev, [label]: v }));
    savedRef.current[label] = v;
    savePersistent(savedRef.current);
    setTuningValue(label, v);
  }, [setTuningValue]);

  const handleToggle = useCallback((label: string, v: boolean) => {
    setValues((prev) => ({ ...prev, [label]: v }));
    savedRef.current[label] = v;
    savePersistent(savedRef.current);
    setTuningValue(label, v);
  }, [setTuningValue]);

  const handleReset = useCallback(() => {
    const initial: Record<string, number | boolean> = {};
    for (const def of TUNING_DEFS) {
      initial[def.label] = def.defaultValue;
      setTuningValue(def.label, def.defaultValue);
    }
    setValues(initial);
    savedRef.current = {};
    savePersistent({});
  }, [setTuningValue]);

  // Unique sections in order
  const sections: string[] = [];
  for (const def of TUNING_DEFS) {
    if (!sections.includes(def.section)) sections.push(def.section);
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        width: 300,
        background: 'rgba(0,0,0,0.8)',
        color: '#dbe5f1',
        font: '12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
        borderRadius: 8,
        zIndex: 10,
        userSelect: 'none',
        backdropFilter: 'blur(6px)',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '8px 12px',
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
        onClick={() => setTuningOpen(!open)}
      >
        <span>Atmosphere</span>
        <span dangerouslySetInnerHTML={{ __html: open ? '&#9650;' : '&#9660;' }} />
      </div>

      {/* Body */}
      {open && (
        <div style={{ padding: '0 12px 10px' }}>
          {sections.map((section) => (
            <div key={section}>
              <div
                style={{
                  margin: '10px 0 4px',
                  fontSize: 10,
                  textTransform: 'uppercase',
                  color: '#6889a8',
                  letterSpacing: 1,
                  borderBottom: '1px solid #334',
                  paddingBottom: 3,
                }}
              >
                {section}
              </div>
              {TUNING_DEFS.filter((d) => d.section === section).map((def) =>
                def.type === 'slider' ? (
                  <TuningSlider
                    key={def.label}
                    def={def}
                    value={values[def.label] as number}
                    onChange={handleSlider}
                  />
                ) : (
                  <TuningToggle
                    key={def.label}
                    def={def}
                    value={values[def.label] as boolean}
                    onChange={handleToggle}
                  />
                )
              )}
            </div>
          ))}
          <div style={{ marginTop: 8, textAlign: 'right' }}>
            <button
              onClick={handleReset}
              style={{
                background: 'rgba(255,255,255,0.1)',
                border: '1px solid #445',
                borderRadius: 4,
                color: '#9ab',
                padding: '3px 10px',
                cursor: 'pointer',
                fontSize: 11,
              }}
            >
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TuningSlider({
  def,
  value,
  onChange,
}: {
  def: SliderDef;
  value: number;
  onChange: (label: string, v: number) => void;
}) {
  const fmt = def.format ?? ((v: number) => v.toFixed(def.decimals ?? 2));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '5px 0' }}>
      <span style={{ flex: '0 0 90px', fontSize: 11, color: '#9ab' }}>{def.label}</span>
      <input
        type="range"
        min={def.min}
        max={def.max}
        step={def.step}
        value={value}
        onChange={(e) => onChange(def.label, Number(e.target.value))}
        style={{ flex: 1, accentColor: '#5af' }}
      />
      <span style={{ flex: '0 0 40px', textAlign: 'right', fontSize: 11, color: '#7cf' }}>
        {fmt(value)}
      </span>
    </div>
  );
}

function TuningToggle({
  def,
  value,
  onChange,
}: {
  def: ToggleDef;
  value: boolean;
  onChange: (label: string, v: boolean) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '5px 0' }}>
      <span style={{ flex: '0 0 90px', fontSize: 11, color: '#9ab' }}>{def.label}</span>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(def.label, e.target.checked)}
        style={{ accentColor: '#5af' }}
      />
    </div>
  );
}
