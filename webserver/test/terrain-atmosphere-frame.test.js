import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, PerspectiveCamera, Vector2, Vector3 } from 'three';
import { Ellipsoid, Geodetic, radians } from '@takram/three-geospatial';

import { createTerrainAtmosphereFrame } from '../terrain-atmosphere-frame.js';
import { approximateLatLonToLocalMeters } from '../terrain-local-coordinates.js';
import { projectSunDirectionToUv, sunFlareElevationVisibility } from '../terrain-sun-flare-effect.js';

const NUUK = { latitude: 64.1835, longitude: -51.7216 };
const PAAMIUT = { latitude: 61.99402, longitude: -49.66776 };

function expectVectorClose(actual, expected, tolerance = 1e-5) {
  assert.ok(
    actual.distanceTo(expected) <= tolerance,
    `${actual.toArray()} differs from ${expected.toArray()} by ${actual.distanceTo(expected)}`,
  );
}

function createFixture() {
  const anchor = new Geodetic(
    radians(NUUK.longitude),
    radians(NUUK.latitude),
    0,
  ).toECEF();
  const east = new Vector3();
  const north = new Vector3();
  const up = new Vector3();
  Ellipsoid.WGS84.getEastNorthUpVectors(anchor, east, north, up);
  const effects = [0, 1].map(() => ({
    ellipsoidMatrix: new Matrix4(),
    ellipsoidCenter: new Vector3(),
  }));
  return {
    anchor, east, north, up, effects,
    frame: createTerrainAtmosphereFrame({
      sceneEast: east,
      sceneNorth: north,
      sceneUp: up,
      effects,
    }),
  };
}

test('moving atmosphere frame resets local sea level to WGS84 at Paamiut', () => {
  const { anchor, east, north, up, effects, frame } = createFixture();
  const local = approximateLatLonToLocalMeters({
    lat: PAAMIUT.latitude,
    lon: PAAMIUT.longitude,
    anchorLat: NUUK.latitude,
    anchorLon: NUUK.longitude,
  });
  const sceneSurface = anchor.clone()
    .addScaledVector(east, local.eastM)
    .addScaledVector(north, local.northM);

  const state = frame.update({ ...PAAMIUT, sceneSurfacePosition: sceneSurface });
  const expectedSurface = new Geodetic(
    radians(PAAMIUT.longitude),
    radians(PAAMIUT.latitude),
    0,
  ).toECEF();
  expectVectorClose(frame.toECEF(sceneSurface), expectedSurface);
  expectVectorClose(state.ecefSurface, expectedSurface);
  assert.ok(effects[0].ellipsoidMatrix.equals(effects[1].ellipsoidMatrix));
  assert.ok(effects[0].ellipsoidCenter.equals(effects[1].ellipsoidCenter));

  const sceneCamera = sceneSurface.clone().addScaledVector(up, 1200);
  const cameraECEF = frame.toECEF(sceneCamera);
  const cameraGeodetic = new Geodetic().setFromECEF(cameraECEF);
  assert.ok(Math.abs(cameraGeodetic.height - 1200) < 1e-5, cameraGeodetic.height);

  // This is the regression: interpreting the same flat Nuuk-tangent position
  // as literal ECEF adds kilometres of curvature-derived HAE at Paamiut.
  const staleGeodetic = new Geodetic().setFromECEF(sceneCamera);
  assert.ok(staleGeodetic.height > 6000, staleGeodetic.height);
});

test('moving atmosphere frame reports region jumps for temporal invalidation', () => {
  const { anchor, east, north, frame } = createFixture();
  const first = frame.update({ ...NUUK, sceneSurfacePosition: anchor });
  assert.equal(first.distanceM, 0);

  const local = approximateLatLonToLocalMeters({
    lat: PAAMIUT.latitude,
    lon: PAAMIUT.longitude,
    anchorLat: NUUK.latitude,
    anchorLon: NUUK.longitude,
  });
  const paamiutSurface = anchor.clone()
    .addScaledVector(east, local.eastM)
    .addScaledVector(north, local.northM);
  const second = frame.update({ ...PAAMIUT, sceneSurfacePosition: paamiutSurface });
  assert.ok(second.distanceM > 250_000, second.distanceM);
});

