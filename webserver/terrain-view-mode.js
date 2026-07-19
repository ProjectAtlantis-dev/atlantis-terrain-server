export function resolveTerrainViewToggle({ mapMode, heatmapActive }, toggle) {
  if (toggle === 'heatmap') {
    if (heatmapActive) {
      return { accepted: true, mapMode: false, heatmapActive: false };
    }
    if (mapMode) {
      return { accepted: false, mapMode: true, heatmapActive: false };
    }
    return { accepted: true, mapMode: true, heatmapActive: true };
  }

  if (toggle === 'map') {
    if (heatmapActive) {
      return { accepted: false, mapMode: true, heatmapActive: true };
    }
    return { accepted: true, mapMode: !mapMode, heatmapActive: false };
  }

  throw new TypeError(`unsupported terrain view toggle: ${toggle}`);
}
