export const MAX_REALTIME_STEP_SECONDS = 0.05;
export const MAX_REALTIME_STEPS_PER_FRAME = 10;
export const FORWARD_LOCK_MAX_BANK_RADIANS = 25 * Math.PI / 180;
export const FORWARD_LOCK_MAX_TURN_RATE = 0.2;
export const FORWARD_LOCK_BANK_RESPONSE = 0.5625;
export const FORWARD_LOCK_BANK_INERTIA_RESPONSE = 4;
export const FORWARD_LOCK_THROTTLE_INERTIA_RESPONSE = 4;
export const FORWARD_LOCK_LEVEL_RESPONSE = 0.0375;
export const FORWARD_LOCK_EXIT_LEVEL_RESPONSE = 0.75;
export const FORWARD_LOCK_RELEASE_BRAKE_SCALE = 0.125;
export const FORWARD_LOCK_VERTICAL_MAX_SPEED = 100;
export const FORWARD_LOCK_VERTICAL_INERTIA_RESPONSE = 1.5;

function bleedVelocity(velocity, brakeStep) {
  if (velocity > 0) return Math.max(velocity - brakeStep, 0);
  if (velocity < 0) return Math.min(velocity + brakeStep, 0);
  return 0;
}

export function forwardLockLookYawOffset({ active, leftPressed, rightPressed }) {
  if (!active || leftPressed === rightPressed) return 0;
  return leftPressed ? Math.PI / 2 : -Math.PI / 2;
}

export function stepFreeFlightVerticalVelocity({
  verticalSpeed,
  upPressed,
  downPressed,
  forwardLock,
  maxVerticalSpeed,
  dt,
  forwardLockMaxSpeed = FORWARD_LOCK_VERTICAL_MAX_SPEED,
  inertiaResponse = FORWARD_LOCK_VERTICAL_INERTIA_RESPONSE,
}) {
  const verticalInput = (upPressed ? 1 : 0) - (downPressed ? 1 : 0);
  if (!forwardLock) return verticalInput * maxVerticalSpeed;

  const targetSpeed = verticalInput * Math.min(maxVerticalSpeed, forwardLockMaxSpeed);
  const blend = 1 - Math.exp(-inertiaResponse * dt);
  const nextSpeed = verticalSpeed + (targetSpeed - verticalSpeed) * blend;
  return Math.abs(nextSpeed) < 1e-5 ? 0 : nextSpeed;
}

export function stepFreeFlightVelocity({
  speed,
  strafeSpeed,
  forwardPressed,
  backPressed,
  leftPressed,
  rightPressed,
  forwardLock,
  forwardLockThrottle = 0,
  mapMode,
  forwardAcceleration,
  acceleration,
  brake,
  longitudinalBrakeScale = 1,
  maxSpeed,
  maxStrafeSpeed,
  dt,
  throttleInertiaResponse = FORWARD_LOCK_THROTTLE_INERTIA_RESPONSE,
}) {
  let nextSpeed = Math.max(-maxSpeed, Math.min(maxSpeed, speed));
  let nextStrafeSpeed = Math.max(
    -maxStrafeSpeed,
    Math.min(maxStrafeSpeed, strafeSpeed),
  );
  const forwardAccelerationStep = forwardAcceleration * dt;
  const accelerationStep = acceleration * dt;
  const brakeStep = brake * dt;
  const longitudinalBrakeStep = brakeStep * longitudinalBrakeScale;

  let nextForwardLockThrottle = 0;
  if (forwardLock) {
    const targetThrottle = (forwardPressed ? 1 : 0) - (backPressed ? 1 : 0);
    const throttleBlend = 1 - Math.exp(-throttleInertiaResponse * dt);
    nextForwardLockThrottle = forwardLockThrottle
      + (targetThrottle - forwardLockThrottle) * throttleBlend;
    if (Math.abs(nextForwardLockThrottle) < 1e-5) nextForwardLockThrottle = 0;

    if (nextForwardLockThrottle > 0) {
      nextSpeed = Math.min(
        nextSpeed + forwardAccelerationStep * nextForwardLockThrottle,
        maxSpeed,
      );
    } else if (nextForwardLockThrottle < 0) {
      const reverseStep = nextSpeed > 0 ? brakeStep : accelerationStep;
      nextSpeed = Math.max(
        nextSpeed + reverseStep * nextForwardLockThrottle,
        nextSpeed > 0 ? 0 : -maxSpeed,
      );
    }
  } else {
    if (forwardPressed) {
      nextSpeed = Math.min(nextSpeed + forwardAccelerationStep, maxSpeed);
    } else if (backPressed) {
      nextSpeed = nextSpeed > 0
        ? Math.max(nextSpeed - brakeStep, 0)
        : Math.max(nextSpeed - accelerationStep, -maxSpeed);
    } else {
      nextSpeed = bleedVelocity(nextSpeed, longitudinalBrakeStep);
    }
  }

  if (mapMode) {
    nextStrafeSpeed = 0;
  } else if (forwardLock) {
    // Forward-lock A/D input is consumed by the coordinated-turn step. Any
    // lateral velocity left over from normal free flight must still decay.
    nextStrafeSpeed = bleedVelocity(nextStrafeSpeed, brakeStep);
  } else if (rightPressed) {
    nextStrafeSpeed = Math.min(
      nextStrafeSpeed + accelerationStep,
      maxStrafeSpeed,
    );
  } else if (leftPressed) {
    nextStrafeSpeed = Math.max(
      nextStrafeSpeed - accelerationStep,
      -maxStrafeSpeed,
    );
  } else {
    nextStrafeSpeed = bleedVelocity(nextStrafeSpeed, brakeStep);
  }

  return {
    speed: nextSpeed,
    strafeSpeed: nextStrafeSpeed,
    forwardLockThrottle: nextForwardLockThrottle,
  };
}

