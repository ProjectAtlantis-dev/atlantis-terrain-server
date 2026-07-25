/**
 * AT-1 "Hrim" — near-future dual-use Arctic snowcat.
 * Pearl composite + champagne bronze, AI-built logistics aesthetic.
 *
 * Coordinate system (Three.js Y-up, forward +Z):
 *   X = right, Y = up, Z = forward
 * Terrain server applies model.rotation.x = π/2 (Y-up → Z-up).
 * Road-wheel meshes must be circular in local YZ so vertex wheel-spin works.
 *
 * Named parts for vehicle registry:
 *   wheel_L0..L3, wheel_R0..R3  — road wheels (spin)
 *   body, cabin, cargo_deck, sensor_mast, glass, tracks…
 */
import * as THREE from 'three';

const PEARL = 0xe8e4dc;
const PEARL_DARK = 0xd4cfc4;
const BRONZE = 0xb08d57;
const BRONZE_LIGHT = 0xc9a66b;
const TRACK = 0x2a2a2e;
const TRACK_TREAD = 0x1a1a1c;
const GLASS = 0x4a90b8;
const EMISSIVE_BLUE = 0x6ec6ff;
const RUBBER = 0x1c1c1e;
const STEEL = 0x8a8a90;

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    metalness: opts.metalness ?? 0.35,
    roughness: opts.roughness ?? 0.45,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 0,
    transparent: opts.transparent ?? false,
    opacity: opsOpacity(opts),
    side: opts.side ?? THREE.FrontSide,
  });
}

function opsOpacity(opts) {
  return opts.opacity ?? 1;
}

function mesh(geo, material, name, pos, rot) {
  const m = new THREE.Mesh(geo, material);
  m.name = name;
  m.castShadow = true;
  m.receiveShadow = true;
  if (pos) m.position.set(pos[0], pos[1], pos[2]);
  if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
  return m;
}

/** Cylinder with axis along X (road wheel / roller). Geometry circle in YZ. */
function wheelGeo(radius, width, segments = 20) {
  const g = new THREE.CylinderGeometry(radius, radius, width, segments);
  g.rotateZ(Math.PI * 0.5);
  return g;
}

/**
 * Continuous track belt as a rounded rectangular torus-like shell
 * (stadium / capsule loop in side view).
 */
function buildTrackBelt(length, height, thickness, width) {
  const shape = new THREE.Shape();
  const hw = length * 0.5;
  const hh = height * 0.5;
  const r = Math.min(hh, hw * 0.35);

  // Outer stadium path (clockwise)
  shape.moveTo(-hw + r, -hh);
  shape.lineTo(hw - r, -hh);
  shape.absarc(hw - r, 0, r, -Math.PI * 0.5, Math.PI * 0.5, false);
  shape.lineTo(-hw + r, hh);
  shape.absarc(-hw + r, 0, r, Math.PI * 0.5, Math.PI * 1.5, false);

  const hole = new THREE.Path();
  const ir = Math.max(0.05, r - thickness);
  const ih = Math.max(0.04, hh - thickness);
  const iw = hw - thickness;
  hole.moveTo(-iw + ir, -ih);
  hole.absarc(-iw + ir, 0, ir, Math.PI * 1.5, Math.PI * 0.5, true);
  hole.lineTo(iw - ir, ih);
  hole.absarc(iw - ir, 0, ir, Math.PI * 0.5, -Math.PI * 0.5, true);
  hole.lineTo(-iw + ir, -ih);
  shape.holes.push(hole);

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width,
    bevelEnabled: false,
    curveSegments: 12,
  });
  // Shape is in XY; extrude along Z. Reorient: belt runs along Z, sits in XZ, thin in X later.
  geo.rotateY(Math.PI * 0.5); // extrude depth → X
  geo.rotateZ(Math.PI * 0.5); // stadium long axis → Z (forward)
  geo.center();
  return geo;
}

/**
 * @returns {THREE.Group} root group named arctic_snowcat
 */
