import { useRef, useState, useEffect, useCallback } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useTerrainStore } from '@/stores/terrainStore';
import { useControlsStore } from '@/stores/controlsStore';
import { DEFAULT_LOCATION } from '@/utils/constants';

const GMAPS_UPDATE_INTERVAL = 1500;

function buildUrl(lat: string, lon: string, tab: number): string {
  if (tab === 0) return `https://maps.google.com/maps?q=${lat},${lon}&t=k&z=16&output=embed`;
  if (tab === 1) return `https://maps.google.com/maps?q=${lat},${lon}&t=m&z=16&output=embed`;
  return `/mapview.html?lat=${lat}&lon=${lon}&t=k`;
}

function getCameraLatLon(): { lat: number; lon: number; alt: number } {
  const tStore = useTerrainStore.getState();
  const terrainRoot = tStore.terrainRoot;
  if (!terrainRoot) return { lat: DEFAULT_LOCATION.lat, lon: DEFAULT_LOCATION.lon, alt: 0 };

  const enu = terrainRoot.userData.enu;
  if (!enu) return { lat: DEFAULT_LOCATION.lat, lon: DEFAULT_LOCATION.lon, alt: 0 };

  const cam = (window as any).__r3fCamera;
  if (!cam) return { lat: DEFAULT_LOCATION.lat, lon: DEFAULT_LOCATION.lon, alt: 0 };

  const rel = cam.position.clone().sub(enu.anchorPosition);
  const eastM = rel.dot(enu.east);
  const northM = rel.dot(enu.north);
  const altM = rel.dot(enu.up);

  const anchorLat = terrainRoot.userData.anchorLat ?? DEFAULT_LOCATION.lat;
  const anchorLon = terrainRoot.userData.anchorLon ?? DEFAULT_LOCATION.lon;

  return {
    lat: anchorLat + northM / 111320,
    lon: anchorLon + eastM / (111320 * Math.cos(anchorLat * Math.PI / 180)),
    alt: altM,
  };
}

/**
 * Draggable Google Maps panel with 3 tabs: Satellite, Map, Navigate.
 * Auto-updates iframe as camera moves.
 */
