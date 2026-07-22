import * as THREE from 'three';

export const AIRCRAFT_CAMERA_MODES = Object.freeze([
  Object.freeze({ name: 'CLOSE', dist: 25, height: 10 }),
  Object.freeze({ name: 'MEDIUM', dist: 40, height: 15 }),
  Object.freeze({ name: 'FAR', dist: 60, height: 22 }),
]);

const FLIGHT_DEFAULTS = Object.freeze({
  maxSpeedMs: 141,
  hoverMaxSpeedMs: 30,
  transitionLowMs: 30,
  transitionHighMs: 50,
  climbRateMs: 15,
  descendRateMs: 10,
  accelMs2: 15,
  yawRateRad: 1.05,
  pitchRateRad: 0.52,
  rollRateRad: 0.78,
});
const GRAVITY_MS2 = 9.8;
const HOVER_NACELLE_DEG = 97.5;
const LOCAL_UP = new THREE.Vector3(0, 0, 1);
const VISUAL_QUATERNION = new THREE.Quaternion();
const VISUAL_AXIS = new THREE.Vector3();
const VISUAL_ROTATION = new THREE.Quaternion();

function configValue(config, key, defaults) {
  return Number.isFinite(config?.[key]) ? config[key] : defaults[key];
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function nominalRotorVelocity(state) {
  const rotorSpeedRpm = Number.isFinite(state.definition.nacelles?.rotorSpeedRpm)
    ? state.definition.nacelles.rotorSpeedRpm
    : 397;
  return rotorSpeedRpm * Math.PI * 2 / 60;
}

export function aircraftRotorSpool(state) {
  return clamp01(state.rotorAngularVelocity / Math.max(0.001, nominalRotorVelocity(state)));
}

export function setAircraftEngineRunning(state, running) {
  state.engineRunning = Boolean(running);
  if (!state.engineRunning) {
    state.nacelleTiltTarget = HOVER_NACELLE_DEG;
  }
  return state.engineRunning;
}

export function toggleAircraftEngine(state) {
  return setAircraftEngineRunning(state, !state.engineRunning);
}

export function createAircraftState({ id, definition, instance, group, marker }) {
  return {
    id,
    definition,
    vehicleType: 'aircraft',
    instance,
    group,
    marker,
    meshes: [],
    loaded: false,
    controlActive: false,
    engineRunning: false,
    headingRad: THREE.MathUtils.degToRad(Number(instance.headingDeg) || 0),
    forwardSpeedMs: 0,
    verticalSpeedMs: 0,
    altitudeAGL: 0,
    rotorSpool: 0,
    flightRegime: 'GROUND',
    pitchRad: 0,
    rollRad: 0,
    nacelleTiltDeg: HOVER_NACELLE_DEG,
    nacelleTiltTarget: HOVER_NACELLE_DEG,
    leftNacellePivot: null,
    rightNacellePivot: null,
    leftRotorMesh: null,
    rightRotorMesh: null,
    rotorSpinAngle: 0,
    rotorAngularVelocity: 0,
    cameraModeIndex: 1,
    cameraZoom: 1,
    cameraOrbitYaw: 0,
    cameraOrbitPitch: Math.atan2(
      AIRCRAFT_CAMERA_MODES[1].height,
      AIRCRAFT_CAMERA_MODES[1].dist,
    ),
    lastKnownGroundZ: null,
    lastSaveAt: -Infinity,
    saveFailureUntil: 0,
    saveFailureReported: false,
  };
}

export function stepAircraftFlight(state, input, dt, groundZ = null) {
  const flight = state.definition.flight;
  const hoverMax = configValue(flight, 'hoverMaxSpeedMs', FLIGHT_DEFAULTS);
  const climbRate = configValue(flight, 'climbRateMs', FLIGHT_DEFAULTS);
  const descendRate = configValue(flight, 'descendRateMs', FLIGHT_DEFAULTS);
  const accel = configValue(flight, 'accelMs2', FLIGHT_DEFAULTS);
  const yawRate = configValue(flight, 'yawRateRad', FLIGHT_DEFAULTS);
  const maxSpeed = Math.max(hoverMax, configValue(flight, 'maxSpeedMs', FLIGHT_DEFAULTS));
  const transitionLow = configValue(flight, 'transitionLowMs', FLIGHT_DEFAULTS);
  const transitionHigh = Math.max(
    transitionLow + 0.001,
    configValue(flight, 'transitionHighMs', FLIGHT_DEFAULTS),
  );
  const yawInput = (input.left ? 1 : 0) + (input.right ? -1 : 0);
  if (Number.isFinite(groundZ)) state.lastKnownGroundZ = groundZ;
  const floorZ = (state.lastKnownGroundZ ?? 0) + Math.max(0.5, Number(state.definition.altOffsetM) || 0);
  const step = Math.max(0, Number(dt) || 0);

  if (!state.engineRunning) {
    state.forwardSpeedMs *= Math.max(0, 1 - 0.5 * step);
    if (state.group.position.z > floorZ + 1) state.verticalSpeedMs -= GRAVITY_MS2 * step;
    else state.verticalSpeedMs = Math.min(state.verticalSpeedMs, 0);
    state.pitchRad *= Math.max(0, 1 - 2 * step);
    state.rollRad *= Math.max(0, 1 - 2 * step);
    state.nacelleTiltTarget = HOVER_NACELLE_DEG;
  } else {
    state.headingRad += yawInput * yawRate * step;
    if (input.climb) {
      state.verticalSpeedMs = Math.min(climbRate, state.verticalSpeedMs + climbRate * 2 * step);
    } else if (input.descend) {
      state.verticalSpeedMs = Math.max(-descendRate, state.verticalSpeedMs - descendRate * 2 * step);
    } else {
      state.verticalSpeedMs *= Math.max(0, 1 - 3 * step);
    }
    if (input.forward) {
      // Forward acceleration is allowed through the conversion band. Nacelles
      // schedule automatically from airspeed, so clamping at hoverMax would make
      // the configured 30–50 m/s transition physically unreachable.
      state.forwardSpeedMs = Math.min(maxSpeed, state.forwardSpeedMs + accel * step);
    } else if (input.back) {
      state.forwardSpeedMs = Math.max(-hoverMax * 0.3, state.forwardSpeedMs - accel * 1.5 * step);
    } else {
      state.forwardSpeedMs *= Math.max(0, 1 - 0.8 * step);
    }

    const speedRatio = state.forwardSpeedMs / Math.max(1, hoverMax);
    const climbRatio = state.verticalSpeedMs / Math.max(1, climbRate);
    const targetPitch = -speedRatio * 0.35 + climbRatio * 0.15;
    state.pitchRad += (targetPitch - state.pitchRad) * Math.min(1, 3 * step);
    const speedFactor = Math.min(1, Math.abs(state.forwardSpeedMs) / Math.max(1, hoverMax * 0.5));
    const targetRoll = -yawInput * 0.5 * (0.3 + 0.7 * speedFactor);
    state.rollRad += (targetRoll - state.rollRad) * Math.min(1, 3 * step);

    const speed = Math.abs(state.forwardSpeedMs);
    state.nacelleTiltTarget = speed <= transitionLow ? HOVER_NACELLE_DEG : speed >= transitionHigh
      ? 0
      : HOVER_NACELLE_DEG * (1 - (speed - transitionLow) / (transitionHigh - transitionLow));
  }

  state.group.position.x += -Math.sin(state.headingRad) * state.forwardSpeedMs * step;
  state.group.position.y += Math.cos(state.headingRad) * state.forwardSpeedMs * step;
  state.group.position.z += state.verticalSpeedMs * step;
  if (state.group.position.z < floorZ) {
    state.group.position.z = floorZ;
    if (state.verticalSpeedMs < 0) state.verticalSpeedMs = 0;
  }

  state.altitudeAGL = state.group.position.z - (state.lastKnownGroundZ ?? 0);
  const grounded = state.group.position.z <= floorZ + 0.05;
  const conversion = 1 - Math.sin(THREE.MathUtils.degToRad(Math.min(90, state.nacelleTiltDeg)));
  state.flightRegime = grounded
    ? 'GROUND'
    : conversion < 0.12 && Math.abs(state.forwardSpeedMs) < transitionLow
      ? 'HOVER'
      : conversion > 0.78 && Math.abs(state.forwardSpeedMs) >= transitionLow
        ? 'AIRPLANE'
        : 'TRANSITION';
  state.marker?.position.set(state.group.position.x, state.group.position.y, 5);
  return state;
}

export function updateAircraftVisuals(state, dt) {
  const tiltSpeed = Number.isFinite(state.definition.nacelles?.tiltSpeedDegS)
    ? state.definition.nacelles.tiltSpeedDegS
    : 12.2;
  const tiltDiff = state.nacelleTiltTarget - state.nacelleTiltDeg;
  state.nacelleTiltDeg += Math.sign(tiltDiff) * Math.min(Math.abs(tiltDiff), tiltSpeed * dt);
  const tiltAxis = ['x', 'y', 'z'].includes(state.definition.nacelles?.tiltAxis)
    ? state.definition.nacelles.tiltAxis
    : 'y';
  const tiltDirection = state.definition.nacelles?.tiltDirection === 1 ? 1 : -1;
  const tiltRad = THREE.MathUtils.degToRad(
    (HOVER_NACELLE_DEG - state.nacelleTiltDeg) * tiltDirection,
  );
  if (state.leftNacellePivot) state.leftNacellePivot.rotation[tiltAxis] = tiltRad;
  if (state.rightNacellePivot) state.rightNacellePivot.rotation[tiltAxis] = tiltRad;
  const rotorAxis = ['x', 'y', 'z'].includes(state.definition.nacelles?.rotorAxis)
    ? state.definition.nacelles.rotorAxis
    : 'z';
  const rotorSpeedRpm = Number.isFinite(state.definition.nacelles?.rotorSpeedRpm)
    ? state.definition.nacelles.rotorSpeedRpm
    : 397;
  const rotorResponseSeconds = Number.isFinite(state.definition.nacelles?.rotorResponseSeconds)
    ? Math.max(0.05, state.definition.nacelles.rotorResponseSeconds)
    : 3.5;
  const targetRotorVelocity = state.engineRunning ? rotorSpeedRpm * Math.PI * 2 / 60 : 0;
  const rotorResponse = 1 - Math.exp(-Math.max(0, dt) / rotorResponseSeconds);
  state.rotorAngularVelocity += (
    targetRotorVelocity - state.rotorAngularVelocity
  ) * rotorResponse;
  if (!state.engineRunning && Math.abs(state.rotorAngularVelocity) < 1e-4) {
    state.rotorAngularVelocity = 0;
  }
  state.rotorSpool = aircraftRotorSpool(state);
  state.rotorSpinAngle = (
    state.rotorSpinAngle + state.rotorAngularVelocity * Math.max(0, dt)
  ) % (Math.PI * 2);
  if (state.leftRotorMesh) state.leftRotorMesh.rotation[rotorAxis] = state.rotorSpinAngle;
  if (state.rightRotorMesh) state.rightRotorMesh.rotation[rotorAxis] = -state.rotorSpinAngle;

  const headingOffset = THREE.MathUtils.degToRad(Number(state.definition.headingOffsetDeg) || 0);
  const quaternion = VISUAL_QUATERNION.setFromAxisAngle(
    LOCAL_UP,
    state.headingRad + headingOffset,
  );
  if (Math.abs(state.pitchRad) > 0.001) {
    VISUAL_AXIS.set(Math.cos(state.headingRad), Math.sin(state.headingRad), 0);
    quaternion.premultiply(VISUAL_ROTATION.setFromAxisAngle(VISUAL_AXIS, state.pitchRad));
  }
  if (Math.abs(state.rollRad) > 0.001) {
    VISUAL_AXIS.set(-Math.sin(state.headingRad), Math.cos(state.headingRad), 0);
    quaternion.premultiply(VISUAL_ROTATION.setFromAxisAngle(VISUAL_AXIS, state.rollRad));
  }
  state.group.quaternion.copy(quaternion);
}

export function setupAircraftModelParts(state, model, log = () => {}) {
  const parts = state.definition.parts ?? {};
  const leftNames = new Set(Array.isArray(parts.leftNacelle) ? parts.leftNacelle : []);
  const rightNames = new Set(Array.isArray(parts.rightNacelle) ? parts.rightNacelle : []);
  const leftRotorName = typeof parts.leftRotor === 'string' ? parts.leftRotor : null;
  const rightRotorName = typeof parts.rightRotor === 'string' ? parts.rightRotor : null;
  const modelSize = new THREE.Vector3();
  new THREE.Box3().setFromObject(model).getSize(modelSize);
  const modelMax = Math.max(modelSize.x, modelSize.y, modelSize.z);
  const left = [];
  const right = [];
  let leftRotor = null;
  let rightRotor = null;
  model.traverse(object => {
    if (leftNames.has(object.name)) left.push(object);
    if (rightNames.has(object.name)) right.push(object);
    if (!object.isMesh) return;
    if (object.name === leftRotorName) leftRotor = object;
    if (object.name === rightRotorName) rightRotor = object;
  });
  model.updateWorldMatrix(true, true);
  const isSeparate = candidate => {
    const bounds = new THREE.Box3();
    const geometryBounds = new THREE.Box3();
    candidate.traverse(object => {
      if (!object.isMesh || object === leftRotor || object === rightRotor) return;
      if (object.geometry.boundingBox == null) object.geometry.computeBoundingBox();
      geometryBounds.copy(object.geometry.boundingBox).applyMatrix4(object.matrixWorld);
      bounds.union(geometryBounds);
    });
    if (bounds.isEmpty()) return false;
    const size = new THREE.Vector3();
    bounds.getSize(size);
    return Math.max(size.x, size.y, size.z) / Math.max(modelMax, 0.001) <= 0.5;
  };
  const validLeft = left.filter(isSeparate);
  const validRight = right.filter(isSeparate);
  if ((left.length || right.length) && !(validLeft.length || validRight.length)) {
    log('aircraft.parts.nacelles-material-merged', {
      id: state.id,
      left: left.length,
      right: right.length,
    }, 'warn');
  }
  const distinctRotors = leftRotor != null && rightRotor != null && leftRotor !== rightRotor;
  const distinctNacelles = validLeft.length === 1 && validRight.length === 1
    && validLeft[0] !== validRight[0];
  state.leftNacellePivot = distinctNacelles ? validLeft[0] : null;
  state.rightNacellePivot = distinctNacelles ? validRight[0] : null;
  state.leftRotorMesh = distinctRotors ? leftRotor : null;
  state.rightRotorMesh = distinctRotors ? rightRotor : null;
  if (!distinctRotors) {
    log('aircraft.parts.rotors-unavailable', {
      id: state.id,
      leftRotor: leftRotor?.name ?? null,
      rightRotor: rightRotor?.name ?? null,
      aliased: leftRotor != null && leftRotor === rightRotor,
    }, 'warn');
  }
  return {
    leftCandidates: left.length,
    rightCandidates: right.length,
    leftRotor: state.leftRotorMesh?.name ?? null,
    rightRotor: state.rightRotorMesh?.name ?? null,
    rotorAxis: state.definition.nacelles?.rotorAxis ?? 'z',
    nacelleAnimationAvailable: distinctNacelles,
    rotorAnimationAvailable: distinctRotors,
  };
}
