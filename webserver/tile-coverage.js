function parseTileId(tileId) {
  if (typeof tileId !== 'string') return null;
  const parts = tileId.split('-');
  if (parts.length !== 3) return null;
  const values = parts.map(part => Number.parseInt(part, 10));
  if (!values.every(Number.isFinite)) return null;
  return { depth: values[0], col: values[1], row: values[2] };
}

const tileId = (depth, col, row) => `${depth}-${col}-${row}`;

/**
 * Return resident ancestors that can be removed because textured resident
 * descendants completely cover them. Results are ordered nearest-first.
 *
 * residentTextures maps tile IDs to whether their scene mesh is textured.
 * Selected ancestors are removed from the working set before higher ancestors
 * are checked, so a fallback selected for eviction cannot count as coverage.
 */
export function findCoveredTileAncestors(triggerTileId, residentTextures) {
  const trigger = parseTileId(triggerTileId);
  if (!trigger || trigger.depth <= 0) return [];

  const resident = new Map(residentTextures);
  let maxDepth = trigger.depth;
  for (const id of resident.keys()) {
    const address = parseTileId(id);
    if (address) maxDepth = Math.max(maxDepth, address.depth);
  }

  const covered = (depth, col, row, memo) => {
    const id = tileId(depth, col, row);
    if (memo.has(id)) return memo.get(id);
    if (resident.get(id) === true) return true;
    if (depth >= maxDepth) return false;
    for (let dx = 0; dx < 2; dx++) {
      for (let dy = 0; dy < 2; dy++) {
        if (!covered(depth + 1, col * 2 + dx, row * 2 + dy, memo)) {
          memo.set(id, false);
          return false;
        }
      }
    }
    memo.set(id, true);
    return true;
  };

  const evictable = [];
  for (let depth = trigger.depth - 1; depth >= 0; depth--) {
    const divisor = 2 ** (trigger.depth - depth);
    const col = Math.floor(trigger.col / divisor);
    const row = Math.floor(trigger.row / divisor);
    const ancestorId = tileId(depth, col, row);
    if (!resident.has(ancestorId)) continue;

    const memo = new Map();
    let fullyCovered = true;
    for (let dx = 0; dx < 2 && fullyCovered; dx++) {
      for (let dy = 0; dy < 2; dy++) {
        if (!covered(depth + 1, col * 2 + dx, row * 2 + dy, memo)) {
          fullyCovered = false;
          break;
        }
      }
    }
    if (!fullyCovered) continue;
    evictable.push(ancestorId);
    resident.delete(ancestorId);
  }
  return evictable;
}
