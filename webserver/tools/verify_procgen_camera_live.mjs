import { writeFile } from 'node:fs/promises';

const browserUrl = process.argv[2]
  ?? 'http://127.0.0.1:5173/webgpu.html?camLat=64.18852&camLon=-51.68211&camAlt=92&vehiclePersistence=0';
const cdpBase = process.argv[3] ?? 'http://127.0.0.1:9223';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const target = await fetch(
  `${cdpBase}/json/new?${encodeURIComponent(browserUrl)}`,
  { method: 'PUT' },
).then(response => {
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
    browserErrors.push(
      message.params.exceptionDetails?.exception?.description
      ?? message.params.exceptionDetails?.text
      ?? 'runtime exception',
    );
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

async function waitFor(expression, timeoutMs = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(expression).catch(() => false)) return;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

const snapshotExpression = `(() => {
  const patch = window.__atlantisWebGPU?.greenlandPatch;
  const ground = patch?.ground?.counterSnapshot?.() ?? {};
  const forest = patch?.forests?.counterSnapshot?.() ?? {};
  const terrain = window.takramDebug?.terrainRoot;
  const depths = {};
  let procgenMaterials = 0;
  for (const child of terrain?.children ?? []) {
    const depth = child.userData?.scatterInput?.tileId?.split('-')?.[0];
    if (depth != null) depths[depth] = (depths[depth] ?? 0) + 1;
    if (child.userData?.procgenTerrainMaterial) procgenMaterials++;
  }
  return {
    ready: patch?.ready ?? false,
    visible: patch?.vegRoot?.visible ?? false,
    center: patch?.centerId ?? null,
    grass: ground['veg.grass'] ?? -1,
    plantsDrawn: forest['veg.underDrawn'] ?? -1,
    rocksDrawn: forest['veg.extraDrawn'] ?? -1,
    groundCullSubmits: ground['veg.groundCullSubmits'] ?? -1,
    forestCullSubmits: forest['veg.forestCullSubmits'] ?? -1,
    plantCandidates: patch?.scatter?.understory?.count ?? -1,
    rockCandidates: (patch?.scatter?.extras?.count ?? 0) + (patch?.scatter?.stones?.count ?? 0),
    procgenMaterials,
    terrainDepths: depths,
  };
})()`;

async function dragYaw(movementX) {
  await evaluate(`(() => {
    const canvas = document.querySelector('canvas');
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    window.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      movementX: ${movementX},
      movementY: 0,
    }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  })()`);
  await sleep(2500);
}

async function sampleGpuCounters() {
  await evaluate(`document.querySelector('canvas').dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, button: 0 })
  )`);
  // Counter readback is intentionally throttled to every 90 rendered frames.
  // Holding the drag state keeps the demand-driven loop alive without moving.
  await sleep(4000);
  await evaluate(`window.dispatchEvent(
    new MouseEvent('mouseup', { bubbles: true, button: 0 })
  )`);
  await sleep(500);
}

async function capture(path) {
  const screenshot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  await writeFile(path, Buffer.from(screenshot.data, 'base64'));
}

await send('Runtime.enable');
await send('Page.enable');
await waitFor(`window.__atlantisWebGPU?.greenlandPatch?.ready === true`);
for (let attempt = 0; attempt < 5; attempt++) {
  await sampleGpuCounters();
  const countersReady = await evaluate(`(() => {
    const forest = window.__atlantisWebGPU?.greenlandPatch?.forests?.counterSnapshot?.() ?? {};
    return (forest['veg.underDrawn'] ?? -1) >= 0
      && (forest['veg.extraDrawn'] ?? -1) >= 0;
  })()`);
  if (countersReady) break;
}
await waitFor(`(() => {
  const patch = window.__atlantisWebGPU?.greenlandPatch;
  const ground = patch?.ground?.counterSnapshot?.() ?? {};
  const forest = patch?.forests?.counterSnapshot?.() ?? {};
  return (ground['veg.grass'] ?? -1) >= 0
    && (forest['veg.underDrawn'] ?? -1) >= 0
    && (forest['veg.extraDrawn'] ?? -1) >= 0;
})()`, 180_000);

const before = await evaluate(snapshotExpression);
await capture('/tmp/atlantis-procgen-before.png');
await dragYaw(1000);
const away = await evaluate(snapshotExpression);
await capture('/tmp/atlantis-procgen-away.png');
await dragYaw(-1000);
await sampleGpuCounters();
const restored = await evaluate(snapshotExpression);
await capture('/tmp/atlantis-procgen-restored.png');

const stable = before.visible
  && restored.visible
  && before.center === restored.center
  && before.grass >= 0
  && before.plantsDrawn >= 0
  && before.rocksDrawn >= 0
  && before.grass === restored.grass
  && before.grass === away.grass
  && before.plantsDrawn === restored.plantsDrawn
  && before.plantsDrawn === away.plantsDrawn
  && before.rocksDrawn === restored.rocksDrawn
  && before.rocksDrawn === away.rocksDrawn
  && before.groundCullSubmits === away.groundCullSubmits
  && before.groundCullSubmits === restored.groundCullSubmits
  && before.forestCullSubmits === away.forestCullSubmits
  && before.forestCullSubmits === restored.forestCullSubmits;

console.log(JSON.stringify({ stable, before, away, restored, browserErrors }, null, 2));
await send('Page.close');
socket.close();
if (!stable || browserErrors.length) process.exitCode = 1;
