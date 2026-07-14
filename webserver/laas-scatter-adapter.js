// Adapter: backup VegLibrary (webserver/laas) → the AssetLibrary shape that
// procgen/scatter.ts instances. WebGPU client only. Gives the WebGPU scatter the
// full backup vegetation (30 species, TSL node materials) instead of the old
// stripped GLSL procgen library. Async because the backup library bakes atlases
// / bark / rock textures on the GPU.
import { buildVegLibrary } from './laas/vegetation/VegLibrary.ts';
import { WorldSeed } from './laas/core/Seed.ts';
import { foliageMaterial } from './laas/render/VegMaterials.ts';

// VegClass (laas/gpu/passes/Scatter.ts) → scatter category prefix. Greenland:
// keep understory dwarf shrubs / cushion plants / flowers + rocks; skip trees,
// logs, branches (treeless tundra).
function classPrefix(cls) {
  if (cls === 8 || cls === 9 || cls === 10) return 'shrub/';        // dwarf birch / niviarsiaq / crowberry
  if (cls >= 24 && cls <= 30) return 'shrub/';                       // cushion campion, avens, willow, ledum, saxifrage, roseroot, horsetail
  if (cls === 11) return 'shrub/';                                   // fern → treat as low plant
  if (cls >= 12 && cls <= 15) return 'flower/';                      // umbel/bell/daisy/cottongrass
  if (cls === 18 || cls === 19) return 'rock/boulder/';             // boulder / slab
  if (cls >= 20 && cls <= 22) return 'rock/cobble/';                // stones L/M/S
  return null;                                                       // trees(0-5), log/stump(16-17), branch(23) → skip
}

const triCount = (g) => (g?.index ? g.index.count : g?.attributes?.position?.count ?? 0) / 3;

export async function buildBackupScatterLibrary(renderer, seedN) {
  const seed = new WorldSeed(seedN >>> 0);
  const veg = await buildVegLibrary(renderer, seed);
  const kinds = new Map();
  let tris = 0;
  for (const pool of veg.pools) {
    const prefix = classPrefix(pool.cls);
    if (!prefix) continue;
    // scatter uses a mid LOD ring (real geometry, not the hero r0)
    const ring = pool.r1 ?? pool.r2 ?? pool.r0 ?? [];
    const parts = [];
    for (const p of ring) parts.push({ geo: p.geo, mat: p.make() });
    // co-located hero leaf crown, if the pool has one
    if (pool.leaf?.geo) {
      parts.push({ geo: pool.leaf.geo, mat: foliageMaterial({ color: pool.leaf.color }) });
    }
    if (parts.length === 0) continue;
    for (const p of parts) tris += triCount(p.geo);
    const living = prefix === 'shrub/' || prefix === 'flower/';
    const id = `${prefix}${pool.cls}/${pool.variant ?? 0}`;
    kinds.set(id, {
      id,
      parts,
      maxDist: living ? 320 : 700,
      scale: [0.8, 1.25],
      height: pool.height ?? 0.5,
      radius: pool.radius ?? 0.5,
      living,
    });
  }
  return { kinds, stats: { kinds: kinds.size, tris: Math.round(tris), buildMs: 0, source: 'laas' } };
}
