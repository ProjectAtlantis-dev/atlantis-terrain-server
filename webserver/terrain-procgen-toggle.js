export const DEFAULT_PROCGEN_ENABLED = false;

export function procgenHudLine(enabled, available = true) {
  if (!available) {
    return 'procgen: <span title="Procedural tundra clutter requires WebGL" style="color:#888">n/a</span>';
  }
  return enabled
    ? 'procgen: <span id="procgenLink" title="Disable procedural tundra clutter" style="color:#8f8;text-decoration:underline;cursor:pointer;pointer-events:auto">ON</span>'
    : 'procgen: <span id="procgenLink" title="Enable procedural tundra clutter" style="color:#0af;text-decoration:underline;cursor:pointer;pointer-events:auto">off</span>';
}
