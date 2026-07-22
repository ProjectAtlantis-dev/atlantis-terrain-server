/**
 * WaterSurface — camera-following water clipmap (Phase 6).
 *
 * Six concentric square grids (128×128 cells, cell 1.5 m → 48 m) share one
 * geometry; each level snaps to a 2-cell lattice and renders the hydrology
 * water surface (Heightfield.waterY) through WaterMaterial. A level discards
 * fragments inside the next-finer level's exact world rect, so coverage is
 * seamless without geometric stitching: every level samples the SAME
 * bilinear field, so boundary mismatches are sub-millimeter.
 *
 * Dry cells hold waterY ≈ bed − 2 m, so the sheet dives under the terrain
 * everywhere there is no water — those fragments lose the depth test and
 * cost nothing. Shorelines are the bilinear crossing between wet and dry
 * texels, feathered by the material's depth-based opacity.
 */

import { BufferAttribute, BufferGeometry, Group, Mesh, Vector2, Vector4 } from 'three';
import type { PerspectiveCamera } from 'three';
import type { StorageTexture } from 'three/webgpu';
import type { ProbeGI } from '../gpu/passes/ProbeGI';
import type { NV2, NV4 } from '../gpu/TSLTypes';
import { waterMaterial } from '../render/WaterMaterial';
import type { Atmosphere } from '../sky/Atmosphere';
import type { Heightfield } from './Heightfield';
import { runiform } from '../gpu/RenderUniform';

const CELLS = 128; // cells per level edge (verts = CELLS+1)
const LEVEL_CELL = [1.5, 3, 6, 12, 24, 48]; // m — outermost spans ±3.07 km

function gridGeometry(): BufferGeometry {
  const n = CELLS + 1;
  const pos = new Float32Array(n * n * 3);
  const nrm = new Float32Array(n * n * 3);
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = (z * n + x) * 3;
      pos[i] = x - CELLS / 2;
      pos[i + 1] = 0;
      pos[i + 2] = z - CELLS / 2;
      nrm[i + 1] = 1;
    }
  }
  const idx = new Uint32Array(CELLS * CELLS * 6);
  let k = 0;
  for (let z = 0; z < CELLS; z++) {
    for (let x = 0; x < CELLS; x++) {
      const a = z * n + x;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = d;
      idx[k++] = a; idx[k++] = d; idx[k++] = b;
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  return g;
}

interface Level {
  origin: { value: Vector2 };
  innerRect: { value: Vector4 };
  cell: number;
}

export class WaterSurface {
  readonly group = new Group();
  private readonly lvls: Level[] = [];

  constructor(
    hf: Heightfield,
    atm: Atmosphere,
    canopyTex: StorageTexture | null,
    gi: ProbeGI | null,
  ) {
    const geo = gridGeometry();
    for (const cell of LEVEL_CELL) {
      const origin = runiform(new Vector2());
      const innerRect = runiform(new Vector4(1e9, 1e9, -1e9, -1e9));
      const mat = waterMaterial(hf, atm, canopyTex, gi, {
        origin: origin as unknown as NV2,
        innerRect: innerRect as unknown as NV4,
        cell,
        far: cell >= 12, // ≥ ±384 m: min-reduced field
      });
      const mesh = new Mesh(geo, mat);
      mesh.frustumCulled = false; // positions are shader-driven
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.lvls.push({
        origin: origin as unknown as Level['origin'],
        innerRect: innerRect as unknown as Level['innerRect'],
        cell,
      });
    }
  }

  update(cam: PerspectiveCamera): void {
    let prev: Vector4 | null = null;
    for (const lvl of this.lvls) {
      const snap = lvl.cell * 2;
      const ox = Math.floor(cam.position.x / snap) * snap;
      const oz = Math.floor(cam.position.z / snap) * snap;
      lvl.origin.value.set(ox, oz);
      if (prev) lvl.innerRect.value.copy(prev);
      else lvl.innerRect.value.set(1e9, 1e9, -1e9, -1e9);
      const h = (CELLS / 2) * lvl.cell;
      prev = new Vector4(ox - h, oz - h, ox + h, oz + h);
    }
  }
}
