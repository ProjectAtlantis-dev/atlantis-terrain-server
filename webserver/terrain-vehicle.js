import { headingForward2D } from './terrain-priority.js';

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
