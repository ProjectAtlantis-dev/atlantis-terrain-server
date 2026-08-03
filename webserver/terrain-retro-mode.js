import * as THREE from 'three';

// Retro wireframe presentation: the heightmap mesh as a glowing grid on black,
// with no imagery, no atmosphere, and no lighting.
//
// The mode renders its OWN scene rather than restyling the live one. Tile
// materials are never touched, so the texture streamer keeps writing `.map` to
// the real materials while retro is active (terrain-tile-set.js:788) and normal
// mode resumes with nothing to repair. Proxy meshes share the source tiles'
// attribute buffers and index, so a proxy costs a JS object and no GPU memory.
//
// Grid lines come from the tile's existing `uv` attribute in the fragment
// shader, not from generated line geometry. That is the whole performance
// story: the fine mesh costs nothing per tile and, unlike the tile-boundary
// gridlines controller, nothing rebuilds when a neighbouring tile changes.

export const RETRO_MODE_STORAGE_KEY = 'terrain-retro-mode';

// Storage access is wrapped because Safari private browsing throws on both
// read and write; a persistence failure must never keep the mode from working.
export function readStoredRetroMode(storage) {
  try {
    return storage?.getItem(RETRO_MODE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeStoredRetroMode(storage, active) {
  try {
    storage?.setItem(RETRO_MODE_STORAGE_KEY, active ? '1' : '0');
  } catch {
    // Preference is cosmetic; losing it is not worth breaking the toggle.
  }
}

// Star field. Seeded so the sky is identical on every load rather than
// reshuffling, and placed on a sphere that rides with the camera position but
// never its rotation — stars therefore hold still as you fly and sweep
// correctly as you turn, which is what reads as "infinitely far away".
export const RETRO_STAR_COUNT = 1600;
// Comfortably inside the 50 km far plane so no star is ever clipped away.
export const RETRO_STAR_RADIUS_M = 30000;
export const RETRO_STAR_SEED = 0x5eed1e;
// Size range in device pixels. A real sky is overwhelmingly faint pinpricks
// with a handful of bright ones, so magnitudes follow a power law rather than
// a uniform spread — a uniform one reads as static, not stars.
// Kept at or above 1 px: smaller point sizes get clamped or dropped outright
// by some drivers, so sub-pixel stars would flicker rather than sit faint.
export const RETRO_STAR_MIN_PIXELS = 1;
export const RETRO_STAR_MAX_PIXELS = 2.6;
export const RETRO_STAR_MAGNITUDE_EXPONENT = 2;

export const RETRO_LINE_COLOR = 0xa8a8d8;
export const RETRO_FILL_COLOR = 0x000000;
export const RETRO_BACKGROUND_COLOR = 0x000000;
// One fixed grid spacing everywhere, shared by terrain and water so the two
// read as a single continuous world grid rather than two systems meeting at
// the shoreline. Distant tiles are hidden by the fade below rather than by
// changing the grid, so spacing never shifts under the camera.
export const RETRO_CELL_M = 100;
// Distance fade, in metres, standing in for fog: the grid is at full strength
// out to the start and gone by the end.
export const RETRO_FADE_START_M = 14000;
export const RETRO_FADE_END_M = 38000;
// Must stay comfortably inside the camera's far plane (50 km). An oversized
// plane is not merely wasteful: spanning far beyond `far` with a handful of
// vertices makes logarithmic-depth interpolation across each triangle so
// ill-conditioned that the plane wins the depth test against terrain standing
// hundreds of metres in front of it, and the sea paints over the land.
export const RETRO_WATER_EXTENT_M = 80000;
// Subdividing keeps per-triangle depth interpolation well conditioned. The
// grid itself is drawn in the fragment shader, so this costs geometry only,
// not detail.
export const RETRO_WATER_SEGMENTS = 128;

// The grid is keyed to scene-frame metres, never to the tile's uv. Tiles all
// carry resolution 65 while their ground footprint quadruples per LOD step, so
// a uv-derived grid changes cell size whenever the LOD under the camera
// changes — the granularity visibly repops as you fly, and cells do not line
// up across a depth-8/depth-12 boundary. Metres fix both: one continuous grid
// across the whole world, independent of tiling.
//
// `position.xy` is already floating-origin scene metres (the mesh builder
// writes tile bbox coordinates straight into the attribute), and uGridOffset
// adds the mesh's own translation. Deliberately not modelMatrix: that carries
// the ECEF frame, whose magnitudes destroy float precision in-shader.
const GRID_VERTEX_SHADER = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  uniform vec2 uGridOffset;
  varying vec2 vWorldXY;
  varying float vViewDistance;
  void main() {
    vWorldXY = position.xy + uGridOffset;
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    vViewDistance = length(viewPosition.xyz);
    gl_Position = projectionMatrix * viewPosition;
    #include <logdepthbuf_vertex>
  }
`;

// Opaque fill plus a filtered line, so the ordinary depth buffer does the
// hidden-surface removal: a ridge in front writes depth and the grid behind it
// is simply never shaded.
//
// The line is analytically box-filtered over the pixel footprint rather than
// point-sampled through fract(). This is the part that matters at distance: a
// naive fract()/fwidth() grid keeps drawing full-contrast lines after a cell
// shrinks below one pixel, and the beat between the cell period and the pixel
// grid reads as moire crawling over the horizon. Integrating coverage instead
// makes shrinking cells converge to their true average — distant terrain fades
// to a flat tint and simply stops resolving, which is what we want.
const GRID_FRAGMENT_SHADER = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uLineColor;
  uniform vec3 uFillColor;
  uniform float uLineWidth;
  uniform float uCellSizeM;
  uniform float uFadeStartM;
  uniform float uFadeEndM;
  varying vec2 vWorldXY;
  varying float vViewDistance;

  // Line coverage at a constant width in PIXELS, not as a fraction of the
  // cell. A vector display draws a fixed-width beam however far away the line
  // is; scaling thickness with the cell instead makes near lines hairline and
  // distant ones fat.
  //
  // Dividing the distance-to-line by the derivative converts it to pixels,
  // which also antialiases.
  float gridLine(vec2 metres, vec2 dx, vec2 dy, float cell, float widthPixels) {
    vec2 p = metres / cell;
    vec2 perPixel = (abs(dx) + abs(dy)) / cell;
    vec2 distance = abs(fract(p - 0.5) - 0.5) / max(perPixel, vec2(1e-6));
    float nearest = min(distance.x, distance.y);
    return 1.0 - clamp(nearest / max(widthPixels, 0.5), 0.0, 1.0);
  }

  void main() {
    #include <logdepthbuf_fragment>
    vec2 dx = dFdx(vWorldXY);
    vec2 dy = dFdy(vWorldXY);

    // One spacing at every distance: cells never grow with range, so the grid
    // reads as a single fixed lattice laid over the world instead of tiles
    // getting coarser toward the horizon.
    float line = gridLine(vWorldXY, dx, dy, uCellSizeM, uLineWidth);

    // Distance fade stands in for fog and is what removes far terrain.
    float line_fade = 1.0 - smoothstep(uFadeStartM, uFadeEndM, vViewDistance);

    // Guard: a fixed lattice aliases into moire once cells fall under a pixel,
    // which the distance fade alone does not prevent at altitude or if the
    // fade range is widened. Dissolving the grid as cells stop being
    // resolvable keeps that impossible rather than merely unlikely.
    vec2 cellsPerPixel = (abs(dx) + abs(dy)) / max(uCellSizeM, 1e-4);
    float pixelsPerCell = 1.0 / max(max(cellsPerPixel.x, cellsPerPixel.y), 1e-6);
    float resolveFade = smoothstep(2.5, 7.0, pixelsPerCell);

    gl_FragColor = vec4(
      mix(uFillColor, uLineColor, line * line_fade * resolveFade), 1.0
    );
  }
`;

export function createRetroGridMaterial({
  lineColor = RETRO_LINE_COLOR,
  fillColor = RETRO_FILL_COLOR,
  // Beam width in pixels, held constant at every distance and altitude.
  lineWidth = 1,
  // Grid spacing in metres, identical at every range.
  cellSizeM = RETRO_CELL_M,
  fadeStartM = RETRO_FADE_START_M,
  fadeEndM = RETRO_FADE_END_M,
  side = THREE.FrontSide,
} = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uLineColor: { value: new THREE.Color(lineColor) },
      uFillColor: { value: new THREE.Color(fillColor) },
      uLineWidth: { value: lineWidth },
      uCellSizeM: { value: cellSizeM },
      uFadeStartM: { value: fadeStartM },
      uFadeEndM: { value: fadeEndM },
      uGridOffset: { value: new THREE.Vector2() },
    },
    vertexShader: GRID_VERTEX_SHADER,
    fragmentShader: GRID_FRAGMENT_SHADER,
    side,
    // Unlit and untone-mapped by design; the retro pass bypasses the composer
    // so nothing downstream would grade this anyway.
    toneMapped: false,
    fog: false,
  });
}

