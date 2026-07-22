import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  createAircraftState,
  setupAircraftModelParts,
  stepAircraftFlight,
  toggleAircraftEngine,
  updateAircraftVisuals,
} from '../terrain-aircraft-runtime.js';
import { createVehicleFireRuntime } from '../terrain-vehicle-fire.js';
import {
  createVehicleWheelRig,
  normalizeVehiclePartDefinition,
  spinVehicleWheelRig,
} from '../terrain-vehicle-parts.js';

test('Patria wheel rig preserves source meshes and rotates independent vertex clusters', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, -0.05, -1,
    0, 0.05, 1,
    1, -0.05, -1,
    1, 0.05, 1,
  ], 3));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.name = 'Object_8';
  const parent = new THREE.Group();
  parent.add(mesh);
  const rig = createVehicleWheelRig(THREE, {
    wheels: [mesh],
    config: { wheelClusterSplitThreshold: null },
  });
  assert.equal(rig.clusters.length, 1);
  assert.equal(mesh.parent, parent);
  assert.equal(spinVehicleWheelRig(rig, Math.PI / 2, 1), true);
  assert.ok(Math.abs(geometry.getAttribute('position').getY(0) - -1) < 1e-6);
  assert.ok(geometry.getAttribute('position').version > 0);
});

test('Patria wheel discovery retains the live 3500-vertex split threshold', () => {
  assert.equal(normalizeVehiclePartDefinition({}).wheelClusterSplitThreshold, 3500);
  assert.equal(
    normalizeVehiclePartDefinition({ wheelClusterSplitThreshold: null })
      .wheelClusterSplitThreshold,
    3500,
  );
  assert.equal(
    normalizeVehiclePartDefinition({ wheelClusterSplitThreshold: 4200 })
      .wheelClusterSplitThreshold,
    4200,
  );
});

test('aircraft engine and direct flight controls preserve the live behavior', () => {
  const group = new THREE.Group();
  group.position.z = 2;
  const aircraft = createAircraftState({
    id: 'osprey-01',
    definition: {
      vehicleType: 'aircraft',
      altOffsetM: 2,
      flight: {
        hoverMaxSpeedMs: 30,
        climbRateMs: 15,
        descendRateMs: 10,
        accelMs2: 15,
        yawRateRad: 1.05,
      },
    },
    instance: { headingDeg: 0 },
    group,
    marker: { position: { set() {} } },
  });
  assert.equal(toggleAircraftEngine(aircraft), true);
  stepAircraftFlight(aircraft, { climb: true }, 1, 0);
  assert.ok(group.position.z > 2);
  stepAircraftFlight(aircraft, {
    forward: true, climb: true, left: true,
  }, 1.5, 0);
  assert.ok(aircraft.forwardSpeedMs > 0);
  assert.ok(aircraft.headingRad > 0);
  assert.notEqual(aircraft.flightRegime, 'GROUND');

  assert.equal(toggleAircraftEngine(aircraft), false);
  group.position.z = -5;
  aircraft.verticalSpeedMs = -20;
  stepAircraftFlight(aircraft, {}, 0.5, 4);
  assert.equal(group.position.z, 6);
  assert.equal(aircraft.verticalSpeedMs, 0);
});

test('aircraft neutral controls damp vertical motion for a stable hover', () => {
  const group = new THREE.Group();
  group.position.z = 20;
  const aircraft = createAircraftState({
    id: 'osprey-hover',
    definition: { vehicleType: 'aircraft', altOffsetM: 2, flight: {} },
    instance: { headingDeg: 0 },
    group,
    marker: null,
  });
  aircraft.engineRunning = true;
  aircraft.verticalSpeedMs = 3;
  stepAircraftFlight(aircraft, {}, 1, 0);
  assert.equal(aircraft.verticalSpeedMs, 0);
  assert.equal(aircraft.flightRegime, 'HOVER');
});

test('aircraft nacelles convert automatically with forward speed', () => {
  const group = new THREE.Group();
  group.position.z = 100;
  const aircraft = createAircraftState({
    id: 'osprey-transition',
    definition: {
      vehicleType: 'aircraft',
      altOffsetM: 2,
      flight: {
        transitionLowMs: 30,
        transitionHighMs: 50,
        maxSpeedMs: 141,
        hoverMaxSpeedMs: 30,
      },
    },
    instance: { headingDeg: 0 },
    group,
    marker: null,
  });
  aircraft.engineRunning = true;
  aircraft.forwardSpeedMs = 40;
  stepAircraftFlight(aircraft, { forward: true }, 0.1, 0);
  assert.ok(aircraft.nacelleTiltTarget > 0 && aircraft.nacelleTiltTarget < 97.5);
  aircraft.forwardSpeedMs = 55;
  stepAircraftFlight(aircraft, { forward: true }, 0.1, 0);
  assert.equal(aircraft.nacelleTiltTarget, 0);
  aircraft.nacelleTiltDeg = 0;
  stepAircraftFlight(aircraft, {}, 0, 0);
  assert.equal(aircraft.flightRegime, 'AIRPLANE');
});

