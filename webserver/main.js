import { startTerrainApplication } from './terrain-application.js';
import {
  alternateTerrainRenderBackend,
  resolveTerrainRenderBackend,
  TERRAIN_RENDER_BACKEND_STORAGE_KEY,
  WEBGPU_BACKEND_ENABLED,
} from './terrain-render-backend.js';

const webgpuAvailable = Boolean(navigator.gpu);
const storedBackend = localStorage.getItem(TERRAIN_RENDER_BACKEND_STORAGE_KEY);
const backend = resolveTerrainRenderBackend(storedBackend, webgpuAvailable);

if (storedBackend === 'webgpu' && backend !== 'webgpu') {
  localStorage.setItem(TERRAIN_RENDER_BACKEND_STORAGE_KEY, backend);
}

await startTerrainApplication({
  backend,
  onToggleRenderBackend() {
    const nextBackend = alternateTerrainRenderBackend(backend);
    if (nextBackend === 'webgpu' && !WEBGPU_BACKEND_ENABLED) {
      return;
    }
    if (nextBackend === 'webgpu' && !webgpuAvailable) {
      window.alert('WebGPU is not available in this browser.');
      return;
    }
    localStorage.setItem(TERRAIN_RENDER_BACKEND_STORAGE_KEY, nextBackend);
    window.location.reload();
  },
});
