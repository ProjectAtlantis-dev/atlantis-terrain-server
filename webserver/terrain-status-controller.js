export function applyTerrainAvailabilityStatus({
  terrainRoot, missing, downloading, applyStatus,
}) {
  const downloadingIds = new Set(downloading || []);
  const missingIds = new Set((missing || []).map(tile => tile.id));
  let changed = 0;
  for (const mesh of terrainRoot.children) {
    const tileId = mesh.userData?.tileId;
    if (!mesh.isMesh || !tileId || mesh.material?.map) continue;
    const status = downloadingIds.has(tileId)
      ? 'downloading'
      : (missingIds.has(tileId) ? 'missing' : null);
    if (!status) continue;
    applyStatus(mesh, status);
    changed += 1;
  }
  return changed;
}

const SEAM_HTML = {
  running: '<span style="color:#0f8">RUNNING</span>',
  failed: '<span style="color:#f33">FAILED</span>',
  pending: '<span style="color:#fc0">PENDING</span>',
  done: '<span style="color:#8f8">DONE</span>',
};

export function createTerrainSeamStatusController({
  fetchImpl = (...args) => fetch(...args),
  now = () => performance.now(),
  pollMs = 2000,
}) {
  let lastPoll = 0;
  let pending = new Set(), running = new Set(), done = new Set(), failed = new Set();

  function apply(payload) {
    pending = new Set(payload?.pending || []);
    running = new Set(payload?.running || []);
    done = new Set(payload?.done_recent || []);
    failed = new Set(payload?.failed || []);
  }

  function poll() {
    const timestamp = now();
    if (timestamp - lastPoll < pollMs) return null;
    lastPoll = timestamp;
    return fetchImpl('/api/seam_status')
      .then(response => response.json())
      .then(apply)
      .catch(() => {});
  }

  function status(tileId) {
    if (running.has(tileId)) return 'running';
    if (failed.has(tileId)) return 'failed';
    if (pending.has(tileId)) return 'pending';
    if (done.has(tileId)) return 'done';
    return null;
  }

  return { poll, apply, status, statusHtml: tileId => SEAM_HTML[status(tileId)] || null };
}
