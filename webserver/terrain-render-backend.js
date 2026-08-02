export const TERRAIN_RENDER_BACKEND_STORAGE_KEY = 'terrain-render-backend';

// The WebGPU backend is incomplete: only WebGL renders correctly today. Keep the
// backend code and its selection plumbing intact, but refuse to hand it out so a
// stale localStorage preference cannot strand the app on a broken renderer. Flip
// this to true to re-enable the toggle once WebGPU works.
export const WEBGPU_BACKEND_ENABLED = false;

export function resolveTerrainRenderBackend(
  storedBackend,
  webgpuAvailable,
  webgpuEnabled = WEBGPU_BACKEND_ENABLED,
) {
  return storedBackend === 'webgpu' && webgpuAvailable && webgpuEnabled
    ? 'webgpu'
    : 'webgl';
}

export function alternateTerrainRenderBackend(activeBackend) {
  return activeBackend === 'webgpu' ? 'webgl' : 'webgpu';
}
