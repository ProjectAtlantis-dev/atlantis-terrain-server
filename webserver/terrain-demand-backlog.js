const LANE_ORDER = [
  'dem', 'texture', 'coastline', 'hydrography', 'connectivity', 'bathymetry',
];

const LANE_LABEL = {
  dem: 'DEM',
  texture: 'tex',
  coastline: 'coast',
  hydrography: 'hydro',
  connectivity: 'conn',
  bathymetry: 'bathy',
};

const count = value => Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

export function formatBacklogAge(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return '0s';
  if (ageMs < 10_000) return `${(ageMs / 1000).toFixed(1)}s`;
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s`;
  return `${(ageMs / 60_000).toFixed(ageMs < 600_000 ? 1 : 0)}m`;
}

export function summarizeDemandBacklog(payload) {
  const lanes = payload?.lanes && typeof payload.lanes === 'object'
    ? payload.lanes
    : {};
  const details = [];
  let dropped = 0;
  let ignored = 0;
  let severity = 'idle';
  for (const name of LANE_ORDER) {
    const lane = lanes[name];
    if (!lane || typeof lane !== 'object') continue;
    const active = count(lane.claimedActiveCount);
    const stale = count(lane.staleActiveCount);
    const pending = count(lane.pendingCount);
    const retrying = count(lane.retryableFailureCount);
    const failed = count(lane.terminalFailureCount);
    const activeAgeMs = count(lane.oldestActiveAgeMs);
    const pendingAgeMs = count(lane.oldestPendingAgeMs);
    dropped += count(lane.totals?.dropped);
    ignored += count(lane.totals?.ignored);
    if (!(active || stale || pending || retrying || failed)) continue;

    const ages = [];
    if (pending) ages.push(`q ${formatBacklogAge(pendingAgeMs)}`);
    if (active) ages.push(`a ${formatBacklogAge(activeAgeMs)}`);
    let text = `${LANE_LABEL[name]} ${active}a/${pending}q`;
    if (ages.length) text += ` oldest ${ages.join(', ')}`;
    if (stale) text += ` · ${stale} stale-active`;
    if (retrying) text += ` · ${retrying} retry`;
    if (failed) text += ` · ${failed} failed`;
    details.push({
      name, text, active, stale, pending, retrying, failed,
      activeAgeMs, pendingAgeMs,
    });
    if (failed || (pending && pendingAgeMs >= 30_000)) severity = 'starved';
    else if (severity !== 'starved' && (
      stale || retrying || (pending && pendingAgeMs >= 5_000)
      || (active && activeAgeMs >= 30_000)
    )) severity = 'slow';
    else if (severity === 'idle') severity = 'busy';
  }

  const parts = details.map(detail => detail.text);
  if (!parts.length) parts.push('idle');
  if (dropped) parts.push(`${dropped} superseded`);
  if (ignored) parts.push(`${ignored} stale HTTP ignored`);
  return {
    severity,
    color: { idle: '#8f8', busy: '#8cf', slow: '#fc8', starved: '#f66' }[severity],
    text: parts.join(' · '),
    details,
    dropped,
    ignored,
    alertKey: `${severity}:${details.map(detail => [
      detail.name, detail.active, detail.stale, detail.pending,
      detail.retrying, detail.failed,
      Math.floor(detail.pendingAgeMs / 5000),
      Math.floor(detail.activeAgeMs / 5000),
    ].join('/')).join('|')}`,
  };
}
