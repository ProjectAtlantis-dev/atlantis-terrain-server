import * as THREE from 'three';

const TRACER_SPEED_MPS = 900;
const TRACER_MAX_RANGE_M = 3000;
const FIRE_INTERVAL_S = 0.1;
const MUZZLE_LIFETIME_S = 0.05;
const IMPACT_LIFETIME_S = 0.4;
const LOCAL_Y = new THREE.Vector3(0, 1, 0);

function createRadialTexture(size, innerColor, outerColor) {
  if (globalThis.document?.createElement) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (context != null) {
      const half = size * 0.5;
      const gradient = context.createRadialGradient(half, half, 0, half, half, half);
      if (size === 64) {
        gradient.addColorStop(0, 'rgba(255,255,200,1)');
        gradient.addColorStop(0.3, 'rgba(255,200,50,0.8)');
        gradient.addColorStop(1, 'rgba(255,100,0,0)');
      } else {
        gradient.addColorStop(0, 'rgba(200,150,80,1)');
        gradient.addColorStop(0.5, 'rgba(150,100,40,0.6)');
        gradient.addColorStop(1, 'rgba(100,60,20,0)');
      }
      context.fillStyle = gradient;
      context.fillRect(0, 0, size, size);
      return new THREE.CanvasTexture(canvas);
    }
  }
  const data = new Uint8Array(size * size * 4);
  const center = (size - 1) * 0.5;
  const radius = Math.max(1, center);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const t = Math.min(1, Math.hypot(x - center, y - center) / radius);
      const fade = (1 - t) ** 2;
      const offset = (y * size + x) * 4;
      data[offset] = Math.round(THREE.MathUtils.lerp(innerColor.r, outerColor.r, t));
      data[offset + 1] = Math.round(THREE.MathUtils.lerp(innerColor.g, outerColor.g, t));
      data[offset + 2] = Math.round(THREE.MathUtils.lerp(innerColor.b, outerColor.b, t));
      data[offset + 3] = Math.round(255 * fade);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createSpriteMaterial(map, opacity) {
  return new THREE.SpriteMaterial({
    map,
    color: 0xffffff,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

function createGunshotAudioRuntime() {
  function initialize() {
    try {
      const context = THREE.AudioContext.getContext();
      if (context?.state === 'suspended') void context.resume();
      return context != null;
    } catch {
      return false;
    }
  }

  function play() {
    try {
      const context = THREE.AudioContext.getContext();
      if (!context || context.state !== 'running') return;
      const now = context.currentTime;
      const bufferLength = Math.floor(context.sampleRate * 0.05);
      const noiseBuffer = context.createBuffer(1, bufferLength, context.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let index = 0; index < bufferLength; index += 1) {
        data[index] = (Math.random() * 2 - 1) * Math.exp(-index / (bufferLength * 0.15));
      }
      const noise = context.createBufferSource();
      noise.buffer = noiseBuffer;
      const bandpass = context.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = 800;
      bandpass.Q.value = 1.5;
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      noise.connect(bandpass);
      bandpass.connect(gain);
      gain.connect(context.destination);
      noise.start(now);
      noise.stop(now + 0.08);

      const oscillator = context.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(100, now);
      oscillator.frequency.exponentialRampToValueAtTime(30, now + 0.06);
      const thumpGain = context.createGain();
      thumpGain.gain.setValueAtTime(0.2, now);
      thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      oscillator.connect(thumpGain);
      thumpGain.connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.06);
    } catch {
      // Audio is optional until the browser grants a user gesture.
    }
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

  const muzzleTexture = createRadialTexture(
    64,
    { r: 255, g: 250, b: 218 },
    { r: 255, g: 92, b: 0 },
  );
  const impactTexture = createRadialTexture(
    32,
    { r: 255, g: 244, b: 174 },
    { r: 255, g: 48, b: 0 },
  );
  const muzzle = new THREE.Sprite(createSpriteMaterial(muzzleTexture, 0.95));
  muzzle.name = 'vehicle-muzzle-flash';
  muzzle.visible = false;
  muzzle.frustumCulled = false;
  root.add(muzzle);

  const tracerGeometry = new THREE.CylinderGeometry(0.08, 0.08, 3, 6, 1, true);
  const tracerMaterial = new THREE.MeshBasicMaterial({
    color: 0xffcc00,
    toneMapped: false,
  });
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

  const impacts = Array.from({ length: impactCount }, (_, index) => {
    const sprite = new THREE.Sprite(createSpriteMaterial(impactTexture, 0.8));
    sprite.name = `vehicle-impact-${index}`;
    sprite.visible = false;
    sprite.frustumCulled = false;
    sprite.userData.active = false;
    sprite.userData.timer = 0;
    root.add(sprite);
    return sprite;
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
    const tracerMaxDistance = TRACER_MAX_RANGE_M;

    muzzle.position.copy(muzzleOriginLocal);
    muzzle.scale.setScalar(0.5);
    muzzle.material.opacity = 1;
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
        impact.scale.setScalar(0.5);
        impact.material.opacity = 1;
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
      classicMaterials: true,
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
        muzzle.material.opacity = muzzleTimer / MUZZLE_LIFETIME_S;
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
      impact.material.opacity = life;
      impact.scale.setScalar(0.5 + (1 - life) * 1.5);
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
      nodeMaterials: false,
      classicMaterials: tracers[0]?.material?.isMeshBasicMaterial === true,
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
