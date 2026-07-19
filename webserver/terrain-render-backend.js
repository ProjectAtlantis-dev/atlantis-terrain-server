export const TERRAIN_RENDER_BACKEND_STORAGE_KEY = 'terrain-render-backend';

export function resolveTerrainRenderBackend(storedBackend, webgpuAvailable) {
  return storedBackend === 'webgpu' && webgpuAvailable ? 'webgpu' : 'webgl';
}

export function alternateTerrainRenderBackend(activeBackend) {
  return activeBackend === 'webgpu' ? 'webgl' : 'webgpu';
}
