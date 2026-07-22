/**
 * Boot-time query flags that survive the host's URL cleanup.
 *
 * The WebGPU host (main.webgpu.terrain.js) captures its query string into
 * window.__BOOT_QUERY and then STRIPS it from the visible URL via
 * history.replaceState — procedural modules load lazily after that, so any direct
 * window.location.search read sees an empty string and every ?ablate=/debug
 * flag silently no-ops. Standalone use (no host) falls back to the live URL.
 *
 * Always read flags through this helper, never location.search directly.
 */
export function bootQuery(): URLSearchParams {
  const hosted = (window as { __BOOT_QUERY?: URLSearchParams }).__BOOT_QUERY;
  return hosted ?? new URLSearchParams(window.location.search);
}