test('moving atmosphere frame supports Takram worldToECEFMatrix effects', () => {
  const { anchor, east, north, up } = createFixture();
  const effect = { worldToECEFMatrix: new Matrix4() };
  const frame = createTerrainAtmosphereFrame({
    sceneEast: east,
    sceneNorth: north,
    sceneUp: up,
    effects: [effect],
  });
  const local = approximateLatLonToLocalMeters({
    lat: PAAMIUT.latitude,
    lon: PAAMIUT.longitude,
    anchorLat: NUUK.latitude,
    anchorLon: NUUK.longitude,
  });
  const sceneSurface = anchor.clone()
    .addScaledVector(east, local.eastM)
    .addScaledVector(north, local.northM);

  const state = frame.update({ ...PAAMIUT, sceneSurfacePosition: sceneSurface });
  const expectedSurface = new Geodetic(
    radians(PAAMIUT.longitude),
    radians(PAAMIUT.latitude),
    0,
  ).toECEF();
  expectVectorClose(sceneSurface.clone().applyMatrix4(effect.worldToECEFMatrix), expectedSurface);
  assert.ok(effect.worldToECEFMatrix.equals(state.worldToECEFMatrix));
  expectVectorClose(frame.toECEF(sceneSurface), expectedSurface);
});

test('moving atmosphere frame rejects incomplete geodetic state', () => {
  const { anchor, frame } = createFixture();
  assert.throws(
    () => frame.update({ latitude: NaN, longitude: -49, sceneSurfacePosition: anchor }),
    /latitude must be finite/,
  );
});

test('flare projection and water lighting follow the rendered sun after travelling across Greenland', () => {
  const { anchor, east, north, up, frame } = createFixture();
  const camera = new PerspectiveCamera(60, 1.8, 1, 1e7);
  camera.up.copy(up);
  const elevation = 25 * Math.PI / 180;
  const expectedSceneSun = north.clone().multiplyScalar(Math.cos(elevation))
    .addScaledVector(up, Math.sin(elevation));
  const sceneSun = new Vector3();
  const uv = new Vector2();
  for (const location of [NUUK, PAAMIUT, { latitude: 60.57, longitude: -44.25 }]) {
    const local = approximateLatLonToLocalMeters({
      lat: location.latitude, lon: location.longitude,
      anchorLat: NUUK.latitude, anchorLon: NUUK.longitude,
    });
    const surface = anchor.clone().addScaledVector(east, local.eastM)
      .addScaledVector(north, local.northM);
    const state = frame.update({ ...location, sceneSurfacePosition: surface });
    const ecefSun = state.ecefNorth.clone().multiplyScalar(Math.cos(elevation))
      .addScaledVector(state.ecefUp, Math.sin(elevation));
    assert.equal(frame.toSceneDirection(ecefSun, sceneSun), sceneSun);
    expectVectorClose(sceneSun, expectedSceneSun);
    expectVectorClose(sceneSun.clone().transformDirection(state.worldToECEFMatrix), ecefSun);
    camera.position.copy(surface).addScaledVector(up, 100);
    camera.lookAt(camera.position.clone().addScaledVector(sceneSun, 1000));
    camera.updateMatrixWorld(true);
    assert.equal(projectSunDirectionToUv(camera, sceneSun, uv), true);
    assert.ok(uv.distanceTo(new Vector2(0.5, 0.5)) < 1e-9);
    assert.equal(sunFlareElevationVisibility(sceneSun, up), 1);
    // These are the ENU components consumed by the water glint/shadow mask.
    assert.ok(Math.abs(sceneSun.dot(east)) < 1e-9);
    assert.ok(Math.abs(sceneSun.dot(up) - Math.sin(elevation)) < 1e-9);
    if (location !== NUUK) {
      projectSunDirectionToUv(camera, ecefSun, uv);
      // The old direction misses the tiny HDR sun disk, so sourceGate = 0.
      assert.ok(uv.distanceTo(new Vector2(0.5, 0.5)) > 0.02);
    }
  }
});
