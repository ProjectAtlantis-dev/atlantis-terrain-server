import assert from 'node:assert/strict';
import test from 'node:test';
import { epsg3413ToWgs84 } from '../terrain-polar-stereo.js';
import {
  TILE_GRID_ROOT_BBOX,
  createTerrainFlyToTileRuntime,
  flyToLocationScenePosition,
  flyToTileScenePosition,
  parseTileId,
  tileBbox,
  tileMapZoom,
  tileViewAltitude,
} from '../terrain-fly-to-tile.js';

test('parseTileId accepts depth-col-row and rejects malformed ids', () => {
  assert.deepEqual(parseTileId('12-1461-786'), { depth: 12, col: 1461, row: 786, id: '12-1461-786' });
  assert.deepEqual(parseTileId(' 0-0-0 '), { depth: 0, col: 0, row: 0, id: '0-0-0' });
  assert.equal(parseTileId('12-1461'), null);
  assert.equal(parseTileId('12-1461-786-1'), null);
  assert.equal(parseTileId('12-4096-0'), null); // col out of range at depth 12
  assert.equal(parseTileId('12--1-0'), null);
  assert.equal(parseTileId('nuuk'), null);
  assert.equal(parseTileId(null), null);
});

// Reference values computed with flaskserver database._tile_bbox(12, 1461, 786)
// — the JS grid must stay bit-identical to the canonical Python grid.
test('tileBbox matches the flask tile grid', () => {
  assert.deepEqual(tileBbox({ depth: 0, col: 0, row: 0 }), [...TILE_GRID_ROOT_BBOX]);
  assert.deepEqual(
    tileBbox({ depth: 12, col: 1461, row: 786 }),
    [-275979.9765625, -2827962.265625, -275320.796875, -2827303.0859375],
  );
});

test('tile 12-1461-786 center converts to the expected WGS84 position', () => {
  const bbox = tileBbox(parseTileId('12-1461-786'));
  const { lat, lon } = epsg3413ToWgs84((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2);
  // pyproj reference: (64.2009011314113, -50.567857939762575)
  assert.ok(Math.abs(lat - 64.2009011314113) < 1e-5, `lat ${lat}`);
  assert.ok(Math.abs(lon - -50.567857939762575) < 1e-5, `lon ${lon}`);
});

test('flyToTileScenePosition inverts the grid mapping when the frame is ready', () => {
  const target = flyToTileScenePosition({
    bbox: [100, 200, 300, 400],
    frame: { frameOffsetReady: true, originX: 50, originY: 250, frameOffsetX: 7, frameOffsetY: -3 },
    anchorLat: 64.1835,
    anchorLon: -51.7216,
  });
  assert.deepEqual(target, { eastM: 200 - 50 + 7, northM: 300 - 250 - 3, sizeM: 200, usedFrame: true });
});

test('flyToTileScenePosition falls back to the linear lat/lon mapping before the first fetch', () => {
  const anchorLat = 64.1835;
  const anchorLon = -51.7216;
  const target = flyToTileScenePosition({
    bbox: [100, 200, 300, 400],
    frame: { frameOffsetReady: false },
    anchorLat,
    anchorLon,
    toWgs84: () => ({ lat: anchorLat + 1, lon: anchorLon + 2 }),
  });
  assert.equal(target.usedFrame, false);
  assert.ok(Math.abs(target.northM - 111320) < 1e-6);
  assert.ok(Math.abs(target.eastM - 2 * 111320 * Math.cos(anchorLat * Math.PI / 180)) < 1e-6);
});

test('flyToLocationScenePosition uses the established terrain grid frame', () => {
  const target = flyToLocationScenePosition({
    lat: 69.21981,
    lon: -51.09861,
    frame: { frameOffsetReady: true, originX: 100, originY: 200, frameOffsetX: 7, frameOffsetY: -3 },
    anchorLat: 64.1835,
    anchorLon: -51.7216,
    toGrid: () => ({ x: 1000, y: 2000 }),
  });
  assert.deepEqual(target, { eastM: 907, northM: 1797, usedFrame: true });
});

test('tileViewAltitude fits the tile in view and clamps extremes', () => {
  const d12Size = 659.1796875;
  const expected = (d12Size * 1.3) / (2 * Math.tan(Math.PI / 6));
  assert.ok(Math.abs(tileViewAltitude(d12Size, 60) - expected) < 1e-9);
  assert.equal(tileViewAltitude(10, 60), 250);     // deep tiles keep a sane minimum
  assert.equal(tileViewAltitude(660000, 60), 5500); // shallow tiles stay under the alt clamp
});

class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  clone() { return new Vec3(this.x, this.y, this.z); }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  distanceToSquared(v) {
    return (this.x - v.x) ** 2 + (this.y - v.y) ** 2 + (this.z - v.z) ** 2;
  }
}

