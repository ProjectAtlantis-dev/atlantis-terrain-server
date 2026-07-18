import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';

const TRACER_SPEED_MPS = 900;
const TRACER_MAX_RANGE_M = 3000;
const FIRE_INTERVAL_S = 0.1;
const MUZZLE_LIFETIME_S = 0.055;
const IMPACT_LIFETIME_S = 0.35;
const LOCAL_Y = new THREE.Vector3(0, 1, 0);

function createEffectMaterial(color, opacity = 1) {
  return new MeshBasicNodeMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    blending: THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
}

function createGunshotAudioRuntime() {
  let context = null;
  let output = null;
  let buffer = null;

  function initialize() {
    if (context != null) return true;
    const AudioContextImpl = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (typeof AudioContextImpl !== 'function') return false;
    context = new AudioContextImpl();
    output = context.createGain();
    output.gain.value = 0.32;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.knee.value = 8;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.002;
    compressor.release.value = 0.12;
    output.connect(compressor);
    compressor.connect(context.destination);

    const duration = 0.16;
    buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
      const t = i / context.sampleRate;
      const crack = (Math.random() * 2 - 1) * Math.exp(-t * 42);
      const thump = Math.sin(t * Math.PI * 2 * 82) * Math.exp(-t * 24);
      data[i] = THREE.MathUtils.clamp(crack * 0.8 + thump * 0.55, -1, 1);
    }
    return true;
  }

  function play() {
    if (!initialize()) return;
    if (context.state === 'suspended') void context.resume();
    // AudioBufferSourceNode is one-shot by Web Audio design. The expensive buffer,
    // compressor, and output graph are built once and reused for every round.
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(output);
    source.start();
  }

  return { initialize, play };
}