export function createArcticSnowcat() {
  const root = new THREE.Group();
  root.name = 'arctic_snowcat';

  const pearl = mat(PEARL, { metalness: 0.25, roughness: 0.38 });
  const pearlDark = mat(PEARL_DARK, { metalness: 0.3, roughness: 0.42 });
  const bronze = mat(BRONZE, { metalness: 0.75, roughness: 0.32 });
  const bronzeLight = mat(BRONZE_LIGHT, { metalness: 0.8, roughness: 0.28 });
  const trackMat = mat(TRACK, { metalness: 0.15, roughness: 0.78 });
  const treadMat = mat(TRACK_TREAD, { metalness: 0.1, roughness: 0.85 });
  const glassMat = mat(GLASS, {
    metalness: 0.15,
    roughness: 0.12,
    transparent: true,
    opacity: 0.55,
  });
  const emissive = mat(0x1a3040, {
    metalness: 0.4,
    roughness: 0.3,
    emissive: EMISSIVE_BLUE,
    emissiveIntensity: 0.85,
  });
  const rubber = mat(RUBBER, { metalness: 0.05, roughness: 0.9 });
  const steel = mat(STEEL, { metalness: 0.65, roughness: 0.4 });

  // ── Dimensions (meters, design units ≈ real) ─────────────────────────
  const bodyLen = 5.2;
  const bodyW = 2.35;
  const bodyH = 0.95;
  const cabinLen = 2.15;
  const cabinW = 2.15;
  const cabinH = 1.35;
  const trackLen = 4.6;
  const trackH = 0.95;
  const trackW = 0.62;
  const trackSide = bodyW * 0.5 + trackW * 0.35;
  const wheelR = 0.28;
  const wheelW = 0.22;

  // ── Main hull ────────────────────────────────────────────────────────
  const hull = mesh(
    new THREE.BoxGeometry(bodyW * 0.92, bodyH, bodyLen),
    pearl,
    'body',
    [0, bodyH * 0.5 + 0.55, -0.15]
  );
  // Soften: bevel-ish by adding slightly smaller top deck plate
  const deck = mesh(
    new THREE.BoxGeometry(bodyW * 0.88, 0.08, bodyLen * 0.98),
    pearlDark,
    'body_deck',
    [0, bodyH + 0.55, -0.15]
  );
  root.add(hull, deck);

  // Nose / front bumper bronze
  const nose = mesh(
    new THREE.BoxGeometry(bodyW * 0.85, bodyH * 0.55, 0.35),
    bronze,
    'nose',
    [0, 0.75, bodyLen * 0.42]
  );
  root.add(nose);

  // Front skid plate
  const skid = mesh(
    new THREE.BoxGeometry(bodyW * 0.7, 0.08, 0.9),
    bronzeLight,
    'skid',
    [0, 0.42, bodyLen * 0.38]
  );
  root.add(skid);

  // ── Cabin (forward) ──────────────────────────────────────────────────
  const cabinZ = bodyLen * 0.12;
  const cabinY = bodyH + 0.55;
  const cabin = mesh(
    new THREE.BoxGeometry(cabinW, cabinH * 0.55, cabinLen),
    pearl,
    'cabin',
    [0, cabinY + cabinH * 0.28, cabinZ]
  );
  root.add(cabin);

  // Glass canopy (slightly inset, taller front)
  const windshield = mesh(
    new THREE.BoxGeometry(cabinW * 0.92, cabinH * 0.72, 0.08),
    glassMat,
    'glass_windshield',
    [0, cabinY + cabinH * 0.42, cabinZ + cabinLen * 0.48]
  );
  const glassL = mesh(
    new THREE.BoxGeometry(0.06, cabinH * 0.55, cabinLen * 0.75),
    glassMat,
    'glass_left',
    [-cabinW * 0.48, cabinY + cabinH * 0.38, cabinZ + 0.05]
  );
  const glassR = mesh(
    new THREE.BoxGeometry(0.06, cabinH * 0.55, cabinLen * 0.75),
    glassMat,
    'glass_right',
    [cabinW * 0.48, cabinY + cabinH * 0.38, cabinZ + 0.05]
  );
  const glassRoof = mesh(
    new THREE.BoxGeometry(cabinW * 0.7, 0.05, cabinLen * 0.55),
    glassMat,
    'glass_roof',
    [0, cabinY + cabinH * 0.72, cabinZ + 0.1]
  );
  root.add(windshield, glassL, glassR, glassRoof);

  // Bronze window frames (simple rails)
  for (const side of [-1, 1]) {
    root.add(
      mesh(
        new THREE.BoxGeometry(0.05, cabinH * 0.65, cabinLen * 0.9),
        bronze,
        side < 0 ? 'frame_left' : 'frame_right',
        [side * cabinW * 0.5, cabinY + cabinH * 0.35, cabinZ]
      )
    );
  }
  root.add(
    mesh(
      new THREE.BoxGeometry(cabinW * 0.95, 0.06, 0.06),
      bronze,
      'frame_top',
      [0, cabinY + cabinH * 0.68, cabinZ + cabinLen * 0.45]
    )
  );

  // Side mirrors
  for (const side of [-1, 1]) {
    root.add(
      mesh(
        new THREE.BoxGeometry(0.12, 0.08, 0.18),
        bronzeLight,
        side < 0 ? 'mirror_L' : 'mirror_R',
        [side * (cabinW * 0.55), cabinY + cabinH * 0.35, cabinZ + cabinLen * 0.35]
      )
    );
  }

  // ── Rear cargo deck ──────────────────────────────────────────────────
  const cargoLen = 2.4;
  const cargoZ = -bodyLen * 0.28;
  const cargo = mesh(
    new THREE.BoxGeometry(bodyW * 0.9, 0.12, cargoLen),
    pearlDark,
    'cargo_deck',
    [0, bodyH + 0.62, cargoZ]
  );
  root.add(cargo);

  // Cargo hatch grid (6 modules)
  const hatchGeo = new THREE.BoxGeometry(0.55, 0.06, 0.7);
  let hi = 0;
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const hx = (col - 1) * 0.65;
      const hz = cargoZ + (row - 0.5) * 0.85;
      root.add(
        mesh(hatchGeo, pearl, `cargo_hatch_${hi}`, [hx, bodyH + 0.72, hz])
      );
      // yellow lock nubs
      root.add(
        mesh(
          new THREE.BoxGeometry(0.12, 0.04, 0.12),
          mat(0xc9a227, { metalness: 0.5, roughness: 0.4 }),
          `cargo_lock_${hi}`,
          [hx, bodyH + 0.78, hz + 0.22]
        )
      );
      hi++;
    }
  }

  // Side cargo rails (bronze)
  for (const side of [-1, 1]) {
    root.add(
      mesh(
        new THREE.BoxGeometry(0.06, 0.18, cargoLen * 0.95),
        bronze,
        side < 0 ? 'rail_L' : 'rail_R',
        [side * bodyW * 0.46, bodyH + 0.78, cargoZ]
      )
    );
  }

  // Rear ramp lip
  root.add(
    mesh(
      new THREE.BoxGeometry(bodyW * 0.75, 0.08, 0.25),
      bronze,
      'rear_ramp',
      [0, bodyH + 0.55, cargoZ - cargoLen * 0.52]
    )
  );

  // ── Sensor mast ──────────────────────────────────────────────────────
  const mastBaseY = cabinY + cabinH * 0.72;
  const mast = mesh(
    new THREE.CylinderGeometry(0.12, 0.16, 0.55, 12),
    bronzeLight,
    'sensor_mast',
    [0, mastBaseY + 0.35, cabinZ - 0.15]
  );
  const dome = mesh(
    new THREE.SphereGeometry(0.22, 16, 12),
    pearl,
    'sensor_dome',
    [0, mastBaseY + 0.72, cabinZ - 0.15]
  );
  const sensorBar = mesh(
    new THREE.BoxGeometry(0.45, 0.1, 0.12),
    steel,
    'sensor_optics',
    [0, mastBaseY + 0.58, cabinZ + 0.05]
  );
  // binocular lenses
  for (const side of [-1, 1]) {
    root.add(
      mesh(
        new THREE.CylinderGeometry(0.05, 0.05, 0.08, 10),
        mat(0x111118, { metalness: 0.3, roughness: 0.2 }),
        side < 0 ? 'lens_L' : 'lens_R',
        [side * 0.1, mastBaseY + 0.58, cabinZ + 0.12]
      )
    );
  }
  root.add(mast, dome, sensorBar);

  // Roof antenna
  root.add(
    mesh(
      new THREE.CylinderGeometry(0.015, 0.015, 0.55, 6),
      steel,
      'antenna',
      [0.55, mastBaseY + 0.35, cabinZ - 0.4]
    )
  );

  // ── Emissive light strips ────────────────────────────────────────────
  const stripGeo = new THREE.BoxGeometry(0.08, 0.04, 1.4);
  for (const side of [-1, 1]) {
    root.add(
      mesh(stripGeo, emissive, side < 0 ? 'nav_strip_L' : 'nav_strip_R', [
        side * bodyW * 0.48,
        bodyH + 0.7,
        cargoZ,
      ])
    );
  }
  // Cabin roof light bar
  root.add(
    mesh(
      new THREE.BoxGeometry(0.9, 0.05, 0.08),
      emissive,
      'cabin_lightbar',
      [0, cabinY + cabinH * 0.7, cabinZ + cabinLen * 0.35]
    )
  );
  // Headlight units
  for (const side of [-1, 1]) {
    root.add(
      mesh(
        new THREE.BoxGeometry(0.18, 0.12, 0.08),
        emissive,
        side < 0 ? 'headlight_L' : 'headlight_R',
        [side * 0.55, 0.95, bodyLen * 0.48]
      )
    );
  }

  // ── Tracks + road wheels ─────────────────────────────────────────────
  const trackY = 0.55;
  const beltGeo = buildTrackBelt(trackLen, trackH, 0.12, trackW);

  for (const side of [-1, 1]) {
    const sx = side * trackSide;
    const belt = mesh(beltGeo, trackMat, side < 0 ? 'track_belt_L' : 'track_belt_R', [
      sx,
      trackY,
      0,
    ]);
    root.add(belt);

    // Tread blocks along bottom
    for (let i = 0; i < 10; i++) {
      const tz = -trackLen * 0.4 + i * (trackLen * 0.8) / 9;
      root.add(
        mesh(
          new THREE.BoxGeometry(trackW * 0.85, 0.07, 0.14),
          treadMat,
          `tread_${side < 0 ? 'L' : 'R'}_${i}`,
          [sx, trackY - trackH * 0.42, tz]
        )
      );
    }

    // Drive sprocket (front-ish) + idler (rear)
    const sprocketR = 0.32;
    const sprocket = mesh(
      wheelGeo(sprocketR, wheelW * 1.1, 16),
      steel,
      side < 0 ? 'sprocket_L' : 'sprocket_R',
      [sx, trackY + 0.05, trackLen * 0.32]
    );
    const idler = mesh(
      wheelGeo(0.26, wheelW, 14),
      steel,
      side < 0 ? 'idler_L' : 'idler_R',
      [sx, trackY + 0.08, -trackLen * 0.34]
    );
    root.add(sprocket, idler);

    // Road wheels (named for spin system) — 4 per side
    const roadZs = [-1.35, -0.45, 0.45, 1.25];
    for (let i = 0; i < roadZs.length; i++) {
      const wname = side < 0 ? `wheel_L${i}` : `wheel_R${i}`;
      const w = mesh(
        wheelGeo(wheelR, wheelW, 18),
        rubber,
        wname,
        [sx, trackY - 0.12, roadZs[i]]
      );
      // hub cap
      const hub = mesh(
        wheelGeo(wheelR * 0.45, wheelW * 1.05, 12),
        steel,
        `${wname}_hub`,
        [sx, trackY - 0.12, roadZs[i]]
      );
      root.add(w, hub);
    }

    // Track side skirts / bronze guards
    root.add(
      mesh(
        new THREE.BoxGeometry(0.06, trackH * 0.55, trackLen * 0.85),
        bronze,
        side < 0 ? 'track_guard_L' : 'track_guard_R',
        [sx + side * trackW * 0.45, trackY + 0.15, 0]
      )
    );
  }

  // ── Suspension arms (visual) ─────────────────────────────────────────
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const z = -1.35 + i * 0.9;
      root.add(
        mesh(
          new THREE.BoxGeometry(0.08, 0.08, 0.35),
          bronze,
          `susp_${side < 0 ? 'L' : 'R'}_${i}`,
          [side * (bodyW * 0.42), 0.75, z]
        )
      );
    }
  }

  // ── Military modular hardpoint blisters (restrained) ─────────────────
  for (const side of [-1, 1]) {
    root.add(
      mesh(
        new THREE.BoxGeometry(0.22, 0.18, 0.4),
        mat(0x5a6358, { metalness: 0.4, roughness: 0.55 }),
        side < 0 ? 'hardpoint_L' : 'hardpoint_R',
        [side * bodyW * 0.48, bodyH + 0.45, -0.9]
      )
    );
  }

  // Ground the model: bottom of tracks near y=0
  const bbox = new THREE.Box3().setFromObject(root);
  root.position.y -= bbox.min.y;

  // Metadata for tooling
  root.userData.sculptRuntime = {
    id: 'at1-hrim-snowcat',
    displayName: 'AT-1 Hrim Snowcat',
    realLengthM: 5.8,
    sockets: {
      cargo: { position: [0, 1.4, -1.4] },
      mast: { position: [0, 2.6, 0.6] },
    },
  };

  return root;
}

export default createArcticSnowcat;