function createRuntimeHarness({ raycastGroundAltitude = () => null, mapMode = false } = {}) {
  const calls = { exitVehicle: 0, requestFetch: 0, requestRender: 0, orient: 0, mapCamera: 0, logs: [] };
  const scheduled = [];
  const camera = { position: new Vec3(9000, 9000, 9000), fov: 60 };
  const controls = {
    yaw: 2, pitch: 0.5, bank: 0.3, bankVelocity: 0.1,
    lookYawOffset: Math.PI / 2,
    speed: 100, strafeSpeed: 50,
    mapMode, mapPanEast: 1500, mapPanNorth: -900, mapZoom: 20000,
  };
  const cameraRuntimeState = {
    agl: 8, aglValid: true, driftMode: true, forwardLockCoasting: true,
    lastGoodPosition: new Vec3(),
  };
  const runtime = createTerrainFlyToTileRuntime({
    camera,
    anchorPosition: new Vec3(0, 0, 0),
    east: new Vec3(1, 0, 0),
    north: new Vec3(0, 1, 0),
    up: new Vec3(0, 0, 1),
    controls,
    cameraRuntimeState,
    pipelineState: { frameOffsetReady: true, originX: 1000, originY: 2000, frameOffsetX: 10, frameOffsetY: 20 },
    anchorLat: 64.1835,
    anchorLon: -51.7216,
    exitVehicle: () => { calls.exitVehicle += 1; },
    applyCameraOrientation: () => { calls.orient += 1; },
    requestFetch: () => { calls.requestFetch += 1; },
    requestRender: () => { calls.requestRender += 1; },
    updateMapCamera: () => { calls.mapCamera += 1; },
    raycastGroundAltitude,
    enqueueLog: (level, event, details) => calls.logs.push({ level, event, details }),
    schedule: callback => { scheduled.push(callback); return scheduled.length; },
    cancel: () => {},
    now: () => 0,
  });
  const runNextPoll = () => scheduled.shift()();
  return { runtime, camera, controls, cameraRuntimeState, calls, scheduled, runNextPoll };
}

test('flyToTile centers the camera over the tile in grid space', () => {
  const { runtime, camera, controls, cameraRuntimeState, calls } = createRuntimeHarness();
  const result = runtime.flyToTile('12-1461-786');
  assert.equal(result.ok, true);
  const centerX = (result.bbox[0] + result.bbox[2]) / 2;
  const centerY = (result.bbox[1] + result.bbox[3]) / 2;
  assert.equal(camera.position.x, centerX - 1000 + 10);
  assert.equal(camera.position.y, centerY - 2000 + 20);
  assert.equal(camera.position.z, result.viewAlt);
  assert.equal(controls.yaw, 0);
  assert.equal(controls.pitch, -1.4);
  assert.equal(controls.bank, 0);
  assert.equal(controls.bankVelocity, 0);
  assert.equal(controls.lookYawOffset, 0);
  assert.equal(controls.speed, 0);
  assert.equal(cameraRuntimeState.driftMode, false);
  assert.equal(cameraRuntimeState.forwardLockCoasting, false);
  assert.equal(cameraRuntimeState.aglValid, false);
  assert.equal(cameraRuntimeState.lastGoodPosition.distanceToSquared(camera.position), 0);
  assert.equal(calls.exitVehicle, 1);
  assert.equal(calls.requestFetch, 1);
  assert.equal(calls.orient, 1);
  assert.ok(calls.requestRender >= 1);
});

test('flyToTile in map mode recenters and frames the tile', () => {
  const { runtime, controls, calls } = createRuntimeHarness({ mapMode: true });
  const result = runtime.flyToTile('12-1461-786');
  assert.equal(result.ok, true);
  assert.equal(controls.mapPanEast, 0);
  assert.equal(controls.mapPanNorth, 0);
  assert.equal(controls.mapZoom, tileMapZoom(659.1796875));
  assert.equal(calls.mapCamera, 1);
});