export function GoogleMapsPanel() {
  const open = useUIStore((s) => s.gmapsPanelOpen);
  const minimized = useUIStore((s) => s.gmapsPanelMinimized);
  const activeTab = useUIStore((s) => s.gmapsActiveTab);
  const setOpen = useUIStore((s) => s.setGmapsPanelOpen);
  const setMinimized = useUIStore((s) => s.setGmapsPanelMinimized);
  const setActiveTab = useUIStore((s) => s.setGmapsActiveTab);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const lastLatRef = useRef<string | null>(null);
  const lastLonRef = useRef<string | null>(null);
  const lastUpdateRef = useRef(0);
  const dragRef = useRef({ dragging: false, ox: 0, oy: 0 });
  const [inputValue, setInputValue] = useState('');

  // Force update iframe
  const forceUpdate = useCallback(() => {
    const camLL = getCameraLatLon();
    const lat = camLL.lat.toFixed(6);
    const lon = camLL.lon.toFixed(6);
    if (iframeRef.current) {
      iframeRef.current.src = buildUrl(lat, lon, activeTab);
    }
    lastLatRef.current = lat;
    lastLonRef.current = lon;
    lastUpdateRef.current = performance.now();
  }, [activeTab]);

  // Auto-update on interval
  useEffect(() => {
    if (!open || minimized) return;
    forceUpdate();
    const interval = setInterval(() => {
      if (!open) return;
      const now = performance.now();
      if (now - lastUpdateRef.current < GMAPS_UPDATE_INTERVAL) return;
      const camLL = getCameraLatLon();
      const lat = camLL.lat.toFixed(4);
      const lon = camLL.lon.toFixed(4);
      if (lat !== lastLatRef.current || lon !== lastLonRef.current) {
        if (activeTab === 2 && iframeRef.current?.contentWindow) {
          iframeRef.current.contentWindow.postMessage({ lat: camLL.lat, lon: camLL.lon }, '*');
          lastLatRef.current = lat;
          lastLonRef.current = lon;
        } else {
          forceUpdate();
        }
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [open, minimized, activeTab, forceUpdate]);

  // Listen for Navigate tab messages
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.ready && activeTab === 2 && open) {
        const camLL = getCameraLatLon();
        iframeRef.current?.contentWindow?.postMessage({ lat: camLL.lat, lon: camLL.lon }, '*');
      }
      if (e.data?.nav && e.data.lat != null) {
        navigateTo(e.data.lat, e.data.lon);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [activeTab, open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drag handlers
  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!dragRef.current.dragging || !panelRef.current) return;
      panelRef.current.style.left = (e.clientX - dragRef.current.ox) + 'px';
      panelRef.current.style.top = (e.clientY - dragRef.current.oy) + 'px';
      panelRef.current.style.bottom = 'auto';
      panelRef.current.style.right = 'auto';
    };
    const handleUp = () => { dragRef.current.dragging = false; };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, []);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (!panelRef.current) return;
    const r = panelRef.current.getBoundingClientRect();
    dragRef.current = { dragging: true, ox: e.clientX - r.left, oy: e.clientY - r.top };
    e.preventDefault();
  }, []);

  const navigateTo = useCallback((lat: number, lon: number) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const tStore = useTerrainStore.getState();
    const terrainRoot = tStore.terrainRoot;
    if (!terrainRoot) return;
    const enu = terrainRoot.userData.enu;
    if (!enu) return;
    const anchorLat = terrainRoot.userData.anchorLat ?? DEFAULT_LOCATION.lat;
    const anchorLon = terrainRoot.userData.anchorLon ?? DEFAULT_LOCATION.lon;
    const dLat = lat - anchorLat;
    const dLon = lon - anchorLon;
    const eM = dLon * 111320 * Math.cos(anchorLat * Math.PI / 180);
    const nM = dLat * 111320;
    const cam = (window as any).__r3fCamera;
    if (!cam) return;
    const camLL = getCameraLatLon();
    cam.position.copy(enu.anchorPosition)
      .addScaledVector(enu.east, eM)
      .addScaledVector(enu.north, nM)
      .addScaledVector(enu.up, Math.max(50, camLL.alt));
    lastLatRef.current = null;
    lastUpdateRef.current = 0;
  }, []);

  const handleGo = useCallback(() => {
    const val = inputValue.trim();
    const tokens = [...val.matchAll(/([-]?\d+(?:\.\d+)?)\s*°?\s*([NSEWnsew])?/g)];
    if (tokens.length >= 2) {
      let lat = parseFloat(tokens[0][1]);
      let lon = parseFloat(tokens[1][1]);
      const latDir = (tokens[0][2] || '').toUpperCase();
      const lonDir = (tokens[1][2] || '').toUpperCase();
      if (latDir === 'S') lat = -Math.abs(lat);
      if (lonDir === 'W') lon = -Math.abs(lon);
      navigateTo(lat, lon);
    }
  }, [inputValue, navigateTo]);

  if (!open) return null;

  const tabs = ['Satellite', 'Map', 'Navigate'];

  return (
    <div
      ref={panelRef}
      style={{
        position: 'absolute',
        bottom: 50,
        left: 12,
        width: 420,
        height: 460,
        background: 'rgba(10,16,24,0.95)',
        border: '1px solid #2a3a4a',
        borderRadius: 8,
        overflow: 'hidden',
        resize: 'both',
        minWidth: 300,
        minHeight: 200,
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        font: '12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
        color: '#dbe5f1',
        boxShadow: '0 4px 24px rgba(0,0,0,0.7)',
      }}
    >
      {/* Header (draggable) */}
      <div
        onMouseDown={handleDragStart}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '7px 10px',
          background: 'rgba(255,255,255,0.06)',
          cursor: 'grab',
          userSelect: 'none',
        }}
      >
        <span style={{ flex: 1, fontWeight: 'bold', color: '#5af' }}>
          Maps <span style={{ fontSize: 10, color: '#6889a8', fontWeight: 'normal' }}>(drag to move)</span>
        </span>
        <button
          onClick={() => setMinimized(!minimized)}
          title="Minimize"
          style={{ background: 'none', border: 'none', color: '#8aa', cursor: 'pointer', fontSize: 14, padding: '0 4px' }}
          dangerouslySetInnerHTML={{ __html: minimized ? '&#x25A1;' : '&#x2212;' }}
        />
        <button
          onClick={() => setOpen(false)}
          title="Close (G)"
          style={{ background: 'none', border: 'none', color: '#8aa', cursor: 'pointer', fontSize: 14, padding: '0 4px' }}
          dangerouslySetInnerHTML={{ __html: '&#x2715;' }}
        />
      </div>

      {!minimized && (
        <>
          {/* Nav input row */}
          <div style={{ display: 'flex', gap: 6, padding: '7px 10px', borderBottom: '1px solid #1e2d3a' }}>
            <input
              type="text"
              placeholder="Paste lat, lon  e.g. 64.18, -51.70"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleGo();
                e.stopPropagation(); // prevent WASD etc
              }}
              style={{
                flex: 1,
                background: 'rgba(255,255,255,0.07)',
                border: '1px solid #2a3a4a',
                borderRadius: 4,
                color: '#dbe5f1',
                padding: '4px 8px',
                font: '12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
                outline: 'none',
              }}
            />
            <button
              onClick={handleGo}
              style={{
                background: '#1a3a5a',
                border: '1px solid #2a5a8a',
                borderRadius: 4,
                color: '#5af',
                padding: '4px 12px',
                cursor: 'pointer',
                font: '12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
              }}
            >
              Go
            </button>
          </div>

          {/* Tab bar */}
          <div style={{ display: 'flex', borderBottom: '1px solid #1e2d3a', userSelect: 'none' }}>
            {tabs.map((label, i) => (
              <div
                key={label}
                onClick={() => {
                  setActiveTab(i);
                  lastLatRef.current = null; // force refresh
                }}
                style={{
                  flex: 1,
                  textAlign: 'center',
                  padding: '5px 0',
                  cursor: 'pointer',
                  fontSize: 11,
                  color: i === activeTab ? '#5af' : '#6889a8',
                  borderBottom: i === activeTab ? '2px solid #5af' : '2px solid transparent',
                }}
              >
                {label}
              </div>
            ))}
          </div>

          {/* iframe */}
          <div style={{ flex: 1, minHeight: 0 }}>
            <iframe
              ref={iframeRef}
              loading="eager"
              style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
            />
          </div>
        </>
      )}
    </div>
  );
}
