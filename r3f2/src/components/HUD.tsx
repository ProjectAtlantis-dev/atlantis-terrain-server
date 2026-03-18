import { useEffect, useRef } from 'react';
import { useControlsStore } from '@/stores/controlsStore';
import { useTerrainStore } from '@/stores/terrainStore';
import { useVehicleStore } from '@/stores/vehicleStore';
import { useUIStore } from '@/stores/uiStore';
import { VEHICLE_CAM_MODES, DEFAULT_LOCATION } from '@/utils/constants';

/**
 * HUD overlay: speed, heading, compass, coordinates, mode, tile info.
 */
export function HUD() {
  const hudRef = useRef<HTMLDivElement>(null);
  const altRef = useRef<HTMLDivElement>(null);
  const intervalRef = useRef<number>(0);

  useEffect(() => {
    const update = () => {
      if (!hudRef.current || !altRef.current) return;

      const controls = useControlsStore.getState();
      const vStore = useVehicleStore.getState();
      const tStore = useTerrainStore.getState();
      const uiStore = useUIStore.getState();

      if (!uiStore.hudVisible) {
        hudRef.current.style.display = 'none';
        altRef.current.style.display = 'none';
        return;
      }
      hudRef.current.style.display = 'block';
      altRef.current.style.display = 'block';

      const terrainRoot = tStore.terrainRoot;
      const activeVehicle = vStore.getActiveVehicle();

      // Compute camera position as lat/lon
      let lat = DEFAULT_LOCATION.lat;
      let lon = DEFAULT_LOCATION.lon;
      let altM = 0;
      let eastM = 0;
      let northM = 0;

      if (terrainRoot) {
        const enu = terrainRoot.userData.enu;
        if (enu) {
          // Get camera from the canvas (global)
          const cam = (window as any).__r3fCamera;
          if (cam) {
            const rel = cam.position.clone().sub(enu.anchorPosition);
            eastM = rel.dot(enu.east);
            northM = rel.dot(enu.north);
            altM = rel.dot(enu.up);
            const anchorLat = terrainRoot.userData.anchorLat ?? DEFAULT_LOCATION.lat;
            const anchorLon = terrainRoot.userData.anchorLon ?? DEFAULT_LOCATION.lon;
            lat = anchorLat + northM / 111320;
            lon = anchorLon + eastM / (111320 * Math.cos(anchorLat * Math.PI / 180));
          }
        }
      }

      const speedKmh = Math.abs(activeVehicle?.controlActive ? activeVehicle.speed * 3.6 : controls.speed * 3.6);
      const headingForHud = activeVehicle?.controlActive ? activeVehicle.headingRad : controls.yaw;
      const deg = (((-headingForHud * 180) / Math.PI) % 360 + 360) % 360;
      const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
      const compass = dirs[Math.round(deg / 45) % 8];

      const modeLabel = controls.mapMode
        ? 'MAP'
        : activeVehicle?.turretControlActive ? 'TURRET'
        : activeVehicle?.controlActive ? 'VEHICLE'
        : 'FLIGHT';

      const modeHtml = activeVehicle?.turretControlActive
        ? '<span style="color:#ff8c00">TURRET</span>'
        : activeVehicle?.controlActive
        ? '<span style="color:#ff3b30">VEHICLE</span>'
        : modeLabel;

      const tileCount = tStore.tiles.size;
      const texCount = tStore.texCache.size;

      hudRef.current.innerHTML = [
        '<b>Atlantis R3F</b>',
        `mode: <b>${modeHtml}</b>`,
        `lat: ${lat.toFixed(5)}°  lon: ${lon.toFixed(5)}°  alt: ${altM.toFixed(0)}m`,
        `enu: E ${eastM.toFixed(0)}m  N ${northM.toFixed(0)}m  U ${altM.toFixed(0)}m`,
        `speed: ${speedKmh.toFixed(0)} km/h  heading: ${deg.toFixed(0)}° ${compass}`,
        `tiles: ${tileCount}  textures: ${texCount}`,
        activeVehicle?.turretControlActive
          ? 'Mouse aim turret, LMB fire .50cal, WASD drive, T or Esc exit turret'
          : activeVehicle?.controlActive
          ? `W/S drive, A/D steer, V camera (${VEHICLE_CAM_MODES[activeVehicle.camModeIndex].name}), T turret, Esc exit`
          : 'WASD or Arrows move, Q/Z altitude, drag look',
        'M map mode, R reset, H toggle HUD',
      ].join('<br>');

      altRef.current.textContent =
        `${altM.toFixed(0)}m / ${(altM * 3.28084).toFixed(0)}ft  ${deg.toFixed(0)}° ${compass}` +
        (controls.mapMode ? '  [MAP]' : activeVehicle?.controlActive ? '  [VEHICLE]' : '');
    };

    intervalRef.current = window.setInterval(update, 100);
    return () => clearInterval(intervalRef.current);
  }, []);

  return (
    <>
      <div
        ref={hudRef}
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          padding: '10px 12px',
          background: 'rgba(0,0,0,0.7)',
          color: '#dbe5f1',
          font: "13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
          borderRadius: 8,
          pointerEvents: 'none',
          zIndex: 5,
        }}
      />
      <div
        ref={altRef}
        style={{
          position: 'absolute',
          right: 12,
          bottom: 12,
          padding: '8px 10px',
          background: 'rgba(0,0,0,0.7)',
          color: '#8fd0ff',
          font: "13px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
          borderRadius: 6,
          pointerEvents: 'none',
          zIndex: 5,
        }}
      />
    </>
  );
}
