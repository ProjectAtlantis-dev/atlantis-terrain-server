const MIN_ZOOM = 0.5;
const MAX_ZOOM = 64;

export function createCoverageView(bounds, width, height, navigation, margin = 55) {
  const availableWidth = Math.max(1, width - margin * 2);
  const availableHeight = Math.max(1, height - margin * 2);
  const baseScale = Math.min(
    availableWidth / (bounds.xMax - bounds.xMin),
    availableHeight / (bounds.yMax - bounds.yMin),
  );
  const scale = baseScale * navigation.zoom;
  const gridCenterX = (bounds.xMin + bounds.xMax) / 2;
  const gridCenterY = (bounds.yMin + bounds.yMax) / 2;
  const screenCenterX = width / 2 + navigation.panX;
  const screenCenterY = height / 2 + navigation.panY;
  return {
    scale,
    x: value => screenCenterX + (value - gridCenterX) * scale,
    y: value => screenCenterY - (value - gridCenterY) * scale,
    gridX: value => gridCenterX + (value - screenCenterX) / scale,
    gridY: value => gridCenterY - (value - screenCenterY) / scale,
  };
}

export function panCoverageNavigation(navigation, deltaX, deltaY) {
  return {
    ...navigation,
    panX: navigation.panX + deltaX,
    panY: navigation.panY + deltaY,
  };
}

export function zoomCoverageNavigation({
  bounds,
  width,
  height,
  navigation,
  screenX,
  screenY,
  factor,
}) {
  const currentView = createCoverageView(bounds, width, height, navigation);
  const anchorX = currentView.gridX(screenX);
  const anchorY = currentView.gridY(screenY);
  const next = {
    ...navigation,
    zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, navigation.zoom * factor)),
  };
  const zoomedView = createCoverageView(bounds, width, height, next);
  next.panX += screenX - zoomedView.x(anchorX);
  next.panY += screenY - zoomedView.y(anchorY);
  return next;
}
