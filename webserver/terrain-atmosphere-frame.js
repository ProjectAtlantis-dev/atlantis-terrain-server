import { Matrix4, Vector3 } from 'three';
import { Ellipsoid, Geodetic, radians } from '@takram/three-geospatial';

function requireFinite(name, value) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be finite, got ${String(value)}`);
  }
}

function requireVector(name, value) {
  if (value == null || ![value.x, value.y, value.z].every(Number.isFinite)) {
    throw new TypeError(`${name} must be a finite Vector3`);
  }
}

/**
 * Keep Takram's WGS84 ellipsoid attached to the terrain's floating local ENU
 * frame. The terrain renderer deliberately keeps one flat scene plane while
 * its EPSG:3413 origin moves around Greenland; treating those scene positions
 * as literal ECEF makes camera HAE accumulate the old anchor's curvature.
 */
export function createTerrainAtmosphereFrame({
  sceneEast,
  sceneNorth,
  sceneUp,
  effects = [],
  ellipsoid = Ellipsoid.WGS84,
} = {}) {
  requireVector('sceneEast', sceneEast);
  requireVector('sceneNorth', sceneNorth);
  requireVector('sceneUp', sceneUp);

  const sceneFrame = new Matrix4().makeBasis(sceneEast, sceneNorth, sceneUp);
  const targetFrame = new Matrix4();
  const targetFrameInverse = new Matrix4();
  const worldToECEF = new Matrix4();
  const geodetic = new Geodetic();
  const ecefSurface = new Vector3();
  const ecefEast = new Vector3();
  const ecefNorth = new Vector3();
  const ecefUp = new Vector3();
  const ellipsoidMatrix = new Matrix4();
  const ellipsoidCenter = new Vector3();
  const previousSurface = new Vector3();
  const state = {
    distanceM: 0,
    ecefSurface,
    ecefEast,
    ecefNorth,
    ecefUp,
    worldToECEFMatrix: worldToECEF,
    ellipsoidMatrix,
    ellipsoidCenter,
  };
  let initialized = false;

  const effectTransforms = effects.map((effect, index) => {
    if (effect?.worldToECEFMatrix?.copy != null) {
      return { effect, kind: 'worldToECEFMatrix' };
    }
    if (effect?.ellipsoidMatrix?.copy != null && effect?.ellipsoidCenter?.copy != null) {
      return { effect, kind: 'ellipsoidTransforms' };
    }
    throw new TypeError(`effects[${index}] does not expose a Takram world-to-ECEF transform`);
  });

  function update({ latitude, longitude, sceneSurfacePosition } = {}) {
    requireFinite('latitude', latitude);
    requireFinite('longitude', longitude);
    requireVector('sceneSurfacePosition', sceneSurfacePosition);
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      throw new RangeError(`invalid geodetic location ${latitude}, ${longitude}`);
    }

    geodetic
      .set(radians(longitude), radians(latitude), 0)
      .toECEF(ecefSurface, { ellipsoid });
    ellipsoid.getEastNorthUpVectors(ecefSurface, ecefEast, ecefNorth, ecefUp);

    // Takram's ellipsoidMatrix is rotation-only. Its shaders transform the
    // camera with mat3(inverseEllipsoidMatrix), then subtract ellipsoidCenter;
    // hiding translation in the Matrix4 would make CPU and shader HAE disagree.
    targetFrame.makeBasis(ecefEast, ecefNorth, ecefUp);
    targetFrameInverse.copy(targetFrame).invert();
    ellipsoidMatrix.multiplyMatrices(sceneFrame, targetFrameInverse);
    worldToECEF.copy(ellipsoidMatrix).invert();
    ellipsoidCenter
      .copy(sceneSurfacePosition)
      .applyMatrix4(worldToECEF)
      .sub(ecefSurface);
    worldToECEF.setPosition(
      -ellipsoidCenter.x,
      -ellipsoidCenter.y,
      -ellipsoidCenter.z,
    );

    for (const { effect, kind } of effectTransforms) {
      if (kind === 'worldToECEFMatrix') {
        effect.worldToECEFMatrix.copy(worldToECEF);
      } else {
        effect.ellipsoidMatrix.copy(ellipsoidMatrix);
        effect.ellipsoidCenter.copy(ellipsoidCenter);
      }
    }

    state.distanceM = initialized ? previousSurface.distanceTo(ecefSurface) : 0;
    previousSurface.copy(ecefSurface);
    initialized = true;
    return state;
  }

  function toECEF(worldPosition, result = new Vector3()) {
    requireVector('worldPosition', worldPosition);
    if (!initialized) throw new Error('terrain atmosphere frame has not been initialized');
    return result.copy(worldPosition).applyMatrix4(worldToECEF);
  }

  function toSceneDirection(ecefDirection, result = new Vector3()) {
    requireVector('ecefDirection', ecefDirection);
    if (!initialized) throw new Error('terrain atmosphere frame has not been initialized');
    // Directions only rotate: the floating origin translation must not
    // affect the apparent sun direction or its elevation above scene up.
    return result.copy(ecefDirection).transformDirection(ellipsoidMatrix);
  }

  return { update, toECEF, toSceneDirection };
}
