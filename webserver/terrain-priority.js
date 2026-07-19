/** Renderer-neutral terrain/texture priority helpers. */

export function priorityHeading(vehicleActive, vehicleHeading, cameraYaw) {
  return vehicleActive ? vehicleHeading : cameraYaw;
}

export function viewHeadingChanged(previous, next, threshold = 0) {
  if (!Number.isFinite(previous) || !Number.isFinite(next)) return false;
  const delta = Math.abs(Math.atan2(
    Math.sin(next - previous),
    Math.cos(next - previous),
  ));
  return delta > Math.max(0, threshold);
}

/** Heading 0 is north (+Y); positive heading turns west (-X). */
export function headingForward2D(heading) {
  return { x: -Math.sin(heading), y: Math.cos(heading) };
}

export function headingFromForward2D(east, north, fallback = 0) {
  if (!Number.isFinite(east) || !Number.isFinite(north)) return fallback;
  if (Math.hypot(east, north) < 1e-9) return fallback;
  const heading = Math.atan2(-east, north);
  return Object.is(heading, -0) ? 0 : heading;
}

/** Distance in a view-aligned oval: forward ground is compressed so its
 * priority bands reach farther, while lateral and rear distances are kept. */
export function headingAlignedPriorityDistance(
  dx,
  dy,
  heading,
  forwardScale = 2,
) {
  const forward = headingForward2D(heading);
  const along = dx * forward.x + dy * forward.y;
  const across = dx * forward.y - dy * forward.x;
  const scaledAlong = along > 0 ? along / Math.max(1, forwardScale) : along;
  return Math.hypot(across, scaledAlong);
}

export function horizontalFrustumDotMin(fovDeg, aspect, margin = 0.8) {
  const verticalHalfFov = fovDeg * Math.PI / 360;
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * aspect);
  return Math.cos(horizontalHalfFov) * margin;
}

export function terrainTilePriority(tile, {
  cameraX,
  cameraY,
  heading,
  pitch = 0,
  usePitch = true,
  fovDeg,
  aspect,
  nearDistance = 2000,
  forwardScale = 2,
}) {
  const tcx = (tile.bbox[0] + tile.bbox[2]) * 0.5;
  const tcy = (tile.bbox[1] + tile.bbox[3]) * 0.5;
  const dx = tcx - cameraX;
  const dy = tcy - cameraY;
  const dist = Math.hypot(dx, dy);
  if (dist <= 0) return 0;

  const forward = headingForward2D(heading);
  const priorityDistance = headingAlignedPriorityDistance(
    dx, dy, heading, forwardScale,
  );
  if (dist < nearDistance) return Math.log(Math.max(priorityDistance, 1));
  const pitchScale = usePitch ? Math.cos(pitch) : 1;
  const dot = (dx * forward.x + dy * forward.y) / dist * pitchScale;
  const dotMin = horizontalFrustumDotMin(fovDeg, aspect);
  return Math.log(Math.max(priorityDistance / Math.max(dot, dotMin), 1));
}
