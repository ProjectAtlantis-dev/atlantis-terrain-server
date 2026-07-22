import { headingForward2D } from './terrain-priority.js';

export function terrainBboxIntersectsCircle(bbox, centerX, centerY, radius) {
  if (
    !Array.isArray(bbox)
    || bbox.length < 4
    || !Number.isFinite(centerX)
    || !Number.isFinite(centerY)
    || !Number.isFinite(radius)
    || radius < 0
  ) return false;
  const [x0, y0, x1, y1] = bbox.map(Number);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return false;
  const nearestX = Math.max(Math.min(x0, x1), Math.min(Math.max(x0, x1), centerX));
  const nearestY = Math.max(Math.min(y0, y1), Math.min(Math.max(y0, y1), centerY));
  const dx = centerX - nearestX;
  const dy = centerY - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}

export function vehicleLocalToLatLon(x, y, anchorLat, anchorLon) {
  return {
    lat: anchorLat + y / 111320,
    lon: anchorLon + x / (111320 * Math.cos(anchorLat * Math.PI / 180)),
  };
}

export function vehicleStateSnapshot({ loaded, position, headingRad, anchorLat, anchorLon }) {
  if (!loaded) return null;
  const latLon = vehicleLocalToLatLon(position.x, position.y, anchorLat, anchorLon);
  const headingDeg = ((headingRad * 180 / Math.PI) % 360 + 360) % 360;
  return {
    lat: Number(latLon.lat.toFixed(8)),
    lon: Number(latLon.lon.toFixed(8)),
    headingDeg: Number(headingDeg.toFixed(3)),
    z: Number(position.z.toFixed(3)),
  };
}

export function normalizeSavedVehicleState(state) {
  if (state == null || typeof state !== 'object') return null;
  const lat = Number(state.lat);
  const lon = Number(state.lon);
  const headingDeg = Number(state.headingDeg);
  const z = Number(state.z);
  const terrainDepthRaw = Number(state.terrainDepth);
  const terrainTileId = typeof state.terrainTileId === 'string' && state.terrainTileId.trim()
    ? state.terrainTileId.trim()
    : null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(headingDeg)) {
    return null;
  }
  return {
    lat,
    lon,
    headingDeg,
    z: Number.isFinite(z) ? z : null,
    terrainDepth: Number.isFinite(terrainDepthRaw)
      ? Math.max(0, Math.floor(terrainDepthRaw))
      : null,
    terrainTileId,
  };
}

export function createVehiclePersistenceRuntime({
  endpoint,
  timeoutMs,
  failureCooldownMs,
  throttleMs = 5000,
  trailingMs = 2000,
  createSnapshot,
  bootLog = () => {},
  fetchImpl = (...args) => fetch(...args),
  AbortControllerImpl = globalThis.AbortController,
  dateNow = () => Date.now(),
  performanceNow = () => performance.now(),
  setTimeoutImpl = (...args) => setTimeout(...args),
  clearTimeoutImpl = handle => clearTimeout(handle),
} = {}) {
  let trailingTimer = 0;
  let lastSaveAt = 0;
  let failureUntilMs = 0;
  let failureReported = false;

  async function save(reason = 'manual', options = {}) {
    if (failureUntilMs > dateNow()) return false;
    const state = createSnapshot(options);
    if (state == null) return false;
    try {
      const controller = typeof AbortControllerImpl === 'function'
        ? new AbortControllerImpl()
        : null;
      const timeoutHandle = controller != null
        ? setTimeoutImpl(() => controller.abort(), timeoutMs)
        : null;
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...state, reason }),
        signal: controller?.signal,
      }).finally(() => {
        if (timeoutHandle != null) clearTimeoutImpl(timeoutHandle);
      });
      if (!response.ok) {
        const responseText = await response.text().catch(() => '');
        const preview = responseText.slice(0, 180);
        throw new Error(
          `vehicle_state save status ${response.status}${preview ? ` body=${preview}` : ''}`,
        );
      }
      if (failureReported) bootLog('vehicle.state.save.recovered', {
        id: state.vehicleId ?? null,
        reason,
      });
      failureUntilMs = 0;
      failureReported = false;
      bootLog('vehicle.state.save.ok', {
        id: state.vehicleId ?? null,
        reason,
        vehicleType: state.vehicleType ?? null,
      });
      return true;
    } catch (error) {
      failureUntilMs = dateNow() + failureCooldownMs;
      if (!failureReported) {
        bootLog('vehicle.state.save.error', {
          id: state.vehicleId ?? null,
          reason,
          timeoutMs,
          timedOut: error?.name === 'AbortError',
          cooldownMs: failureCooldownMs,
          message: error?.message ?? String(error),
        }, 'error');
        failureReported = true;
      }
      return false;
    }
  }

  function throttledSave(reason = 'drive-throttle') {
    const now = performanceNow();
    if (now - lastSaveAt >= throttleMs) {
      lastSaveAt = now;
      save(reason);
    }
    clearTimeoutImpl(trailingTimer);
    trailingTimer = setTimeoutImpl(() => {
      lastSaveAt = performanceNow();
      save(`${reason}-trailing`);
    }, trailingMs);
  }

  return { save, throttledSave };
}

/** Pure vehicle drive integration shared by both renderer entry points. */
export function stepVehicleDrive({
  dt,
  heading,
  speed,
  steer,
  drive,
  groundNormalX,
  groundNormalY,
  acceleration,
  brake,
  steerSpeed,
  maxSpeed,
  slopeGravity = 6,
}) {
  const nextHeading = heading + steer * steerSpeed * dt;
  const forward = headingForward2D(nextHeading);
  const slopeForward = -(groundNormalX * forward.x + groundNormalY * forward.y);
  const slopeAcceleration = slopeForward * slopeGravity;
  let nextSpeed = speed;

  if (drive !== 0) {
    nextSpeed += (drive * acceleration + slopeAcceleration) * dt;
  } else {
    const friction = speed > 0 ? -brake : speed < 0 ? brake : 0;
    nextSpeed += (slopeAcceleration + friction) * dt;
    // Friction can stop motion but cannot reverse it; gravity may reverse it.
    if (speed > 0 && nextSpeed < 0 && slopeAcceleration >= 0) nextSpeed = 0;
    if (speed < 0 && nextSpeed > 0 && slopeAcceleration <= 0) nextSpeed = 0;
    if (speed === 0) nextSpeed = slopeAcceleration * dt;
  }

  nextSpeed = Math.max(-maxSpeed, Math.min(maxSpeed, nextSpeed));
  const distance = nextSpeed * dt;
  return {
    heading: nextHeading,
    speed: nextSpeed,
    deltaX: forward.x * distance,
    deltaY: forward.y * distance,
    slopeAcceleration,
  };
}

/** One critically/under-damped spring step for vertical suspension. */
export function stepSuspension({ dt, position, target, velocity, frequency, dampingRatio, maxVelocity }) {
  const stepDt = Math.min(0.05, Math.max(0.001, dt));
  const omega = 2 * Math.PI * frequency;
  const error = target - position;
  const acceleration = omega * omega * error - 2 * dampingRatio * omega * velocity;
  let nextVelocity = Math.max(-maxVelocity, Math.min(maxVelocity, velocity + acceleration * stepDt));
  let nextPosition = position + nextVelocity * stepDt;
  if (Math.abs(error) < 0.002 && Math.abs(nextVelocity) < 0.01) {
    nextPosition = target;
    nextVelocity = 0;
  }
  return { position: nextPosition, velocity: nextVelocity, stepDt };
}
