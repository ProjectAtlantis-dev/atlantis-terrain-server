export const ATMOSPHERE_VISIBILITY_SAMPLES = 8;

export function configureSunDepthCamera(camera, {
  center,
  sunDirection,
  up,
  span,
  rayStart,
  rayLength,
} = {}) {
  const halfSpan = span * 0.5;
  camera.left = -halfSpan;
  camera.right = halfSpan;
  camera.top = halfSpan;
  camera.bottom = -halfSpan;
  camera.near = 0;
  camera.far = rayLength;
  camera.position.copy(center).addScaledVector(sunDirection, rayStart);
  camera.up.copy(up);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}