test('aircraft setup assigns distinct nacelles and counter-rotating rotors', () => {
  const group = new THREE.Group();
  const model = new THREE.Group();
  const leftNacelle = new THREE.Group();
  const rightNacelle = new THREE.Group();
  const leftHousing = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 2));
  const rightHousing = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 2));
  const leftRotor = new THREE.Mesh(new THREE.BoxGeometry(8, 0.2, 8));
  const rightRotor = new THREE.Mesh(new THREE.BoxGeometry(8, 0.2, 8));
  leftNacelle.name = 'V22_Nacelle_Left';
  rightNacelle.name = 'V22_Nacelle_Right';
  leftRotor.name = 'V22_Rotor_Left';
  rightRotor.name = 'V22_Rotor_Right';
  leftNacelle.position.z = 7;
  rightNacelle.position.z = -7;
  leftNacelle.add(leftHousing, leftRotor);
  rightNacelle.add(rightHousing, rightRotor);
  model.add(leftNacelle, rightNacelle);
  const aircraft = createAircraftState({
    id: 'osprey-01',
    definition: {
      vehicleType: 'aircraft',
      flight: {},
      parts: {
        leftNacelle: [leftNacelle.name],
        rightNacelle: [rightNacelle.name],
        leftRotor: leftRotor.name,
        rightRotor: rightRotor.name,
      },
      nacelles: {
        tiltSpeedDegS: 12.2,
        tiltAxis: 'y',
        tiltDirection: -1,
        rotorAxis: 'z',
        rotorSpeedRpm: 397,
        rotorResponseSeconds: 3.5,
      },
    },
    instance: { headingDeg: 0 },
    group,
    marker: null,
  });
  const summary = setupAircraftModelParts(aircraft, model);
  assert.equal(summary.rotorAnimationAvailable, true);
  assert.equal(summary.nacelleAnimationAvailable, true);
  assert.equal(aircraft.leftNacellePivot, leftNacelle);
  assert.equal(aircraft.rightNacellePivot, rightNacelle);
  aircraft.engineRunning = true;
  aircraft.nacelleTiltTarget = 0;
  updateAircraftVisuals(aircraft, 1);
  assert.ok(aircraft.rotorAngularVelocity > 0);
  assert.notEqual(leftRotor.rotation.z, 0);
  assert.equal(rightRotor.rotation.z, -leftRotor.rotation.z);
  assert.ok(leftNacelle.rotation.y < 0);
  assert.equal(rightNacelle.rotation.y, leftNacelle.rotation.y);
});

test('vehicle fire runtime expires muzzle, tracer, and impact effects', () => {
  const terrainRoot = new THREE.Group();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
  camera.position.set(0, -5, 2);
  camera.lookAt(0, 100, 0);
  camera.updateMatrixWorld(true);
  const target = new THREE.Mesh(new THREE.PlaneGeometry(500, 500));
  target.position.y = 100;
  terrainRoot.add(target);
  terrainRoot.updateMatrixWorld(true);
  const runtime = createVehicleFireRuntime({
    terrainRoot,
    camera,
    getTerrainTargets: () => [target],
    tracerCount: 2,
    impactCount: 2,
  });
  const vehicleEntry = { id: 'amv-01', lastFireAt: -Infinity };
  assert.equal(runtime.fire(vehicleEntry, new THREE.Vector3(0, 0, 2), 1), true);
  assert.equal(runtime.fire(vehicleEntry, new THREE.Vector3(0, 0, 2), 1.05), false);
  assert.deepEqual(runtime.summary(), {
    shotsFired: 1,
    activeTracers: 1,
    activeImpacts: 1,
    muzzleVisible: true,
    nodeMaterials: false,
    classicMaterials: true,
  });
  runtime.update(4);
  assert.equal(runtime.summary().activeTracers, 0);
  assert.equal(runtime.summary().activeImpacts, 0);
  assert.equal(runtime.summary().muzzleVisible, false);
});