export function createVehicleFireRuntime({
  terrainRoot,
  camera,
  getTerrainTargets,
  bootLog = () => {},
  tracerCount = 32,
  impactCount = 20,
} = {}) {
  const root = new THREE.Group();
  root.name = 'vehicle-fire-effects';
  terrainRoot.add(root);

  const muzzle = new THREE.Mesh(
    new THREE.SphereGeometry(0.34, 8, 6),
    createEffectMaterial(0xffd36a, 0.95),
  );
  muzzle.name = 'vehicle-muzzle-flash';
  muzzle.visible = false;
  muzzle.frustumCulled = false;
  root.add(muzzle);

  const tracerGeometry = new THREE.CylinderGeometry(0.025, 0.055, 2.8, 6, 1, true);
  const tracerMaterial = createEffectMaterial(0xffc24b, 0.9);
  const tracers = Array.from({ length: tracerCount }, (_, index) => {
    const mesh = new THREE.Mesh(tracerGeometry, tracerMaterial);
    mesh.name = `vehicle-tracer-${index}`;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.userData.active = false;
    mesh.userData.distance = 0;
    mesh.userData.position = new THREE.Vector3();
    mesh.userData.direction = new THREE.Vector3();
    root.add(mesh);
    return mesh;
  });

  const impactGeometry = new THREE.SphereGeometry(0.22, 7, 5);
  const impacts = Array.from({ length: impactCount }, (_, index) => {
    const mesh = new THREE.Mesh(impactGeometry, createEffectMaterial(0xff7a24, 0.8));
    mesh.name = `vehicle-impact-${index}`;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.userData.active = false;
    mesh.userData.timer = 0;
    root.add(mesh);
    return mesh;
  });

  const fireRaycaster = new THREE.Raycaster();
  const cameraOrigin = new THREE.Vector3();
  const cameraDirection = new THREE.Vector3();
  const aimTarget = new THREE.Vector3();
  const fireDirection = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const audio = createGunshotAudioRuntime();
  let muzzleTimer = 0;
  let shotsFired = 0;

  function fire(entry, muzzleOriginLocal, nowS = performance.now() / 1000) {
    const lastFireAt = Number.isFinite(entry?.lastFireAt) ? entry.lastFireAt : -Infinity;
    if (entry == null || nowS - lastFireAt < FIRE_INTERVAL_S) return false;
    entry.lastFireAt = nowS;

    camera.getWorldPosition(cameraOrigin);
    camera.getWorldDirection(cameraDirection);
    fireRaycaster.set(cameraOrigin, cameraDirection);
    fireRaycaster.far = TRACER_MAX_RANGE_M;
    const hit = fireRaycaster.intersectObjects(getTerrainTargets(), false)[0] ?? null;
    if (hit != null) {
      aimTarget.copy(hit.point);
    } else {
      aimTarget.copy(cameraDirection).multiplyScalar(TRACER_MAX_RANGE_M).add(cameraOrigin);
    }
    terrainRoot.worldToLocal(aimTarget);
    fireDirection.copy(aimTarget).sub(muzzleOriginLocal).normalize();
    const tracerMaxDistance = Math.max(0.01, muzzleOriginLocal.distanceTo(aimTarget));

    muzzle.position.copy(muzzleOriginLocal);
    muzzle.scale.setScalar(0.75 + Math.random() * 0.35);
    muzzle.material.opacity = 0.95;
    muzzle.visible = true;
    muzzleTimer = MUZZLE_LIFETIME_S;

    const tracer = tracers.find(candidate => !candidate.userData.active);
    if (tracer != null) {
      tracer.userData.active = true;
      tracer.userData.distance = 0;
      tracer.userData.maxDistance = tracerMaxDistance;
      tracer.userData.position.copy(muzzleOriginLocal);
      tracer.userData.direction.copy(fireDirection);
      tracer.position.copy(muzzleOriginLocal);
      rotation.setFromUnitVectors(LOCAL_Y, fireDirection);
      tracer.quaternion.copy(rotation);
      tracer.visible = true;
    }

    if (hit != null) {
      const impact = impacts.find(candidate => !candidate.userData.active);
      if (impact != null) {
        impact.userData.active = true;
        impact.userData.timer = IMPACT_LIFETIME_S;
        impact.position.copy(hit.point);
        terrainRoot.worldToLocal(impact.position);
        impact.scale.setScalar(0.6);
        impact.material.opacity = 0.8;
        impact.visible = true;
      }
    }

    shotsFired += 1;
    audio.play();
    if (shotsFired === 1) {
      bootLog('vehicle.fire.first-shot', {
        id: entry.id,
        tracerPool: tracers.length,
        impactPool: impacts.length,
        nodeMaterials: true,
      });
    }
    return true;
  }

  function update(dt) {
    if (muzzleTimer > 0) {
      muzzleTimer -= dt;
      if (muzzleTimer <= 0) {
        muzzle.visible = false;
      } else {
        muzzle.material.opacity = 0.95 * muzzleTimer / MUZZLE_LIFETIME_S;
      }
    }
    const tracerStep = TRACER_SPEED_MPS * dt;
    for (const tracer of tracers) {
      if (!tracer.userData.active) continue;
      tracer.userData.distance += tracerStep;
      if (tracer.userData.distance >= tracer.userData.maxDistance) {
        tracer.userData.active = false;
        tracer.visible = false;
        continue;
      }
      tracer.userData.position.addScaledVector(tracer.userData.direction, tracerStep);
      tracer.position.copy(tracer.userData.position);
    }
    for (const impact of impacts) {
      if (!impact.userData.active) continue;
      impact.userData.timer -= dt;
      if (impact.userData.timer <= 0) {
        impact.userData.active = false;
        impact.visible = false;
        continue;
      }
      const life = impact.userData.timer / IMPACT_LIFETIME_S;
      impact.material.opacity = 0.8 * life;
      impact.scale.setScalar(0.6 + (1 - life) * 1.4);
    }
  }

  function stop() {
    muzzle.visible = false;
    muzzleTimer = 0;
  }

  function summary() {
    return {
      shotsFired,
      activeTracers: tracers.filter(tracer => tracer.userData.active).length,
      activeImpacts: impacts.filter(impact => impact.userData.active).length,
      muzzleVisible: muzzle.visible,
      nodeMaterials: tracers[0]?.material?.isMeshBasicNodeMaterial === true,
    };
  }

  return {
    fire,
    primeAudio: audio.initialize,
    update,
    stop,
    summary,
    root,
  };
}