/**
 * Convert forward-lock A/D input into a banked, automatically coordinated turn.
 *
 * Positive bank is right-wing-down. The application's yaw convention runs in
 * the opposite direction, hence a right bank produces a negative yaw delta.
 * Exponential response keeps the motion independent of render frame rate and
 * returns the camera smoothly to wings-level when the keys are released.
 */
export function stepForwardLockTurn({
  bank,
  bankVelocity,
  leftPressed,
  rightPressed,
  active,
  stationary = false,
  dt,
  maxBank = FORWARD_LOCK_MAX_BANK_RADIANS,
  maxTurnRate = FORWARD_LOCK_MAX_TURN_RATE,
  bankResponse = FORWARD_LOCK_BANK_RESPONSE,
  bankInertiaResponse = FORWARD_LOCK_BANK_INERTIA_RESPONSE,
  levelResponse = FORWARD_LOCK_LEVEL_RESPONSE,
  exitLevelResponse = FORWARD_LOCK_EXIT_LEVEL_RESPONSE,
}) {
  // A stopped forward-locked camera has no coordinated turn to sustain. Once
  // lock is disabled, however, keep easing out residual roll past the end of
  // the coast rather than snapping the last tilted frame level.
  if (stationary && active) return { bank: 0, bankVelocity: 0, yawDelta: 0 };

  const turnInput = active
    ? (rightPressed ? 1 : 0) - (leftPressed ? 1 : 0)
    : 0;
  const targetBank = turnInput * maxBank;
  let nextBankVelocity;
  let nextBank;
  if (turnInput === 0) {
    const flattenResponse = active ? levelResponse : exitLevelResponse;
    const blend = 1 - Math.exp(-flattenResponse * dt);
    nextBank = bank + (targetBank - bank) * blend;
    nextBankVelocity = 0;
  } else {
    const desiredVelocity = (targetBank - bank) * bankResponse;
    const velocityBlend = 1 - Math.exp(-bankInertiaResponse * dt);
    nextBankVelocity = bankVelocity
      + (desiredVelocity - bankVelocity) * velocityBlend;
    nextBank = bank + nextBankVelocity * dt;
    if ((targetBank - bank) * (targetBank - nextBank) < 0) {
      nextBank = targetBank;
      nextBankVelocity = 0;
    }
  }
  if (Math.abs(nextBank) < 1e-5) nextBank = 0;

  const normalizedTurn = Math.tan(nextBank) / Math.tan(maxBank);
  const yawDelta = active ? -maxTurnRate * normalizedTurn * dt : 0;
  return { bank: nextBank, bankVelocity: nextBankVelocity, yawDelta };
}

/**
 * Advance movement through all elapsed wall time before the next render.
 *
 * Normal frame delays are split into small, stable simulation steps. Very
 * long delays still consume the full elapsed interval, but use a bounded
 * number of steps so resuming a backgrounded tab cannot lock up the UI.
 */
export function advanceRealtimeMovement(
  elapsedSeconds,
  step,
  {
    maxStepSeconds = MAX_REALTIME_STEP_SECONDS,
    maxSteps = MAX_REALTIME_STEPS_PER_FRAME,
  } = {},
) {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return 0;
  if (typeof step !== 'function') throw new TypeError('step must be a function');
  if (!Number.isFinite(maxStepSeconds) || maxStepSeconds <= 0) {
    throw new RangeError('maxStepSeconds must be positive');
  }
  if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
    throw new RangeError('maxSteps must be a positive integer');
  }

  const stepCount = Math.min(maxSteps, Math.max(1, Math.ceil(elapsedSeconds / maxStepSeconds)));
  const stepSeconds = elapsedSeconds / stepCount;
  for (let index = 0; index < stepCount; index += 1) step(stepSeconds);
  return stepCount;
}
