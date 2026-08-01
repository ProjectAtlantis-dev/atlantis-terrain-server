/** One application-wide debug gate for every tile-associated retention pool. */
export function createTileEvictionGate(initiallyEnabled = true) {
  let enabled = Boolean(initiallyEnabled);
  const listeners = new Set();

  return {
    get enabled() { return enabled; },
    setEnabled(value) {
      const next = Boolean(value);
      if (next === enabled) return enabled;
      enabled = next;
      for (const listener of listeners) listener(enabled);
      return enabled;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
