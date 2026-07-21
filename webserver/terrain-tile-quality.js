const PARENT_DEM_SOURCES = new Set([
  'parent_resampled',
  'unmasked_parent_resampled',
  'clobbered_parent_resampled',
]);

export function classifyDemSource(source) {
  const raw = typeof source === 'string' ? source : '';
  if (PARENT_DEM_SOURCES.has(raw)) {
    return {
      kind: 'parent_dem', synthetic: true, retryable: true,
      terminal: false, retryState: 'ready', source: raw,
    };
  }
  if (raw === 'procedural') {
    return {
      kind: 'procedural', synthetic: true, retryable: false,
      terminal: true, retryState: 'terminal', source: raw,
    };
  }
  if (!raw || raw === 'empty' || raw === 'pending') {
    return {
      kind: 'missing', synthetic: false, retryable: true,
      terminal: false, retryState: 'ready', source: raw,
    };
  }
  if (raw === 'no_data') {
    return {
      kind: 'missing', synthetic: false, retryable: false,
      terminal: true, retryState: 'terminal', source: raw,
    };
  }
  return {
    kind: 'measured', synthetic: false, retryable: false,
    terminal: true, retryState: 'terminal', source: raw,
  };
}

export function classifyTextureTile(tile) {
  const status = tile?.texStatus || 'missing';
  if (tile?.texIsPlaceholder || status === 'ancestor_fallback') {
    return {
      kind: 'parent_image', synthetic: true, retryable: true,
      terminal: false, retryState: 'ready', status,
    };
  }
  if (status === 'fetching') {
    return {
      kind: 'missing', synthetic: false, retryable: true,
      terminal: false, retryState: 'inflight', status,
    };
  }
  if (status === 'ready') {
    return {
      kind: 'image', synthetic: false, retryable: false,
      terminal: true, retryState: 'terminal', status,
    };
  }
  return {
    kind: 'missing', synthetic: false, retryable: true,
    terminal: false, retryState: 'ready', status,
  };
}

export function retryableSyntheticDemCount(tiles) {
  if (!Array.isArray(tiles)) return 0;
  return tiles.reduce((count, tile) => {
    const quality = classifyDemSource(tile?.source);
    return count + Number(quality.synthetic && quality.retryable);
  }, 0);
}
