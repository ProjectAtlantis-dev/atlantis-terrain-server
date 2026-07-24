import { sortedPercentile } from './terrain-statistics.js';

export function createTerrainCpuProfiler({
  performanceRef = performance,
  maxSamplesPerLabel = 4096,
} = {}) {
  let enabled = false;
  const samples = new Map();

  function record(label, durationMs) {
    if (!enabled || !Number.isFinite(durationMs)) return;
    let values = samples.get(label);
    if (values == null) {
      values = [];
      samples.set(label, values);
    }
    values.push(durationMs);
    if (values.length > maxSamplesPerLabel) values.shift();
  }

  return {
    clear() {
      samples.clear();
    },
    setEnabled(value) {
      enabled = Boolean(value);
      return enabled;
    },
    begin() {
      return enabled ? performanceRef.now() : null;
    },
    end(label, startedAt) {
      if (startedAt == null) return;
      record(label, performanceRef.now() - startedAt);
    },
    getSummary() {
      const timings = {};
      for (const [label, values] of samples) {
        const sorted = [...values].sort((a, b) => a - b);
        const total = values.reduce((sum, value) => sum + value, 0);
        timings[label] = {
          samples: values.length,
          averageMs: total / values.length,
          p95Ms: sortedPercentile(sorted, 0.95),
          maxMs: sorted[sorted.length - 1],
          latestMs: values[values.length - 1],
        };
      }
      return { enabled, timings };
    },
  };
}
