export function configureTerrainClouds({
  effect,
  LocalWeather,
  CloudShape,
  CloudShapeDetail,
  Turbulence,
} = {}) {
  if (!installTerrainCloudHistoryReset(effect)) {
    console.warn(
      'terrain clouds: history-reset shader patch did not install; sun changes '
      + 'will leave Bayer-grid ghosts (did takram cloudsResolve.frag change?)',
    );
  }
  effect.qualityPreset = 'high';
  effect.coverage = 0.28;
  const altitudes = [1550, 1800, 8300, 9100];
  for (let index = 0; index < altitudes.length; index += 1) {
    effect.cloudLayers[index].altitude = altitudes[index];
  }
  const cirrus = effect.cloudLayers[3];
  Object.assign(cirrus, {
    height: 400,
    densityScale: 0,
    shapeAmount: 0.3,
    shapeDetailAmount: 0,
    weatherExponent: 1,
    shapeAlteringBias: 0.35,
    coverageFilterWidth: 0.5,
  });
  effect.localWeatherVelocity.set(0.00004, 0);
  effect.shapeVelocity.set(0, 0, 0);
  effect.shapeDetailVelocity.set(0, 0, 0);
  Object.assign(effect.shadow, {
    maxFar: 1e5,
    farScale: 0.25,
    minTransmittance: 1e-5,
    opticalDepthTailScale: 3,
  });
  effect.localWeatherTexture = new LocalWeather();
  effect.shapeTexture = new CloudShape();
  effect.shapeDetailTexture = new CloudShapeDetail();
  effect.turbulenceTexture = new Turbulence();
  return {
    scattering: effect.scatteringCoefficient,
    absorption: effect.absorptionCoefficient,
  };
}

const cloudHistoryResetUniforms = new WeakMap();

export function installTerrainCloudHistoryReset(effect) {
  if (cloudHistoryResetUniforms.has(effect)) return true;
  const material = effect?.cloudsPass?.resolveMaterial;
  if (!material?.fragmentShader) return false;

  // Anchors match takram's cloudsResolve.frag at the pinned revision; the
  // comment line pins the reset to temporalUpscale(), the only currentFrame
  // branch. A takram bump that rewrites either anchor fails the install (and
  // the caller's warning) instead of silently reverting to ghosting.
  const declaration = 'uniform float temporalAlpha;';
  const resetPoint = '  if (currentFrame) {\n'
    + '    // Use the texel just rendered without any accumulation.';
  if (!material.fragmentShader.includes(declaration) || !material.fragmentShader.includes(resetPoint)) {
    return false;
  }

  const uniform = { value: 0 };
  material.uniforms.terrainHistoryReset = uniform;
  material.fragmentShader = material.fragmentShader
    .replace(declaration, `${declaration}\nuniform float terrainHistoryReset;`)
    .replace(resetPoint, `  // Project-owned sun-change reset: spatially upscale the complete current
  // low-resolution frame into every history pixel instead of mixing 16 Bayer
  // phases rendered under different sun directions.
  if (terrainHistoryReset > 0.5) {
    outputColor = texture(colorBuffer, vUv);
    #ifdef SHADOW_LENGTH
    outputShadowLength = texture(shadowLengthBuffer, vUv).r;
    #endif // SHADOW_LENGTH
    return;
  }
${resetPoint}`);
  material.needsUpdate = true;
  cloudHistoryResetUniforms.set(effect, uniform);
  return true;
}

export function bindTerrainCloudComposition(cloudsEffect, aerialPerspective) {
  const sync = () => {
    aerialPerspective.overlay = cloudsEffect.atmosphereOverlay;
    aerialPerspective.shadow = cloudsEffect.atmosphereShadow;
    aerialPerspective.shadowLength = cloudsEffect.atmosphereShadowLength;
  };
  const onChange = event => {
    if (event.property === 'atmosphereOverlay') {
      aerialPerspective.overlay = cloudsEffect.atmosphereOverlay;
    } else if (event.property === 'atmosphereShadow') {
      aerialPerspective.shadow = cloudsEffect.atmosphereShadow;
    } else if (event.property === 'atmosphereShadowLength') {
      aerialPerspective.shadowLength = cloudsEffect.atmosphereShadowLength;
    }
  };
  cloudsEffect.events.addEventListener('change', onChange);
  sync();
  return {
    sync,
    dispose: () => cloudsEffect.events.removeEventListener?.('change', onChange),
  };
}