/**
 * Surface-only index count for a `resolution x resolution` terrain tile.
 *
 * The mesh builder emits the surface grid first and then four skirts
 * (terrain-mesh-builder.js:250-292). Skirt vertices copy their surface
 * neighbour's uv, so a skirt would smear one grid cell down its whole depth.
 * Clipping the draw range to the surface drops them cleanly.
 */
export function retroSurfaceIndexCount(resolution) {
  if (!Number.isInteger(resolution) || resolution < 2) return 0;
  return (resolution - 1) * (resolution - 1) * 6;
}

/**
 * Geometry that shares every buffer with the source tile but draws only the
 * surface. Sharing the attribute and index instances means three.js reuses the
 * same GPU buffers, so this allocates no vertex memory and stays in sync with
 * in-place heightmap rewrites (updateTerrainMeshHeightmap).
 */
export function createRetroTileGeometry(sourceGeometry, resolution) {
  const position = sourceGeometry?.getAttribute?.('position');
  const index = sourceGeometry?.getIndex?.();
  if (!position || !index) return null;
  const geometry = new THREE.BufferGeometry();
  // Position only: the grid is derived from world metres in the shader, so uv
  // is never sampled and binding it would imply a dependency that is not real.
  geometry.setAttribute('position', position);
  geometry.setIndex(index);
  const surfaceIndices = retroSurfaceIndexCount(resolution);
  if (surfaceIndices > 0) geometry.setDrawRange(0, surfaceIndices);
  return geometry;
}

