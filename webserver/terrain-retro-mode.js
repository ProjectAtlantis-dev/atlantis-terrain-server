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

export const RETRO_LINE_COLOR = 0xa8a8d8;
export const RETRO_FILL_COLOR = 0x000000;
export const RETRO_BACKGROUND_COLOR = 0x000000;
// Water is a flat grid at a constant world-space cell size: squares stay a
// fixed number of metres across at any altitude, which is what gives the sense
// of speed and scale when flying. No FFT, no cascades, no bathymetry capture.
export const RETRO_WATER_CELL_M = 100;
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

const GRID_VERTEX_SHADER = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  uniform vec2 uCells;
  varying vec2 vGridUv;
  void main() {
    vGridUv = uv * uCells;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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
  uniform float uHorizonFade;
  varying vec2 vGridUv;

  // Box-filtered grid coverage. Returns the fraction of the pixel footprint
  // covered by a line of relative thickness 1/density, integrated exactly, so
  // it degrades to the average instead of aliasing as the footprint grows.
  float filteredGridCoverage(vec2 p, vec2 ddxP, vec2 ddyP, float density) {
    vec2 footprint = max(abs(ddxP), abs(ddyP)) + 1e-5;
    vec2 high = p + 0.5 * footprint;
    vec2 low = p - 0.5 * footprint;
    vec2 integral = (
      floor(high) + min(fract(high) * density, 1.0)
      - floor(low) - min(fract(low) * density, 1.0)
    ) / (density * footprint);
    return 1.0 - (1.0 - integral.x) * (1.0 - integral.y);
  }

  void main() {
    #include <logdepthbuf_fragment>
    vec2 ddxP = dFdx(vGridUv);
    vec2 ddyP = dFdy(vGridUv);
    float density = max(1.0 / max(uLineWidth, 1e-4), 1.0);
    float line = filteredGridCoverage(vGridUv, ddxP, ddyP, density);

    // Once a cell is well under a pixel the filtered result is a constant tint
    // carrying no readable structure. Fading it out there keeps the horizon
    // clean and dark rather than a uniform glowing haze.
    float cellsPerPixel = max(length(ddxP), length(ddyP));
    line *= 1.0 - smoothstep(uHorizonFade, uHorizonFade * 4.0, cellsPerPixel);

    gl_FragColor = vec4(mix(uFillColor, uLineColor, line), 1.0);
  }
`;

export function createRetroGridMaterial({
  lineColor = RETRO_LINE_COLOR,
  fillColor = RETRO_FILL_COLOR,
  // Fraction of a cell the line occupies. 0.08 keeps it thin and CRT-like
  // while staying wide enough for the filter to resolve at mid distance.
  lineWidth = 0.08,
  // Cells per pixel at which the grid starts fading; beyond 4x this it is
  // fully gone. Tuned so the fade lands past the point where cells are still
  // individually readable.
  horizonFade = 0.35,
  cells = [1, 1],
  side = THREE.FrontSide,
} = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uLineColor: { value: new THREE.Color(lineColor) },
      uFillColor: { value: new THREE.Color(fillColor) },
      uLineWidth: { value: lineWidth },
      uHorizonFade: { value: horizonFade },
      uCells: { value: new THREE.Vector2(cells[0], cells[1]) },
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
  const uv = sourceGeometry?.getAttribute?.('uv');
  const index = sourceGeometry?.getIndex?.();
  if (!position || !uv || !index) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', position);
  geometry.setAttribute('uv', uv);
  geometry.setIndex(index);
  const surfaceIndices = retroSurfaceIndexCount(resolution);
  if (surfaceIndices > 0) geometry.setDrawRange(0, surfaceIndices);
  return geometry;
}

function isTerrainTileMesh(mesh) {
  return Boolean(
    mesh?.isMesh
    && mesh.userData?.tileId
    && Number.isInteger(mesh.userData?.resolution)
    && mesh.geometry?.getAttribute?.('uv'),
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
  // The plane's uv spans 0..1 across the whole extent, so cell count is extent
  // over the desired cell size. The mesh follows the camera in xy, and the
  // shader's horizon fade takes the grid to black well before the rim, so the
  // finite edge never reads as one.
  waterMaterial.uniforms.uCells.value.setScalar(
    RETRO_WATER_EXTENT_M / RETRO_WATER_CELL_M,
  );
  waterMesh.frustumCulled = false;
  proxyRoot.add(waterMesh);

  const proxies = new Map();
  // Restored before the first frame, so a reload that was left in retro mode
  // renders retro immediately instead of flashing the composited scene.
  let active = readStoredRetroMode(storage);

  function releaseProxy(proxy) {
    proxyRoot.remove(proxy);
    proxy.geometry.dispose();
  }

  function sync({ cameraLocalX = 0, cameraLocalY = 0 } = {}) {
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
        proxy.userData.cells = Math.max(1, mesh.userData.resolution - 1);
        // One shared material serves every tile; the per-tile cell count is
        // uploaded just before this mesh's draw call.
        proxy.onBeforeRender = () => {
          terrainMaterial.uniforms.uCells.value.setScalar(proxy.userData.cells);
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
    terrainMaterial,
    sync,
    setActive,
    toggle: () => setActive(!active),
    get active() { return active; },
    get proxyCount() { return proxies.size; },
    dispose() {
      clear();
      waterMesh.geometry.dispose();
      terrainMaterial.dispose();
      waterMaterial.dispose();
    },
  };
}