const pendingHistoryRestores = new WeakMap();

export function invalidateTerrainCloudHistory(effect) {
  let restore = pendingHistoryRestores.get(effect);
  if (restore != null) return restore;

  const shadowAlpha = effect?.shadowPass?.resolveMaterial?.uniforms?.temporalAlpha;
  const cloudsAlpha = effect?.cloudsPass?.resolveMaterial?.uniforms?.temporalAlpha;
  const previousShadowAlpha = shadowAlpha?.value;
  const previousCloudsAlpha = cloudsAlpha?.value;
  const cloudsReset = cloudHistoryResetUniforms.get(effect);
  const previousCloudsReset = cloudsReset?.value;

  // Takram's temporal upscaler ignores temporalAlpha for 15 of its 16 Bayer
  // phases. terrainHistoryReset makes its next resolve spatially upscale the
  // complete current low-resolution frame into all history pixels instead.
  // The shadow resolve is full-resolution, so alpha=1 is sufficient there.
  if (cloudsReset) cloudsReset.value = 1;
  if (shadowAlpha) shadowAlpha.value = 1;
  if (cloudsAlpha) cloudsAlpha.value = 1;

  restore = () => {
    if (shadowAlpha) shadowAlpha.value = previousShadowAlpha;
    if (cloudsAlpha) cloudsAlpha.value = previousCloudsAlpha;
    if (cloudsReset) cloudsReset.value = previousCloudsReset;
    pendingHistoryRestores.delete(effect);
  };
  pendingHistoryRestores.set(effect, restore);
  return restore;
}

export function registerTerrainCloudTuning({
  effect,
  controls,
  section,
  slider,
  toggle,
  getWindDirection,
} = {}) {
  section('Clouds');
  const defaultAltitudes = effect.cloudLayers.map(layer => layer.altitude);
  slider('cloud altitude', {
    min: -2000, max: 5000, step: 50, value: 0, decimals: 0,
    format: value => `${value > 0 ? '+' : ''}${value}m`,
    onChange: value => {
      for (let index = 0; index < effect.cloudLayers.length; index += 1) {
        effect.cloudLayers[index].altitude = Math.max(0, defaultAltitudes[index] + value);
      }
    },
  });
  slider('coverage', {
    min: 0, max: 1, step: 0.01, value: effect.coverage,
    onChange: value => { effect.coverage = value; },
  });
  slider('cirrus density', {
    min: 0, max: 0.002, step: 0.0001,
    value: effect.cloudLayers[3].densityScale, decimals: 4,
    onChange: value => { effect.cloudLayers[3].densityScale = value; },
  });
  slider('cirrus coverage', {
    min: 0.1, max: 3, step: 0.05,
    value: effect.cloudLayers[3].weatherExponent, decimals: 2,
    format: value => value <= 0.1 ? 'full' : value >= 3 ? 'sparse' : value.toFixed(2),
    onChange: value => { effect.cloudLayers[3].weatherExponent = value; },
  });
  controls._cirrusCheckbox = toggle('cirrus', {
    value: false,
    onChange: enabled => {
      effect.cloudLayers[3].densityScale = enabled ? 0.004 : 0;
    },
  });
  slider('cirrus shape', {
    min: 0, max: 1, step: 0.01,
    value: effect.cloudLayers[3].shapeAmount,
    onChange: value => { effect.cloudLayers[3].shapeAmount = value; },
  });

  // One wind: cloud drift heading is slaved to the water wind direction
  // (compass "blows toward" degrees, 0 = north / 90 = east) instead of an
  // independent slider, so waves, whitecap streaks and weather all move
  // together. Compass converts to the weather-uv math frame (+x east, ccw).
  let driftSpeed = 0.00004;
  const updateDrift = () => {
    const compass = getWindDirection?.() ?? 90;
    const radians = (90 - compass) * Math.PI / 180;
    effect.localWeatherVelocity.set(
      Math.cos(radians) * driftSpeed,
      Math.sin(radians) * driftSpeed,
    );
  };
  slider('drift speed', {
    min: 0, max: 0.002, step: 0.00005, value: driftSpeed, decimals: 6,
    onChange: value => { driftSpeed = value; updateDrift(); },
  });
  updateDrift();
  return { syncDrift: updateDrift };
}
