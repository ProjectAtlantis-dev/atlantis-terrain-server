import { writeFile } from 'node:fs/promises';

const requestedUrl = new URL(process.argv[2] ?? 'http://127.0.0.1:5173/webgpu.html');
// Acceptance drives real gameplay, but it must never move persisted user vehicles.
requestedUrl.searchParams.set('vehiclePersistence', '0');
const browserUrl = requestedUrl.href;
const cdpBase = process.argv[3] ?? 'http://127.0.0.1:9223';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const target = await fetch(`${cdpBase}/json/new?${encodeURIComponent(browserUrl)}`, {
  method: 'PUT',
}).then(response => {
  if (!response.ok) throw new Error(`CDP target creation failed: ${response.status}`);
  return response.json();
});

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let requestId = 0;
const pending = new Map();
const browserErrors = [];
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.id != null) {
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    }
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    browserErrors.push(message.params.exceptionDetails?.exception?.description
      ?? message.params.exceptionDetails?.text ?? 'runtime exception');
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    browserErrors.push(message.params.args.map(argument => argument.value ?? argument.description).join(' '));
  }
});

function send(method, params = {}) {
  const id = ++requestId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}

async function waitFor(expression, timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(expression).catch(() => false)) return true;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

await send('Runtime.enable');
await send('Page.enable');
await waitFor(`Boolean(window.takramDebug?.getVehicleRegistry?.().every(entry => entry.loaded))`);

const initial = await evaluate(`(() => ({
  registry: window.takramDebug.getVehicleRegistry(),
  bootErrors: window.takramDebug.getBootEvents().filter(event => event.level === 'error'),
  materials: (() => {
    const found = [];
    window.takramDebug.terrainRoot.traverse(object => {
      if (!object.isMesh) return;
      for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
        if (material?.name === 'DefaultWhite' || material?.name === 'Transparent') {
          found.push({
            material: material.name,
            map: material.map?.name ?? null,
            normal: material.normalMap?.name ?? null,
            roughness: material.roughnessMap?.name ?? null,
            metallic: material.metalnessMap?.name ?? null,
          });
        }
      }
    });
    return found;
  })(),
}))()`);
if (initial.registry.some(entry => entry.loaded && (!entry.visible || entry.meshCount === 0))) {
  throw new Error(`Loaded vehicle is not physically visible: ${JSON.stringify(initial.registry)}`);
}

await evaluate(`window.takramDebug.selectVehicle('osprey-01'); window.takramDebug.setVehicleControlActive(true)`);
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE' })); window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE' }))`);
await sleep(4500);
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' })); window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }))`);
await sleep(3500);
await evaluate(`window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' })); window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }))`);
const aircraftAfterInput = await evaluate(`window.takramDebug.getVehicleRegistry().find(entry => entry.id === 'osprey-01')`);

await evaluate(`window.takramDebug.setVehicleControlActive(false)`);
await sleep(500);
const beforeR = await evaluate(`window.takramDebug.getRenderedTerrainLatLon()`);
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' })); window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR' }))`);
await sleep(250);
const afterR = await evaluate(`window.takramDebug.getRenderedTerrainLatLon()`);

await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG' })); window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyG' }))`);
const googlePanel = await evaluate(`(() => {
  const panel = document.querySelector('[data-terrain-google-navigator]');
  return { exists: Boolean(panel), display: panel?.style.display ?? null };
})()`);

await evaluate(`window.takramDebug.selectVehicle('amv-01'); window.takramDebug.setVehicleControlActive(true); window.takramDebug.setVehicleTurretControlActive(true)`);
await evaluate(`window.takramDebug.setVehicleFireHeld(true); window.takramDebug.setVehicleFireHeld(false)`);
const firing = await evaluate(`window.takramDebug.getVehicleFireSummary()`);
const physicalVisibility = await evaluate(`window.takramDebug.getVehicleRegistry().map(entry => ({
  id: entry.id, loaded: entry.loaded, visible: entry.visible, meshCount: entry.meshCount,
}))`);

await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM' })); window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyM' }))`);
await sleep(2500);
const mapMarkers = await evaluate(`(() => {
  const layer = window.takramDebug.terrainRoot.getObjectByName('vehicle-markers');
  return { visible: layer?.visible ?? false, names: layer?.children.map(child => child.name) ?? [] };
})()`);

const vehiclePanel = await evaluate(`(() => {
  const panel = document.getElementById('vehicle-control-panel');
  return { exists: Boolean(panel), buttons: panel?.querySelectorAll('button').length ?? -1, text: panel?.textContent ?? '' };
})()`);

const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await writeFile('/private/tmp/vehicle-webgpu-live.png', Buffer.from(screenshot.data, 'base64'));

console.log(JSON.stringify({
  url: target.url,
  initial,
  aircraftAfterInput,
  bareRPreservedPosition: Math.abs(beforeR.lat - afterR.lat) < 1e-10
    && Math.abs(beforeR.lon - afterR.lon) < 1e-10,
  googlePanel,
  firing,
  physicalVisibility,
  mapMarkers,
  vehiclePanel,
  browserErrors,
}, null, 2));

await send('Page.close').catch(() => {});
socket.close();
