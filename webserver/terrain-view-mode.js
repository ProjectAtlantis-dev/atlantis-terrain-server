export function resolveTerrainViewToggle({ mapMode, tileInspectorActive, seamMode = false }, toggle) {
  if (toggle === 'inspector') {
    if (tileInspectorActive) {
      return { accepted: true, mapMode: false, tileInspectorActive: false, seamMode: false };
    }
    if (mapMode) {
      return { accepted: false, mapMode: true, tileInspectorActive: false, seamMode };
    }
    return { accepted: true, mapMode: true, tileInspectorActive: true, seamMode: false };
  }

  if (toggle === 'map') {
    if (tileInspectorActive) {
      return { accepted: false, mapMode: true, tileInspectorActive: true, seamMode: false };
    }
    if (seamMode) {
      return { accepted: true, mapMode: true, tileInspectorActive: false, seamMode: false };
    }
    return { accepted: true, mapMode: !mapMode, tileInspectorActive: false, seamMode: false };
  }

  if (toggle === 'seam') {
    if (tileInspectorActive) {
      return { accepted: false, mapMode: true, tileInspectorActive: true, seamMode: false };
    }
    if (seamMode) {
      return { accepted: true, mapMode: false, tileInspectorActive: false, seamMode: false };
    }
    return { accepted: true, mapMode: true, tileInspectorActive: false, seamMode: true };
  }

  throw new TypeError(`unsupported terrain view toggle: ${toggle}`);
}
