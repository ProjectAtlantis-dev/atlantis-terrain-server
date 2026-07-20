import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';
import { Uniform, Vector2, Vector3 } from 'three';

const fragmentShader = /* glsl */ `
  uniform sampler2D sceneBuffer;
  uniform vec2 sunUv;
  uniform float aspectRatio;
  uniform float intensity;
  uniform float thresholdLevel;
  uniform float thresholdRange;
  uniform float sunVisible;

  float softDisc(vec2 uv, vec2 center, float radius, float softness) {
    vec2 delta = uv - center;
    delta.x *= aspectRatio;
    return 1.0 - smoothstep(radius, radius + softness, length(delta));
  }

  void mainImage(const vec4 inputColor, const vec2 uv, out vec4 outputColor) {
    vec2 delta = uv - sunUv;
    delta.x *= aspectRatio;
    float radius = length(delta);

    // Use the already-resolved HDR sun pixel as a cheap cloud-visibility
    // signal. Every fragment reads the same texel, so this is cache-friendly
    // and replaces the old full-frame threshold + blur pyramid.
    vec3 source = texture(sceneBuffer, clamp(sunUv, vec2(0.0), vec2(1.0))).rgb;
    float sourceLuminance = max(max(source.r, source.g), source.b);
    float sourceGate = smoothstep(
      thresholdLevel,
      thresholdLevel + max(thresholdRange, 1e-3),
      sourceLuminance
    );
    float terrainGate = step(0.999999, readDepth(clamp(sunUv, vec2(0.0), vec2(1.0))));
    float edgeGate = smoothstep(-0.08, 0.04, sunUv.x)
      * smoothstep(-0.08, 0.04, sunUv.y)
      * smoothstep(-0.08, 0.04, 1.0 - sunUv.x)
      * smoothstep(-0.08, 0.04, 1.0 - sunUv.y);
    float visibility = sunVisible * sourceGate * terrainGate * edgeGate;

    vec3 sourceTint = source / max(sourceLuminance, 1e-4);
    vec3 warmTint = mix(vec3(1.0, 0.62, 0.28), sourceTint, 0.3);

    // Match the apparent energy of the old HDR bloom. Its 0.005 default was
    // applied to a blurred, very bright sun texture; applying that number
    // directly to normalized analytic colors left only a pin-sized core.
    float flareGain = intensity * 180.0;
    float disc = softDisc(uv, sunUv, 0.012, 0.007) * 12.0;
    float innerGlow = exp2(-radius * radius * 450.0) * 3.5;
    float outerGlow = exp2(-radius * 14.0) * 1.2;
    float rays = pow(abs(cos(atan(delta.y, delta.x) * 4.0)), 28.0)
      * exp2(-radius * 20.0) * 1.4;

    // A few analytic internal-reflection ghosts along the sun-to-lens axis.
    vec2 lensAxis = vec2(0.5) - sunUv;
    float ghostA = softDisc(uv, sunUv + lensAxis * 0.55, 0.018, 0.025) * 0.8;
    float ghostB = softDisc(uv, sunUv + lensAxis * 1.05, 0.030, 0.040) * 0.45;
    float ghostC = softDisc(uv, sunUv + lensAxis * 1.45, 0.012, 0.020) * 0.3;
    vec3 ghosts = vec3(0.3, 0.55, 1.0) * ghostA
      + vec3(1.0, 0.35, 0.12) * ghostB
      + vec3(0.45, 0.8, 1.0) * ghostC;

    vec3 flare = warmTint * (disc + innerGlow + outerGlow + rays) + ghosts;
    outputColor = vec4(inputColor.rgb + flare * flareGain * visibility, inputColor.a);
  }
`;

const viewDirection = new Vector3();
const projectedDirection = new Vector3();

export function projectSunDirectionToUv(camera, sunDirection, target = new Vector2()) {
  if (camera == null || sunDirection == null) return false;
  viewDirection.copy(sunDirection).transformDirection(camera.matrixWorldInverse);
  if (!Number.isFinite(viewDirection.z) || viewDirection.z >= -1e-6) return false;
  projectedDirection.copy(viewDirection).applyMatrix4(camera.projectionMatrix);
  if (!Number.isFinite(projectedDirection.x) || !Number.isFinite(projectedDirection.y)) return false;
  target.set(projectedDirection.x * 0.5 + 0.5, projectedDirection.y * 0.5 + 0.5);
  return true;
}

export class TerrainSunFlareEffect extends Effect {
  constructor({ intensity = 0.005, thresholdLevel = 10, thresholdRange = 1 } = {}) {
    const uniforms = new Map([
      ['sceneBuffer', new Uniform(null)],
      ['sunUv', new Uniform(new Vector2(0.5, 0.5))],
      ['aspectRatio', new Uniform(1)],
      ['intensity', new Uniform(intensity)],
      ['thresholdLevel', new Uniform(thresholdLevel)],
      ['thresholdRange', new Uniform(thresholdRange)],
      ['sunVisible', new Uniform(0)],
    ]);
    super('TerrainSunFlareEffect', fragmentShader, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.DEPTH,
      uniforms,
    });
    this.camera = null;
    this.sunDirection = null;
    this.edgeLatched = false;
    this.edgeVisibility = 0;
  }

  configure({ camera, sunDirection }) {
    this.camera = camera;
    this.sunDirection = sunDirection;
  }

  update(_renderer, inputBuffer, deltaTime = 1 / 60) {
    this.uniforms.get('sceneBuffer').value = inputBuffer.texture;
    const visible = projectSunDirectionToUv(
      this.camera,
      this.sunDirection,
      this.uniforms.get('sunUv').value,
    );
    const uv = this.uniforms.get('sunUv').value;
    // Hysteresis prevents the moving sun from toggling on/off on adjacent
    // frames at the viewport boundary. It must enter the screen before it
    // latches on, but can travel slightly outside before it latches off.
    const margin = this.edgeLatched ? 0.075 : -0.015;
    this.edgeLatched = visible
      && uv.x >= -margin && uv.x <= 1 + margin
      && uv.y >= -margin && uv.y <= 1 + margin;
    const target = this.edgeLatched ? 1 : 0;
    const seconds = Number.isFinite(deltaTime) && deltaTime > 0 ? deltaTime : 1 / 60;
    const timeConstant = target > this.edgeVisibility ? 0.10 : 0.18;
    const blend = 1 - Math.exp(-seconds / timeConstant);
    this.edgeVisibility += (target - this.edgeVisibility) * blend;
    this.uniforms.get('sunVisible').value = this.edgeVisibility;
  }

  setSize(width, height) {
    this.uniforms.get('aspectRatio').value = height > 0 ? width / height : 1;
  }

  get intensity() { return this.uniforms.get('intensity').value; }
  set intensity(value) { this.uniforms.get('intensity').value = value; }
  get thresholdLevel() { return this.uniforms.get('thresholdLevel').value; }
  set thresholdLevel(value) { this.uniforms.get('thresholdLevel').value = value; }
  get thresholdRange() { return this.uniforms.get('thresholdRange').value; }
  set thresholdRange(value) { this.uniforms.get('thresholdRange').value = value; }
}
