/**
 * Procedural audio synthesis for the Atlantis terrain system.
 * All sounds are generated via the Web Audio API — no audio files needed.
 */

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

/**
 * Procedural gunshot sound: noise burst (bandpass 800Hz) + low thump (100→30Hz sine).
 */
export function playGunshotSound(): void {
  try {
    const ctx = getAudioContext();
    if (ctx.state !== 'running') return;
    const now = ctx.currentTime;

    // Layer 1: Noise burst
    const noiseLen = 0.05;
    const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * noiseLen, ctx.sampleRate);
    const noiseData = noiseBuffer.getChannelData(0);
    for (let i = 0; i < noiseData.length; i++) {
      noiseData[i] = Math.random() * 2 - 1;
    }
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuffer;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 800;
    bp.Q.value = 1.5;

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.6, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + noiseLen);

    noiseSrc.connect(bp).connect(noiseGain).connect(ctx.destination);
    noiseSrc.start(now);
    noiseSrc.stop(now + noiseLen);

    // Layer 2: Low thump
    const thumpLen = 0.06;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(100, now);
    osc.frequency.exponentialRampToValueAtTime(30, now + thumpLen);

    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0.4, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + thumpLen);

    osc.connect(thumpGain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + thumpLen);
  } catch {
    // Audio not available — silently ignore
  }
}

/**
 * Diesel engine audio state.
 */
let dieselOsc: OscillatorNode | null = null;
let dieselGain: GainNode | null = null;
let dieselRunning = false;

export function startDieselAudio(): void {
  if (dieselRunning) return;
  try {
    const ctx = getAudioContext();
    if (ctx.state !== 'running') return;

    dieselOsc = ctx.createOscillator();
    dieselOsc.type = 'sawtooth';
    dieselOsc.frequency.value = 80;

    dieselGain = ctx.createGain();
    dieselGain.gain.value = 0;

    dieselOsc.connect(dieselGain).connect(ctx.destination);
    dieselOsc.start();
    dieselRunning = true;
  } catch {
    // ignore
  }
}

export function updateDieselAudio(controlActive: boolean, speed: number): void {
  if (!dieselOsc || !dieselGain) return;
  try {
    const targetGain = controlActive ? 0.03 + Math.abs(speed) * 0.002 : 0;
    const targetFreq = 80 + Math.abs(speed) * 3.3;
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    dieselGain.gain.setTargetAtTime(Math.min(targetGain, 0.12), now, 0.1);
    dieselOsc.frequency.setTargetAtTime(Math.min(targetFreq, 160), now, 0.05);
  } catch {
    // ignore
  }
}

export function stopDieselAudio(): void {
  if (!dieselRunning) return;
  try {
    dieselOsc?.stop();
  } catch {
    // ignore
  }
  dieselOsc = null;
  dieselGain = null;
  dieselRunning = false;
}
