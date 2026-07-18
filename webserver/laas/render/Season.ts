/**
 * Runtime, UI-switchable season (spring / summer / autumn / winter).
 *
 * `seasonU.spring|autumn|winter` are live uniforms in [0,1] (summer = all 0),
 * read directly by the terrain, grass and foliage shaders, so the season changes
 * with no reload. They initialise from GREENLAND_SEASON (the ?season= URL param)
 * so boot / screenshots pick the right season, and the on-screen switcher drives
 * them live. Foliage geometry/atlas tints are baked at boot, but the shader-side
 * `seasonFoliageTint()` recolors them live on top, so the meshes follow too.
 */

import { float, mix, vec3 } from 'three/tsl';
import { runiform } from '../gpu/RenderUniform';
import type { NF, NV3 } from '../gpu/TSLTypes';
import { AUTUMN, SPRING, WINTER } from '../world/WorldConst';
import { bootQuery } from '../core/BootQuery';

export const seasonU = {
  spring: runiform(SPRING),
  autumn: runiform(AUTUMN),
  winter: runiform(WINTER),
};

export type SeasonName = 'spring' | 'summer' | 'autumn' | 'winter';

let current: SeasonName = SPRING
  ? 'spring'
  : WINTER
    ? 'winter'
    : AUTUMN
      ? 'autumn'
      : 'summer';

export function currentSeason(): SeasonName {
  return current;
}

export function setSeason(name: SeasonName): void {
  current = name;
  seasonU.spring.value = name === 'spring' ? 1 : 0;
  seasonU.autumn.value = name === 'autumn' ? 1 : 0;
  seasonU.winter.value = name === 'winter' ? 1 : 0;
}

/**
 * Live foliage recolor for LEAF/stem parts (never petals): fresh vivid green in
 * spring, warm rust/gold in autumn, desaturated frost-dormant in winter. Summer
 * passes through. Applied in the material shaders so mesh plants follow the UI.
 */
export function seasonFoliageTint(base: NV3): NV3 {
  const springC = base.mul(vec3(0.85, 1.28, 0.8)).add(vec3(0.0, 0.025, 0.0));
  const autumnC = base.mul(vec3(1.6, 0.8, 0.35)).add(vec3(0.09, 0.02, 0.0));
  const lum = base.dot(vec3(0.34, 0.4, 0.26));
  const frost = mix(base, vec3(lum, lum, lum).add(0.14) as unknown as NV3, 0.6) as NV3;
  let c = mix(base, springC, seasonU.spring) as NV3;
  c = mix(c, autumnC, seasonU.autumn) as NV3;
  c = mix(c, frost, seasonU.winter.mul(0.75)) as NV3;
  return c;
}

/**
 * Bloom presence by season, [0,1]: full in summer, partial in spring (early
 * bloomers), faded in autumn (mostly seeded), NONE in winter. One season is ever
 * active, so the subtractions don't stack.
 */
export function seasonBloom(): NF {
  return float(1)
    .sub(seasonU.spring.mul(0.4))
    .sub(seasonU.autumn.mul(0.85))
    .sub(seasonU.winter)
    .clamp(0, 1) as unknown as NF;
}

/**
 * Seasonal flower color: a petal/bloom shows its true colour only in bloom, and
 * out of season fades to the (season-tinted) foliage colour — so there are no
 * pink flowers in winter, rust seedheads in autumn, etc. `dormant` is the plant's
 * leaf/stem colour to fall back to.
 */
export function seasonFlower(petal: NV3, dormant: NV3): NV3 {
  return mix(seasonFoliageTint(dormant), petal, seasonBloom()) as NV3;
}

/**
 * Minimal bottom-centre season switcher. Interactive app only — skipped under
 * ?freeze=1 (the screenshot tool) so captures stay clean.
 */
export function mountSeasonUI(): void {
  if (bootQuery().get('freeze') === '1') return;
  const bar = document.createElement('div');
  bar.id = 'season-ui';
  bar.style.cssText = [
    'position:fixed', 'bottom:14px', 'left:50%', 'transform:translateX(-50%)',
    'z-index:1000', 'display:flex', 'gap:6px', 'padding:5px',
    'background:rgba(8,12,10,0.55)', 'border-radius:8px',
    'font:12px/1 ui-monospace,Menlo,monospace',
  ].join(';');
  const seasons: SeasonName[] = ['spring', 'summer', 'autumn', 'winter'];
  const btns: HTMLButtonElement[] = [];
  const paint = (): void => {
    seasons.forEach((s, i) => {
      const b = btns[i];
      if (!b) return;
      const on = s === current;
      b.style.background = on ? '#3a6b4e' : 'rgba(255,255,255,0.08)';
      b.style.color = on ? '#eafff2' : '#b8c8bf';
    });
  };
  for (const s of seasons) {
    const b = document.createElement('button');
    b.textContent = `${s[0]?.toUpperCase() ?? ''}${s.slice(1)}`;
    b.style.cssText = [
      'cursor:pointer', 'border:0', 'border-radius:5px', 'padding:5px 12px',
      'font:inherit',
    ].join(';');
    b.addEventListener('click', () => {
      setSeason(s);
      paint();
    });
    bar.appendChild(b);
    btns.push(b);
  }
  document.body.appendChild(bar);
  paint();
}