test('flyToTile outside map mode leaves the map pan and zoom alone', () => {
  const { runtime, controls, calls } = createRuntimeHarness();
  runtime.flyToTile('12-1461-786');
  assert.equal(controls.mapPanEast, 1500);
  assert.equal(controls.mapZoom, 20000);
  assert.equal(calls.mapCamera, 0);
});

test('flyToLocation transports the camera and starts terrain streaming', () => {
  const { runtime, camera, controls, calls } = createRuntimeHarness();
  const result = runtime.flyToLocation({ lat: 69.21981, lon: -51.09861, label: 'Ilulissat' });
  assert.equal(result.ok, true);
  assert.equal(result.label, 'Ilulissat');
  assert.equal(camera.position.z, 1200);
  assert.equal(controls.yaw, 0);
  assert.equal(controls.pitch, -1.4);
  assert.equal(controls.speed, 0);
  assert.equal(calls.exitVehicle, 1);
  assert.equal(calls.requestFetch, 1);
  assert.equal(calls.logs.at(-1).event, 'flyToLocation');
});

test('flyToLocation rejects invalid coordinates without moving', () => {
  const { runtime, camera, calls } = createRuntimeHarness();
  const result = runtime.flyToLocation({ lat: 100, lon: -51 });
  assert.equal(result.ok, false);
  assert.equal(camera.position.x, 9000);
  assert.equal(calls.requestFetch, 0);
});

test('tileMapZoom frames the tile and clamps to the wheel limits', () => {
  assert.equal(tileMapZoom(10000), 6500);
  assert.equal(tileMapZoom(100), 500);      // deep tiles stop at max zoom-in
  assert.equal(tileMapZoom(700000), 40000); // root tiles stop at max zoom-out
});

test('flyToTile rejects a bad tile id without touching the camera', () => {
  const { runtime, camera, calls } = createRuntimeHarness();
  const result = runtime.flyToTile('not-a-tile');
  assert.equal(result.ok, false);
  assert.equal(camera.position.x, 9000);
  assert.equal(calls.requestFetch, 0);
});

test('ground correction lifts the camera once terrain streams in', () => {
  let groundAlt = null;
  const { runtime, camera, runNextPoll, scheduled } =
    createRuntimeHarness({ raycastGroundAltitude: () => groundAlt });
  const result = runtime.flyToTile('12-1461-786');
  runNextPoll(); // no terrain yet — reschedules
  assert.equal(scheduled.length, 1);
  groundAlt = 2400; // ice sheet surface appears
  runNextPoll();
  assert.equal(camera.position.z, 2400 + result.viewAlt);
  assert.equal(scheduled.length, 0); // correction applied once, polling stops
});

test('ground correction stands down after the user flies away', () => {
  const { runtime, camera, runNextPoll, scheduled } =
    createRuntimeHarness({ raycastGroundAltitude: () => 2400 });
  const result = runtime.flyToTile('12-1461-786');
  camera.position.x += 100; // user took over
  runNextPoll();
  assert.equal(camera.position.z, result.viewAlt); // unchanged
  assert.equal(scheduled.length, 0);
});

test('T key clears its pressed state and asks for a tile', async () => {
  const previousWindow = globalThis.window;
  const listeners = new Map();
  globalThis.window = {
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type) { listeners.delete(type); },
  };
  try {
    const { installTerrainKeyboardControls } = await import('../terrain-controls.js');
    const controls = { keys: {} };
    let flyRequests = 0;
    const dispose = installTerrainKeyboardControls({
      controls,
      isVehicleActive: () => false,
      onForwardLockChange: () => {},
      onEscapeVehicle: () => {},
      onToggleMap: () => {},
      onFlyToTile: () => { flyRequests += 1; },
      onReset: () => {},
      onToggleHeadlights: () => {},
    });
    listeners.get('keydown')({ code: 'KeyT', repeat: false });
    assert.equal(flyRequests, 1);
    assert.equal(controls.keys.KeyT, false);
    dispose();
  } finally {
    globalThis.window = previousWindow;
  }
});
