export function resolveTerrainViewToggle({ mapMode, heatmapActive, seamMode = false }, toggle) {
  if (toggle === 'heatmap') {
    if (heatmapActive) {
      return { accepted: true, mapMode: false, heatmapActive: false, seamMode: false };
    }
    if (mapMode) {
      return { accepted: false, mapMode: true, heatmapActive: false, seamMode };
    }
    return { accepted: true, mapMode: true, heatmapActive: true, seamMode: false };
  }

  if (toggle === 'map') {
    if (heatmapActive) {
      return { accepted: false, mapMode: true, heatmapActive: true, seamMode: false };
    }
    if (seamMode) {
      return { accepted: true, mapMode: true, heatmapActive: false, seamMode: false };
    }
    return { accepted: true, mapMode: !mapMode, heatmapActive: false, seamMode: false };
  }

  if (toggle === 'seam') {
    if (heatmapActive) {
      return { accepted: false, mapMode: true, heatmapActive: true, seamMode: false };
    }
    if (seamMode) {
      return { accepted: true, mapMode: false, heatmapActive: false, seamMode: false };
    }
    return { accepted: true, mapMode: true, heatmapActive: false, seamMode: true };
  }

  throw new TypeError(`unsupported terrain view toggle: ${toggle}`);
}
