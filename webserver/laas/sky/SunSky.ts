/**
 * SunSky — time-of-day model wiring the Atmosphere into the scene:
 * sun DirectionalLight (transmittance-tinted), sky background, and IBL
 * (PMREM re-baked from the sky on ToD changes). `[` / `]` step time live.
 */

import { Color, CubeCamera, HalfFloatType, HemisphereLight, Scene, Vector3 } from 'three';
import { DirectionalLight } from 'three';
import { positionWorldDirection } from 'three/tsl';
import { CubeRenderTarget, type Renderer } from 'three/webgpu';
import type { Engine } from '../core/Engine';
import { Atmosphere, SUN_E } from './Atmosphere';

const SUN_DISTANCE = 9000;

export class SunSky {
  readonly atmosphere: Atmosphere;
  readonly sun: DirectionalLight;
  timeOfDay: number;
  private engine: Engine;
  private iblScene: Scene;
  private iblCube: CubeRenderTarget;
  private iblCam: CubeCamera;
  private renderer: Renderer | null = null;
  private iblDirty = true;
  private sunDirWorld = new Vector3();
  private hemi!: HemisphereLight;
  /** ambient floor scale: dropped to ~0.15 when probe GI is active */
  private ambientScale = 1;

  constructor(engine: Engine, initialTod: number) {
    this.engine = engine;
    this.atmosphere = new Atmosphere();
    this.timeOfDay = initialTod;
    this.sun = new DirectionalLight(0xffffff, 5);
    this.sun.castShadow = false; // shadow setup module enables + configures
    engine.scene.add(this.sun);
    engine.scene.add(this.sun.target);

    this.iblScene = new Scene();
    this.iblCube = new CubeRenderTarget(64, { type: HalfFloatType });
    this.iblCam = new CubeCamera(0.1, 50, this.iblCube);

    // Ambient stopgap until Phase-3 probe GI: sky/ground hemisphere driven by
    // the atmosphere's CPU side. Guarantees the no-black-shadows law from day
    // one even where the env-map path underdelivers.
    this.hemi = new HemisphereLight(0x9db8e8, 0x55503e, 1);
    engine.scene.add(this.hemi);

    window.addEventListener('keydown', (e) => {
      if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
        const step = e.code === 'BracketLeft' ? -0.5 : 0.5;
        void this.setTimeOfDay((this.timeOfDay + step + 24) % 24);
        // eslint-disable-next-line no-console
        console.log(`[laas] T=${this.timeOfDay.toFixed(2)}`);
      }
    });
  }

  async init(renderer: Renderer): Promise<void> {
    this.renderer = renderer;
    await this.atmosphere.init(renderer);
    this.engine.scene.backgroundNode = this.atmosphere.backgroundNode();
    // IBL env: sky only — the sun's direct term comes from the DirectionalLight
    this.iblScene.backgroundNode = this.atmosphere.skyColor(
      positionWorldDirection.normalize(),
    );
    await this.setTimeOfDay(this.timeOfDay);
  }

  /** hours [0,24) → sun world direction (NE-mountain world: sun arcs S) */
  static sunDirection(t: number, out: Vector3): Vector3 {
    const dayT = (t - 5.4) / (20.6 - 5.4); // 0..1 across daylight
    const elev = Math.sin(Math.PI * Math.min(Math.max(dayT, 0.001), 0.999)) * 1.02 - 0.085;
    const az = -0.6 + dayT * 2.4; // east → south → west sweep (radians)
    const y = Math.sin(Math.max(elev, -0.12));
    const c = Math.cos(Math.max(elev, -0.12));
    out.set(c * Math.cos(az), y, c * Math.sin(az));
    return out.normalize();
  }

  async setTimeOfDay(t: number): Promise<void> {
    this.timeOfDay = t;
    SunSky.sunDirection(t, this.sunDirWorld);
    await this.atmosphere.setSun(this.sunDirWorld);

    const [tr, tg, tb] = this.atmosphere.sunTransmittanceCpu(this.sunDirWorld);
    const lum = 0.2126 * tr + 0.7152 * tg + 0.0722 * tb;
    const above = Math.max(0, Math.min(1, (this.sunDirWorld.y + 0.03) / 0.06));
    this.sun.intensity = SUN_E * lum * above;
    const m = Math.max(tr, tg, tb) || 1;
    this.sun.color = new Color(tr / m, tg / m, tb / m);
    this.sun.position.copy(this.sunDirWorld).multiplyScalar(SUN_DISTANCE);
    this.sun.target.position.set(0, 0, 0);

    // hemisphere ambient ≈ sky irradiance: cool zenith, warm-gray ground
    // bounce; dims and warms with the sun's transmittance through the day
    const day = above * lum;
    const warm = 1 - Math.min(1, Math.max(0, this.sunDirWorld.y * 3));
    this.hemi.intensity = SUN_E * (0.085 + 0.1 * day) * this.ambientScale;
    this.hemi.color = new Color(
      0.34 + 0.25 * warm * 0.4,
      0.45 + 0.08 * warm * 0.2,
      0.78 - 0.12 * warm,
    );
    this.hemi.groundColor = new Color(
      0.36 + 0.2 * warm,
      0.33 + 0.08 * warm,
      0.26,
    );

    this.iblDirty = true;
    await this.refreshIBL();
  }

  /** probe GI active: hemisphere becomes a small safety floor only */
  dimAmbientForGI(): void {
    this.ambientScale = 0.15;
    this.hemi.intensity *= 0.15;
  }

  /** re-bake the environment cube from the sky (ToD changes only) */
  private async refreshIBL(): Promise<void> {
    if (!this.renderer || !this.iblDirty) return;
    this.iblDirty = false;
    this.iblCam.update(this.renderer as unknown as Parameters<CubeCamera['update']>[0], this.iblScene);
    // WebGPU environment pipeline PMREMs cube textures internally
    this.engine.scene.environment = this.iblCube.texture;
    this.engine.scene.environmentIntensity = 1.0;
  }
}
