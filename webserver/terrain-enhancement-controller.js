import * as THREE from 'three';

export function createTerrainEnhancementController({
  log,
  applyEnhancedTexture,
  textureCache,
  textureSource,
  hasTextureWork,
  getLastCameraMoveTime,
  hasTiles,
  fetchImpl = (...args) => fetch(...args),
  decodeImage = (...args) => createImageBitmap(...args),
  now = () => performance.now(),
  maxInflight = 4,
  idleMs = 2000,
  pollMs = 5000,
  statusPollMs = 3000,
  backoffMs = 10000,
  pollBatch = 1,
  onStatus = () => {},
}) {
  const inflight = new Map();
  const pending = new Map();
  const retryAfter = new Map();
  const failed = new Set();
  let status = { total: 0, eligible: 0, done: 0, in_progress: 0 };
  let lastStatusPoll = 0;
  let backoffUntil = 0;

  function abortAll() {
    if (inflight.size === 0) return;
    for (const [tileId, controller] of inflight) {
      log(tileId, 'enhance aborted — camera moved');
      controller.abort();
    }
    inflight.clear();
  }

  function busyCount() {
    return inflight.size + pending.size;
  }

  function handleResponse(tileId, response, fromPending = false) {
    inflight.delete(tileId);
    const timestamp = now();
    if (response.status === 202) {
      if (!pending.has(tileId)) log(tileId, 'enhance queued on server');
      pending.set(tileId, { submitted: timestamp, nextPollAt: timestamp + pollMs });
      retryAfter.delete(tileId);
      return;
    }
    if (response.status === 429) {
      backoffUntil = timestamp + backoffMs;
      retryAfter.set(tileId, backoffUntil);
      if (fromPending || pending.has(tileId)) {
        const previous = pending.get(tileId);
        pending.set(tileId, {
          submitted: previous?.submitted ?? timestamp,
          nextPollAt: backoffUntil,
        });
      }
      log(tileId, 'enhance throttled (429)');
      return;
    }
    pending.delete(tileId);
    retryAfter.delete(tileId);
    if (!response.ok || response.status === 204) {
      const reason = response.headers.get('X-Tex-Status') || `status ${response.status}`;
      console.warn(`[ENHANCE] ${tileId} rejected: ${reason}`);
      log(tileId, `enhance rejected: ${reason}`);
      failed.add(tileId);
      return;
    }
    const source = response.headers.get('X-Tex-Source') || 'sentinel2_enhanced';
    return response.blob()
      .then(blob => decodeImage(blob, { imageOrientation: 'flipY' }))
      .then(bitmap => {
        const texture = new THREE.Texture(bitmap);
        texture.flipY = false;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        textureCache.set(tileId, texture);
        textureSource.set(tileId, source);
        log(tileId, `enhanced: sentinel2 -> ${source}`);
        applyEnhancedTexture(tileId, texture);
      });
  }

  function submit(tileId, prompts) {
    const timestamp = now();
    pending.set(tileId, { submitted: timestamp, nextPollAt: timestamp + pollMs });
    return fetchImpl(`/api/texture/${tileId}/enhance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prompts),
    }).then(response => handleResponse(tileId, response)).catch(error => {
      console.error(`[ENHANCE] ${tileId} fetch failed:`, error);
      pending.delete(tileId);
    });
  }

  function update() {
    const timestamp = now();
    if (timestamp - lastStatusPoll > statusPollMs) {
      lastStatusPoll = timestamp;
      fetchImpl('/api/enhance/status').then(response => response.json()).then(next => {
        status = next;
        onStatus(next);
      }).catch(() => {});
    }
    if (hasTextureWork() || timestamp - getLastCameraMoveTime() < idleMs || !hasTiles()) return;
    if (timestamp < backoffUntil) return;

    let budget = Math.min(pollBatch, Math.max(0, maxInflight - inflight.size));
    for (const [tileId, info] of pending) {
      if (budget <= 0) break;
      if (inflight.has(tileId) || timestamp < (retryAfter.get(tileId) ?? 0)) continue;
      const nextPollAt = info.nextPollAt ?? (info.submitted + pollMs);
      if (timestamp < nextPollAt) continue;
      info.submitted = timestamp;
      info.nextPollAt = timestamp + pollMs;
      const controller = new AbortController();
      inflight.set(tileId, controller);
      budget -= 1;
      fetchImpl(`/api/texture/${tileId}/enhance`, { method: 'POST', signal: controller.signal })
        .then(response => handleResponse(tileId, response, true))
        .catch(error => {
          inflight.delete(tileId);
          if (error.name !== 'AbortError') log(tileId, `enhance poll error: ${error.message}`);
        });
    }
  }

  return {
    inflight, pending, retryAfter, failed,
    abortAll, busyCount, handleResponse, submit, update,
    get status() { return status; },
    get backoffUntil() { return backoffUntil; },
  };
}
