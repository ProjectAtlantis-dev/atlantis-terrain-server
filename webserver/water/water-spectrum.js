// CPU side of the Tessendorf FFT fjord water (port of ~/work/ocean2 sim.js).
// Deliberately renderer-agnostic — plain arrays in, plain arrays out — so the
// WebGL sim consumes it today and a WGSL/TSL port can reuse it unchanged.

export const GRAVITY = 9.81;

// Band-limited cascades: patch size in metres and the wavelength band each
// one owns. Bands cross-fade in k-space so no wavelength is counted twice.
export const DEFAULT_CASCADES = [
  { size: 840, minWave: 55, maxWave: 1e6, foam: true },
  { size: 160, minWave: 7.5, maxWave: 55, foam: true },
  { size: 22, minWave: 0.4, maxWave: 7.5, foam: false },
];

// Visual whitecap coverage curve: nothing below ~3 m/s, saturating ~24 m/s.
export function windCoverage(windSpeed) {
  const t = Math.min(Math.max((windSpeed - 3) / 21, 0), 1);
  return t * t * (3 - 2 * t);
}

function bitReverse(i, bits) {
  let r = 0;
  for (let b = 0; b < bits; b++) { r = (r << 1) | ((i >> b) & 1); }
  return r;
}

// Butterfly lookup for the ping-pong IFFT: for texel (stage s, index y) packs
// (twiddle.re, twiddle.im, idxA, idxB). Upload as a stages x N float texture.
export function buildButterflyData(N) {
  const stages = Math.log2(N);
  const data = new Float32Array(stages * N * 4);
  for (let s = 0; s < stages; s++) {
    const m = 1 << (s + 1);
    const half = 1 << s;
    for (let y = 0; y < N; y++) {
      const kIdx = (y * (N / m)) % N;
      // inverse FFT twiddle: e^{+2*pi*i*k/N}
      const tw = (2 * Math.PI * kIdx) / N;
      const top = (y % m) < half;
      let idxA, idxB;
      if (s === 0) {
        idxA = top ? bitReverse(y, stages) : bitReverse(y - half, stages);
        idxB = top ? bitReverse(y + half, stages) : bitReverse(y, stages);
      } else {
        idxA = top ? y : y - half;
        idxB = top ? y + half : y;
      }
      const o = (y * stages + s) * 4;
      data[o + 0] = Math.cos(tw);
      data[o + 1] = Math.sin(tw);
      data[o + 2] = idxA;
      data[o + 3] = idxB;
    }
  }
  return { data, stages };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGaussian(rand) {
  let has = false;
  let value = 0;
  return function () {
    if (has) { has = false; return value; }
    let u = 0;
    while (u <= 1e-9) u = rand();
    const v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    has = true;
    value = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

function smooth(a, b, x) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * Build the initial spectra h0(k) for every cascade. Phillips base with a
 * JONSWAP-style peak enhancement and Hasselmann-style frequency-dependent
 * directional spreading, normalised so the combined significant wave height
 * matches a Pierson-Moskowitz fully-developed sea for this wind speed.
 *
 * Returns one RGBA Float32Array per cascade — (h0.re, h0.im, h0(-k).re,
 * h0(-k).im) per texel — plus the resulting significant wave height.
 */
export function buildInitialSpectra({
  resolution,
  cascades = DEFAULT_CASCADES,
  speed,
  directionRad,
  amplitude = 1,
  alignment = 1,
  seed = 1,
  fetchKm = Infinity,
}) {
  const U = Math.max(speed, 0.01);
  const N = resolution;
  const wx = Math.sin(directionRad);
  const wz = Math.cos(directionRad);
  const smallDamp = 0.1;                    // metres; kills sub-decimetre noise

  // Fetch-limited JONSWAP peak: a fjord sea keeps its wind (and whitecaps)
  // but has only tens of km to grow, so the spectral peak sits at a higher
  // frequency than the fully-developed Pierson-Moskowitz sea. At 13 m/s the
  // PM peak wavelength is ~150 m — open-Atlantic swell that destroys the
  // sense of scale from altitude; ~100 km of fetch pulls it to ~60-70 m and
  // Hs from ~3.5 m to ~2 m. Infinite fetch degrades exactly to PM.
  const omegaPM = 0.855 * GRAVITY / U;
  let omegaP = omegaPM;
  let hsBase = 0.205 * (U * U) / GRAVITY;   // fully-developed Hs
  if (Number.isFinite(fetchKm)) {
    const F = Math.max(fetchKm, 1) * 1000;
    const omegaF = 22 * Math.cbrt((GRAVITY * GRAVITY) / (U * F));
    if (omegaF > omegaP) {
      omegaP = omegaF;
      hsBase = Math.min(hsBase, 0.0016 * Math.sqrt(GRAVITY * F) * U / GRAVITY);
    }
  }
  // Phillips low-k cutoff recentred on the (possibly fetch-shifted) peak;
  // equals the classic U^2/g when the sea is fully developed.
  const Lpm = 0.731 * GRAVITY / (omegaP * omegaP);

  const rand = mulberry32((seed * 2654435761) >>> 0);
  const gaussian = makeGaussian(rand);
  let totalVariance = 0;
  const spectra = [];

  for (const def of cascades) {
    const L = def.size;
    const dk = (2 * Math.PI) / L;
    const kLo = (2 * Math.PI) / def.maxWave;
    const kHi = (2 * Math.PI) / def.minWave;
    const data = new Float32Array(N * N * 4);

    // First pass: draw h0(k) for every texel.
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const kx = dk * (x - N / 2);
        const kz = dk * (y - N / 2);
        const k = Math.hypot(kx, kz);
        const o = (y * N + x) * 4;
        if (k < 1e-6) continue;

        // band-limit with soft edges so cascades cross-fade in k-space
        const band = smooth(kLo, kLo * 1.35, k) * (1 - smooth(kHi * 0.75, kHi, k));
        if (band < 1e-5) continue;

        // Phillips base with a JONSWAP-style peak enhancement. gamma 6 (vs
        // JONSWAP's 3.3): a narrower spectral peak makes the dominant waves
        // more monochromatic, so they read as regularly spaced ridge trains
        // from altitude instead of irregular lumps.
        const omega = Math.sqrt(GRAVITY * k);
        const sig = omega <= omegaP ? 0.07 : 0.09;
        const rr = Math.exp(-((omega - omegaP) ** 2) / (2 * sig * sig * omegaP * omegaP));
        const peak = Math.pow(6.0, rr);
        const base = Math.exp(-1 / (k * Lpm * (k * Lpm))) / (k * k * k * k)
                   * peak
                   * Math.exp(-k * k * smallDamp * smallDamp);

        // Hasselmann (1980) frequency-dependent spreading: cos^(2s)(θ/2) with
        // s peaking near omegaP. Random phases + broad spread cannot form
        // wave trains, so keep the WHOLE energetic band tightly aligned
        // (wide peak boost + high floor), not just the spectral peak — the
        // ridges visible from altitude are 2-3x above the peak frequency.
        const d = (kx * wx + kz * wz) / k;
        const ratio = omega / omegaP;
        const sRaw = ratio <= 1 ? 9.77 * Math.pow(ratio, 5) : 9.77 * Math.pow(ratio, -1.0);
        const peakBoost = 1 + 2.4 * Math.exp(-(((ratio - 1) / 0.9) ** 2));
        const s = Math.min(Math.max(sRaw * alignment * peakBoost, ratio > 1 ? 4.5 * alignment : 0.6), 60);
        const halfCos2 = 0.5 * (1 + d);      // cos^2(θ/2)
        let dir = Math.pow(halfCos2, s);
        dir *= 0.07 + 0.93 * halfCos2;       // smooth upwind suppression
        const amp = Math.sqrt(base * dir * band * 0.5) * dk;

        data[o + 0] = gaussian() * amp;
        data[o + 1] = gaussian() * amp;
      }
    }

    // Second pass: h0(-k) must be the mirror texel's own draw, otherwise the
    // evolved spectrum is not Hermitian and the Re/Im packing in the FFT
    // leaks garbage between fields.
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const mx = (N - x) % N;
        const my = (N - y) % N;
        const o = (y * N + x) * 4;
        const m = (my * N + mx) * 4;
        data[o + 2] = data[m + 0];
        data[o + 3] = data[m + 1];
        totalVariance += data[o] ** 2 + data[o + 1] ** 2 + data[o + 2] ** 2 + data[o + 3] ** 2;
      }
    }
    spectra.push(data);
  }

  // Normalise to the (possibly fetch-limited) significant wave height
  const targetHs = Math.min(hsBase, 14) * amplitude;
  const sigma = Math.sqrt(Math.max(totalVariance, 1e-12) * 0.5);
  const scale = (targetHs / 4) / Math.max(sigma, 1e-9);
  for (const data of spectra) {
    for (let j = 0; j < data.length; j++) data[j] *= scale;
  }

  return {
    spectra,
    significantWaveHeight: targetHs,
  };
}
