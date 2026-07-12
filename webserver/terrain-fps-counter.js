export function createTerrainFpsCounter({ sampleMs = 500, initialDisplay = '--' } = {}) {
  let sampleStartMs = null;
  let sampleFrames = 0;
  let display = initialDisplay;

  function start(nowMs) {
    sampleStartMs = nowMs;
    sampleFrames = 0;
    display = '--';
  }

  function frame(nowMs) {
    if (sampleStartMs == null) start(nowMs);
    sampleFrames += 1;
    const elapsedMs = nowMs - sampleStartMs;
    if (elapsedMs < sampleMs) return display;
    display = String(Math.round((sampleFrames * 1000) / elapsedMs));
    sampleFrames = 0;
    sampleStartMs = nowMs;
    return display;
  }

  function idle() {
    sampleStartMs = null;
    sampleFrames = 0;
    display = 'idle';
  }

  return {
    frame,
    idle,
    start,
    get display() { return display; },
  };
}