// Small deterministic PRNG. Math.random would give a different sky on every
// load, which is exactly the shifting the star field is meant to avoid.
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Points on the upper half of a sphere, in the terrain tangent frame where +z
 * is up. Restricting to the upper hemisphere matters because the sea plane
 * only covers the lower one out to its own rim; a full sphere would leave
 * stars visible below the horizon past that edge.
 */
export function createRetroStarGeometry({
  count = RETRO_STAR_COUNT,
  radius = RETRO_STAR_RADIUS_M,
  seed = RETRO_STAR_SEED,
  minPixels = RETRO_STAR_MIN_PIXELS,
  maxPixels = RETRO_STAR_MAX_PIXELS,
  exponent = RETRO_STAR_MAGNITUDE_EXPONENT,
} = {}) {
  const random = mulberry32(seed);
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const brightness = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    // Uniform over the hemisphere: sampling z directly keeps density even
    // instead of bunching everything at the zenith.
    const z = random();
    const ring = Math.sqrt(Math.max(0, 1 - z * z));
    const angle = random() * Math.PI * 2;
    positions[index * 3] = Math.cos(angle) * ring * radius;
    positions[index * 3 + 1] = Math.sin(angle) * ring * radius;
    positions[index * 3 + 2] = z * radius;
    // One roll drives both size and brightness so the two stay correlated:
    // big-and-dim or tiny-and-blazing would both read as wrong. The exponent
    // pushes the bulk of the distribution toward faint.
    const magnitude = Math.pow(random(), exponent);
    sizes[index] = minPixels + magnitude * (maxPixels - minPixels);
    brightness[index] = 0.4 + magnitude * 0.6;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aStarSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aStarBrightness', new THREE.BufferAttribute(brightness, 1));
  return geometry;
}

