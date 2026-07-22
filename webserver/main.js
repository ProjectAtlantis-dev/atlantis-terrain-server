import { startTerrainApplication } from './terrain-application.js';
import {
  alternateTerrainRenderBackend,
  resolveTerrainRenderBackend,
  TERRAIN_RENDER_BACKEND_STORAGE_KEY,
} from './terrain-render-backend.js';

const webgpuAvailable = Boolean(navigator.gpu);
const storedBackend = localStorage.getItem(TERRAIN_RENDER_BACKEND_STORAGE_KEY);
const explicitBackend = window.location.pathname.endsWith('/webgpu.html')
  ? 'webgpu'
  : window.location.pathname.endsWith('/webgl.html')
    ? 'webgl'
    : null;
const backend = resolveTerrainRenderBackend(
  explicitBackend ?? storedBackend,
  webgpuAvailable,
);

if ((explicitBackend ?? storedBackend) === 'webgpu' && backend !== 'webgpu') {
  localStorage.setItem(TERRAIN_RENDER_BACKEND_STORAGE_KEY, backend);
}

function reportBootstrapFailure(error) {
  const entry = {
    ts: new Date().toISOString(),
    level: 'error',
    phase: 'renderer.bootstrap.error',
    details: {
      backend,
      explicitBackend,
      webgpuAvailable,
      message: error?.message ?? String(error),
      stack: error?.stack ?? null,
    },
  };
  return fetch('/api/client_log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sceneMode: 'terrain-bootstrap',
      entries: [entry],
    }),
    keepalive: true,
  }).catch(() => {});
}

try {
  await startTerrainApplication({
    backend,
    onToggleRenderBackend() {
      const nextBackend = alternateTerrainRenderBackend(backend);
      if (nextBackend === 'webgpu' && !webgpuAvailable) {
        window.alert('WebGPU is not available in this browser.');
        return;
      }
      localStorage.setItem(TERRAIN_RENDER_BACKEND_STORAGE_KEY, nextBackend);
      window.location.assign(nextBackend === 'webgpu' ? '/webgpu.html' : '/webgl.html');
    },
  });
} catch (error) {
  console.error('[TERRAIN BOOTSTRAP]', error);
  await reportBootstrapFailure(error);
  throw error;
}
