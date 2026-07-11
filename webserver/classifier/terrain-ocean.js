export function createTerrainOceanClassifier({ THREE, paramNumber }) {
  const OCEAN_CLASSIFIER_ENABLED = true;
  const OCEAN_EDGE_SEED_MAX_M = paramNumber('oceanEdgeSeedMaxM', 1.5);
  const OCEAN_EDGE_PASSABLE_MAX_M = Math.max(
    OCEAN_EDGE_SEED_MAX_M,
    paramNumber('oceanEdgePassableMaxM', 5.0)
  );
  const OCEAN_PASSABLE_MAX_M = Math.max(
    OCEAN_EDGE_PASSABLE_MAX_M,
    paramNumber('oceanPassableMaxM', 12.0)
  );
  const OCEAN_EDGE_SEED_SLOPE_MAX = Math.max(0.02, paramNumber('oceanEdgeSeedSlopeMax', 0.22));
  const OCEAN_PASSABLE_SLOPE_MAX = Math.max(
    OCEAN_EDGE_SEED_SLOPE_MAX,
    paramNumber('oceanPassableSlopeMax', 0.48)
  );
  const OCEAN_SEA_LEVEL_M = paramNumber('oceanSeaLevelM', 0.0);
  const OCEAN_SHORE_BLEND_M = Math.max(0.5, paramNumber('oceanShoreBlendM', 8.0));
  const OCEAN_BASE_DROP_M = Math.max(0.0, paramNumber('oceanBaseDropM', 3.0));
  const OCEAN_DEPTH_GAIN = Math.max(0.0, paramNumber('oceanDepthGain', 0.8));
  const OCEAN_MAX_DROP_M = Math.max(OCEAN_BASE_DROP_M, paramNumber('oceanMaxDropM', 16.0));
  const OCEAN_EDGE_CACHE_MAX = Math.max(512, Math.floor(paramNumber('oceanEdgeCacheMax', 30000)));
  const oceanEdgeState = new Map();
  const OCEAN_COLOR_ASSIST_ENABLED = true;
  const OCEAN_COLOR_SCORE_MIN = THREE.MathUtils.clamp(paramNumber('oceanColorScoreMin', 0.20), 0.0, 1.0);
  const OCEAN_COLOR_PASSABLE_SCORE_MIN = THREE.MathUtils.clamp(
    paramNumber('oceanColorPassableScoreMin', 0.18),
    0.0,
    1.0
  );
  const OCEAN_COLOR_PASSABLE_MAX_M = Math.max(
    OCEAN_PASSABLE_MAX_M,
    OCEAN_PASSABLE_MAX_M + Math.max(0.0, paramNumber('oceanColorPassableExtraM', 12.0))
  );
  const OCEAN_COLOR_EDGE_MAX_M = Math.max(
    OCEAN_EDGE_PASSABLE_MAX_M,
    OCEAN_EDGE_PASSABLE_MAX_M + Math.max(0.0, paramNumber('oceanColorEdgeExtraM', 10.0))
  );
  const OCEAN_COLOR_SLOPE_MAX = Math.max(0.02, paramNumber('oceanColorSlopeMax', 0.90));
  const OCEAN_GHOST_BRIDGE_ENABLED = true;
  const OCEAN_GHOST_GAP_PX = Math.max(1, Math.floor(paramNumber('oceanGhostGapPx', 10)));
  const OCEAN_GHOST_SCORE_MIN = THREE.MathUtils.clamp(paramNumber('oceanGhostScoreMin', 0.10), 0.0, 1.0);
  const OCEAN_GHOST_MIN_SCORE_FRACTION = THREE.MathUtils.clamp(paramNumber('oceanGhostMinScoreFrac', 0.30), 0.0, 1.0);
  const OCEAN_GHOST_MAX_ELEV_M = Math.max(OCEAN_COLOR_EDGE_MAX_M, paramNumber('oceanGhostMaxElevM', 28.0));
  const OCEAN_GHOST_MAX_SLOPE = Math.max(0.05, paramNumber('oceanGhostMaxSlope', 1.40));
  const oceanSampleCanvas = document.createElement('canvas');
  const oceanSampleCtx = oceanSampleCanvas.getContext('2d', { willReadFrequently: true });
  
  function parseTileAddress(tileId) {
    if (typeof tileId !== 'string') return null;
    const parts = tileId.split('-');
    if (parts.length !== 3) return null;
    const depth = Number.parseInt(parts[0], 10);
    const col = Number.parseInt(parts[1], 10);
    const row = Number.parseInt(parts[2], 10);
    if (!Number.isFinite(depth) || !Number.isFinite(col) || !Number.isFinite(row)) return null;
    return { depth, col, row };
  }
  
  function tileIdFromAddress(depth, col, row) {
    return `${depth}-${col}-${row}`;
  }
  
  function neighborOceanSeeds(tileId, res) {
    const address = parseTileAddress(tileId);
    if (!address) return null;
    const { depth, col, row } = address;
    const north = oceanEdgeState.get(tileIdFromAddress(depth, col, row + 1));
    const south = oceanEdgeState.get(tileIdFromAddress(depth, col, row - 1));
    const east = oceanEdgeState.get(tileIdFromAddress(depth, col + 1, row));
    const west = oceanEdgeState.get(tileIdFromAddress(depth, col - 1, row));
    return {
      N: north && north.S?.length === res ? north.S : null,
      S: south && south.N?.length === res ? south.N : null,
      E: east && east.W?.length === res ? east.W : null,
      W: west && west.E?.length === res ? west.E : null,
    };
  }
  
  function cacheOceanEdges(tileId, res, mask) {
    const edgeN = new Uint8Array(res);
    const edgeS = new Uint8Array(res);
    const edgeE = new Uint8Array(res);
    const edgeW = new Uint8Array(res);
    const last = res - 1;
    for (let i = 0; i < res; i++) {
      edgeS[i] = mask[i];
      edgeN[i] = mask[last * res + i];
      edgeW[i] = mask[i * res];
      edgeE[i] = mask[i * res + last];
    }
    oceanEdgeState.set(tileId, { N: edgeN, S: edgeS, E: edgeE, W: edgeW });
    if (oceanEdgeState.size > OCEAN_EDGE_CACHE_MAX) {
      const oldest = oceanEdgeState.keys().next().value;
      if (oldest != null) oceanEdgeState.delete(oldest);
    }
  }
  
  function sampleOceanBlueScore(texture, res) {
    if (!OCEAN_COLOR_ASSIST_ENABLED || !texture || !texture.image || !oceanSampleCtx) return null;
    try {
      if (oceanSampleCanvas.width !== res || oceanSampleCanvas.height !== res) {
        oceanSampleCanvas.width = res;
        oceanSampleCanvas.height = res;
      }
      oceanSampleCtx.clearRect(0, 0, res, res);
      oceanSampleCtx.drawImage(texture.image, 0, 0, res, res);
      const data = oceanSampleCtx.getImageData(0, 0, res, res).data;
      const score = new Float32Array(res * res);
      for (let i = 0; i < res * res; i++) {
        const o = i * 4;
        const r = data[o] / 255.0;
        const g = data[o + 1] / 255.0;
        const b = data[o + 2] / 255.0;
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        const sat = (mx - mn) / Math.max(mx, 1e-6);
        const blueDom = b - Math.max(r, g);
        const blueScore = THREE.MathUtils.clamp((blueDom - 0.02) / 0.22, 0.0, 1.0);
        const blueCyan = THREE.MathUtils.clamp((b - 0.5 * r - 0.35 * g) / 0.24, 0.0, 1.0);
        const baseBlue = Math.max(blueScore, blueCyan) * THREE.MathUtils.clamp((sat + 0.05) / 0.35, 0.0, 1.0);
        const redSupp = THREE.MathUtils.clamp((Math.max(g, b) - r - 0.01) / 0.28, 0.0, 1.0);
        const cyanGreen = THREE.MathUtils.clamp((g + b - 1.15 * r - 0.18) / 0.55, 0.0, 1.0);
        const ndwi = THREE.MathUtils.clamp(((g - r) / Math.max(g + r, 1e-6) + 0.08) / 0.55, 0.0, 1.0);
        const lumGate = THREE.MathUtils.clamp((0.95 - mx) / 0.60, 0.0, 1.0);
        const satGate = THREE.MathUtils.clamp((0.92 - sat) / 0.70, 0.0, 1.0);
        const greenishWater = Math.max(cyanGreen * redSupp, ndwi * redSupp) * lumGate * satGate;
        score[i] = Math.max(baseBlue, greenishWater);
      }
      return score;
    } catch {
      return null;
    }
  }
  
  function bridgeOceanGhostGaps(ocean, passable, hm, slopeArr, score, res) {
    if (!ocean || !passable || !hm || !slopeArr || !score) return;
  
    const fillLine = (indexForPos) => {
      for (let line = 0; line < res; line++) {
        let pos = 0;
        while (pos < res) {
          while (pos < res && ocean[indexForPos(line, pos)] === 1) pos += 1;
          if (pos >= res) break;
          const start = pos;
          while (pos < res && ocean[indexForPos(line, pos)] !== 1) pos += 1;
          const end = pos - 1;
          if (start <= 0 || end >= res - 1) continue;
          if (ocean[indexForPos(line, start - 1)] !== 1 || ocean[indexForPos(line, end + 1)] !== 1) continue;
          const gap = end - start + 1;
          if (gap <= 0 || gap > OCEAN_GHOST_GAP_PX) continue;
  
          let scoreHits = 0;
          let maxElev = -Infinity;
          let maxSlope = -Infinity;
          for (let at = start; at <= end; at++) {
            const idx = indexForPos(line, at);
            if (score[idx] >= OCEAN_GHOST_SCORE_MIN) scoreHits += 1;
            if (hm[idx] > maxElev) maxElev = hm[idx];
            if (slopeArr[idx] > maxSlope) maxSlope = slopeArr[idx];
          }
          const scoreFraction = scoreHits / gap;
          if (
            scoreFraction >= OCEAN_GHOST_MIN_SCORE_FRACTION &&
            maxElev <= OCEAN_GHOST_MAX_ELEV_M &&
            maxSlope <= OCEAN_GHOST_MAX_SLOPE
          ) {
            for (let at = start; at <= end; at++) {
              const idx = indexForPos(line, at);
              ocean[idx] = 1;
              passable[idx] = 1;
            }
          }
        }
      }
    };
  
    // Two passes lets row/col bridges reinforce each other.
    for (let iter = 0; iter < 2; iter++) {
      fillLine((row, col) => row * res + col); // rows
      fillLine((col, row) => row * res + col); // columns
    }
  }
  
  function classifyOceanMask(hm, res, bbox, tileId, blueScore = null) {
    if (!OCEAN_CLASSIFIER_ENABLED || !hm || hm.length !== res * res) return null;
    const spanX = Math.max(1.0, bbox[2] - bbox[0]);
    const spanY = Math.max(1.0, bbox[3] - bbox[1]);
    const pxX = spanX / Math.max(1, res - 1);
    const pxY = spanY / Math.max(1, res - 1);
    const count = res * res;
    const passable = new Uint8Array(count);
    const seed = new Uint8Array(count);
    const ocean = new Uint8Array(count);
    const slopeArr = new Float32Array(count);
    const neighborSeeds = neighborOceanSeeds(tileId, res);
  
    for (let r = 0; r < res; r++) {
      for (let c = 0; c < res; c++) {
        const idx = r * res + c;
        const e = hm[idx];
        const westIdx = r * res + Math.max(c - 1, 0);
        const eastIdx = r * res + Math.min(c + 1, res - 1);
        const southIdx = Math.max(r - 1, 0) * res + c;
        const northIdx = Math.min(r + 1, res - 1) * res + c;
        const dEdx = (hm[eastIdx] - hm[westIdx]) / ((c > 0 && c < res - 1) ? (2.0 * pxX) : pxX);
        const dEdy = (hm[northIdx] - hm[southIdx]) / ((r > 0 && r < res - 1) ? (2.0 * pxY) : pxY);
        const slope = Math.hypot(dEdx, dEdy);
        slopeArr[idx] = slope;
        const colorWater = blueScore ? blueScore[idx] >= OCEAN_COLOR_PASSABLE_SCORE_MIN : false;
        const basePassable = e <= OCEAN_PASSABLE_MAX_M && slope <= OCEAN_PASSABLE_SLOPE_MAX;
        const colorPassable = colorWater && e <= OCEAN_COLOR_PASSABLE_MAX_M && slope <= OCEAN_COLOR_SLOPE_MAX;
        const isPassable = basePassable || colorPassable;
        if (!isPassable) continue;
        passable[idx] = 1;
        const atSouth = r === 0;
        const atNorth = r === res - 1;
        const atWest = c === 0;
        const atEast = c === res - 1;
        if (!(atSouth || atNorth || atWest || atEast)) continue;
        let seededByNeighbor = false;
        if (atNorth && neighborSeeds?.N) {
          seededByNeighbor = neighborSeeds.N[c] === 1;
        } else if (atSouth && neighborSeeds?.S) {
          seededByNeighbor = neighborSeeds.S[c] === 1;
        } else if (atEast && neighborSeeds?.E) {
          seededByNeighbor = neighborSeeds.E[r] === 1;
        } else if (atWest && neighborSeeds?.W) {
          seededByNeighbor = neighborSeeds.W[r] === 1;
        }
        const baseSeed = e <= OCEAN_EDGE_SEED_MAX_M && slope <= OCEAN_EDGE_SEED_SLOPE_MAX;
        const colorSeed = colorWater && e <= OCEAN_COLOR_EDGE_MAX_M && slope <= OCEAN_COLOR_SLOPE_MAX;
        if (seededByNeighbor || baseSeed || colorSeed) {
          seed[idx] = 1;
        }
      }
    }
  
    const queue = new Int32Array(count);
    let qHead = 0;
    let qTail = 0;
    for (let i = 0; i < count; i++) {
      if (seed[i] !== 1 || passable[i] !== 1) continue;
      ocean[i] = 1;
      queue[qTail++] = i;
    }
    while (qHead < qTail) {
      const idx = queue[qHead++];
      const r = Math.floor(idx / res);
      const c = idx - r * res;
      if (r > 0) {
        const up = idx - res;
        if (passable[up] === 1 && ocean[up] === 0) {
          ocean[up] = 1;
          queue[qTail++] = up;
        }
      }
      if (r + 1 < res) {
        const down = idx + res;
        if (passable[down] === 1 && ocean[down] === 0) {
          ocean[down] = 1;
          queue[qTail++] = down;
        }
      }
      if (c > 0) {
        const left = idx - 1;
        if (passable[left] === 1 && ocean[left] === 0) {
          ocean[left] = 1;
          queue[qTail++] = left;
        }
      }
      if (c + 1 < res) {
        const right = idx + 1;
        if (passable[right] === 1 && ocean[right] === 0) {
          ocean[right] = 1;
          queue[qTail++] = right;
        }
      }
    }
  
    const last = res - 1;
    for (let i = 0; i < res; i++) {
      const edgeCells = [
        { idx: i, neighbor: neighborSeeds?.S ? neighborSeeds.S[i] : null },
        { idx: last * res + i, neighbor: neighborSeeds?.N ? neighborSeeds.N[i] : null },
        { idx: i * res, neighbor: neighborSeeds?.W ? neighborSeeds.W[i] : null },
        { idx: i * res + last, neighbor: neighborSeeds?.E ? neighborSeeds.E[i] : null },
      ];
      for (const edge of edgeCells) {
        if (passable[edge.idx] !== 1) {
          ocean[edge.idx] = 0;
          continue;
        }
        if (edge.neighbor != null) {
          ocean[edge.idx] = edge.neighbor === 1 ? 1 : 0;
          continue;
        }
        const colorWater = blueScore ? blueScore[edge.idx] >= OCEAN_COLOR_PASSABLE_SCORE_MIN : false;
        const edgePassableByHeight = hm[edge.idx] <= OCEAN_EDGE_PASSABLE_MAX_M;
        const edgePassableByColor = colorWater && hm[edge.idx] <= OCEAN_COLOR_EDGE_MAX_M && slopeArr[edge.idx] <= OCEAN_COLOR_SLOPE_MAX;
        if (edgePassableByHeight || edgePassableByColor) {
          ocean[edge.idx] = 1;
        }
      }
    }
  
    if (OCEAN_GHOST_BRIDGE_ENABLED && blueScore) {
      bridgeOceanGhostGaps(ocean, passable, hm, slopeArr, blueScore, res);
    }
  
    cacheOceanEdges(tileId, res, ocean);
    return { ocean, passable, seed };
  }
  
  function adjustedSeabedElevation(e, isOcean) {
    if (!isOcean) return e;
    const depthInput = Math.max(0.0, OCEAN_SEA_LEVEL_M - e);
    const shoreFactor = THREE.MathUtils.clamp((e - OCEAN_SEA_LEVEL_M) / OCEAN_SHORE_BLEND_M, 0.0, 1.0);
    const shoreFade = 1.0 - (shoreFactor * shoreFactor * (3.0 - 2.0 * shoreFactor));
    const drop = Math.min(OCEAN_MAX_DROP_M, (OCEAN_BASE_DROP_M + depthInput * OCEAN_DEPTH_GAIN) * shoreFade);
    return e - drop;
  }
  
  
  return { OCEAN_EDGE_SEED_MAX_M, sampleOceanBlueScore, classifyOceanMask, adjustedSeabedElevation };
}