// PointsMaterial applies a single size to every point, so varying it needs a
// shader. Attribute names are prefixed to avoid colliding with the built-ins
// three injects into the vertex prefix.
export function createRetroStarMaterial({ color = RETRO_LINE_COLOR } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) } },
    vertexShader: /* glsl */`
      attribute float aStarSize;
      attribute float aStarBrightness;
      varying float vStarBrightness;
      void main() {
        vStarBrightness = aStarBrightness;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aStarSize;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      varying float vStarBrightness;
      void main() {
        // Soft round falloff, so sub-pixel stars fade instead of popping
        // between one hard pixel and none as the view turns.
        float radius = length(gl_PointCoord - 0.5) * 2.0;
        float alpha = (1.0 - smoothstep(0.35, 1.0, radius)) * vStarBrightness;
        if (alpha <= 0.001) discard;
        gl_FragColor = vec4(uColor, alpha);
      }
    `,
    transparent: true,
    // Additive keeps overlapping faint stars from building into grey blocks
    // and gives the bright ones a little bloom against the black.
    blending: THREE.AdditiveBlending,
    // Depth test ON, despite this being the sky. three.js draws transparent
    // objects after all opaque ones and renderOrder only sorts within that
    // transparent pass, so the sky cannot be made to draw "first" — with
    // depthTest off it simply paints over mountains and sea. Testing against
    // the depth terrain already wrote is what puts the stars behind it.
    depthTest: true,
    // Still no depth writes: stars must never occlude each other or anything
    // drawn later.
    depthWrite: false,
    toneMapped: false,
  });
}

function isTerrainTileMesh(mesh) {
  return Boolean(
    mesh?.isMesh
    && mesh.userData?.tileId
    && Number.isInteger(mesh.userData?.resolution)
    && mesh.geometry?.getAttribute?.('position'),
  );
}

export function createTerrainRetroRuntime({
  terrainRoot,
  getWaterline = () => 0,
  onChanged = () => {},
  storage = globalThis.localStorage ?? null,
}) {
  const scene = new THREE.Scene();
  const background = new THREE.Color(RETRO_BACKGROUND_COLOR);
  // Mirrors terrainRoot's transform so proxies can copy each tile's local
  // matrix verbatim instead of resolving world transforms per frame.
  const proxyRoot = new THREE.Group();
  proxyRoot.matrixAutoUpdate = false;
  scene.add(proxyRoot);

  const terrainMaterial = createRetroGridMaterial();
  const waterMaterial = createRetroGridMaterial({ side: THREE.DoubleSide });

  const waterMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(
      RETRO_WATER_EXTENT_M, RETRO_WATER_EXTENT_M,
      RETRO_WATER_SEGMENTS, RETRO_WATER_SEGMENTS,
    ),
    waterMaterial,
  );
  waterMesh.frustumCulled = false;
  proxyRoot.add(waterMesh);

  // Drawn first with no depth interaction at all, so terrain and sea simply
  // paint over the sky. Nothing needs to sort against it.
  const starMaterial = createRetroStarMaterial();
  const starField = new THREE.Points(createRetroStarGeometry(), starMaterial);
  starField.frustumCulled = false;
  // Position tracks the camera so stars never translate; rotation is left
  // alone so turning the camera sweeps across them as it should.
  proxyRoot.add(starField);

  const proxies = new Map();
  // Restored before the first frame, so a reload that was left in retro mode
  // renders retro immediately instead of flashing the composited scene.
  let active = readStoredRetroMode(storage);

  function releaseProxy(proxy) {
    proxyRoot.remove(proxy);
    proxy.geometry.dispose();
  }

  function sync({ cameraLocalX = 0, cameraLocalY = 0, cameraLocalZ = 0 } = {}) {
    if (!active) return;
    terrainRoot.updateMatrix();
    proxyRoot.matrix.copy(terrainRoot.matrix);

    const seen = new Set();
    for (const mesh of terrainRoot.children) {
      if (!isTerrainTileMesh(mesh)) continue;
      const tileId = mesh.userData.tileId;
      seen.add(tileId);
      let proxy = proxies.get(tileId);
      // Geometry identity changes when a tile is rebuilt or revived from the
      // cache; rebind rather than keep drawing the retired buffers.
      if (proxy && proxy.userData.sourceGeometry !== mesh.geometry) {
        releaseProxy(proxy);
        proxies.delete(tileId);
        proxy = null;
      }
      if (!proxy) {
        const geometry = createRetroTileGeometry(mesh.geometry, mesh.userData.resolution);
        if (!geometry) continue;
        proxy = new THREE.Mesh(geometry, terrainMaterial);
        proxy.matrixAutoUpdate = false;
        proxy.userData.sourceGeometry = mesh.geometry;
        // One shared material serves every tile, so this mesh's own translation
        // is uploaded just before its draw call. Tile vertices are already
        // absolute scene metres, so the offset is normally zero; honouring it
        // anyway keeps the grid continuous if a tile is ever placed by
        // transform instead of by baked coordinates.
        proxy.onBeforeRender = () => {
          terrainMaterial.uniforms.uGridOffset.value.set(
            proxy.matrix.elements[12], proxy.matrix.elements[13],
          );
        };
        proxyRoot.add(proxy);
        proxies.set(tileId, proxy);
      }
      mesh.updateMatrix();
      proxy.matrix.copy(mesh.matrix);
      proxy.visible = mesh.visible;
    }

    for (const [tileId, proxy] of proxies) {
      if (seen.has(tileId)) continue;
      releaseProxy(proxy);
      proxies.delete(tileId);
    }

    waterMesh.position.set(cameraLocalX, cameraLocalY, getWaterline());
    waterMesh.updateMatrix();
    // The plane rides with the camera, so without this its grid would slide
    // along underneath instead of staying pinned to the world. Feeding the
    // mesh translation back in cancels the motion exactly.
    waterMaterial.uniforms.uGridOffset.value.set(cameraLocalX, cameraLocalY);

    // Recentred on the camera every frame, so flying never closes any distance
    // on the sky. Orientation is deliberately untouched.
    starField.position.set(cameraLocalX, cameraLocalY, cameraLocalZ);
  }

  function clear() {
    for (const proxy of proxies.values()) releaseProxy(proxy);
    proxies.clear();
  }

  function setActive(next) {
    const value = Boolean(next);
    if (value === active) return active;
    active = value;
    if (!active) clear();
    writeStoredRetroMode(storage, active);
    onChanged();
    return active;
  }

  return {
    scene,
    background,
    waterMesh,
    starField,
    terrainMaterial,
    sync,
    setActive,
    toggle: () => setActive(!active),
    get active() { return active; },
    get proxyCount() { return proxies.size; },
    dispose() {
      clear();
      waterMesh.geometry.dispose();
      starField.geometry.dispose();
      starMaterial.dispose();
      terrainMaterial.dispose();
      waterMaterial.dispose();
    },
  };
}
