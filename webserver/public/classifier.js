export function parseTileIds(value) {
  return [...new Set(
    String(value ?? "")
      .split(/[\s,]+/)
      .map(tile => tile.trim())
      .filter(Boolean),
  )];
}

export function validateLadderTileId(value) {
  const match = /^(\d+)-(\d+)-(\d+)$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const depth = Number(match[1]);
  if (depth < 8 || depth > 12) return null;
  return `${depth}-${Number(match[2])}-${Number(match[3])}`;
}

export function jobProgress(job) {
  const total = Number(job?.total) || 0;
  const processed = Number(job?.processed) || 0;
  return total ? Math.min(100, Math.round(100 * processed / total)) : 0;
}

const $ = id => document.getElementById(id);
const formatter = new Intl.NumberFormat();
let snapshot = null;
let pollTimer = null;

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;",
      '"': "&quot;", "'": "&#39;",
    })[char],
  );
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function dominantFractions(metrics) {
  const fractions = metrics?.stats?.fractions;
  if (!fractions) return [];
  return Object.entries(fractions)
    .filter(([, value]) => Number(value) >= 0.01)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, value]) => `${name} ${Math.round(value * 100)}%`);
}

function renderInventory(inventory) {
  $("current-rows").textContent = formatter.format(inventory.currentRows ?? 0);
  $("current-source").textContent = inventory.currentSource || "unknown source";
  $("ready-tiles").textContent = formatter.format(inventory.readyD12 ?? 0);
  $("legacy-rows").textContent = formatter.format(inventory.legacyRows ?? 0);
  $("coverage-pct").textContent = `${Number(inventory.coveragePct ?? 0).toFixed(2)}%`;
  $("total-rows").textContent = `${formatter.format(inventory.totalRows ?? 0)} rows`;

  const sources = inventory.sources ?? [];
  $("source-rows").innerHTML = sources.length
    ? sources.map(row => `
      <tr>
        <td>${escapeHtml(row.source)}</td>
        <td>${escapeHtml(row.schema)}</td>
        <td>${formatter.format(row.count)}</td>
        <td><span class="source-state ${row.current ? "current" : ""}">
          ${row.current ? "current" : "legacy"}
        </span></td>
      </tr>
    `).join("")
    : '<tr><td colspan="4" class="empty-cell">No classifier rows stored.</td></tr>';
}

function renderJob(job) {
  const state = job?.status || "idle";
  const active = state === "queued" || state === "running";
  const progress = jobProgress(job);
  $("job-state").textContent = state;
  $("job-state").className = `job-state ${state}`;
  $("progress-bar").style.width = `${progress}%`;
  $("progress-pct").textContent = `${progress}%`;
  $("progress-label").textContent = job?.total
    ? `${formatter.format(job.processed)} of ${formatter.format(job.total)} tiles`
    : "No job launched";
  $("current-tile").textContent = job?.currentTile || "—";
  $("job-succeeded").textContent = formatter.format(job?.succeeded ?? 0);
  $("job-skipped").textContent = formatter.format(job?.skipped ?? 0);
  $("job-failed").textContent = formatter.format(job?.failed ?? 0);
  $("job-time").textContent = formatDate(job?.completedAt || job?.startedAt);
  $("activity-log").innerHTML = (job?.recent?.length
    ? [...job.recent].reverse()
    : ["Waiting for a classifier job."]
  ).map(message => `<li>${escapeHtml(message)}</li>`).join("");
  $("launch-job").disabled = active;
  $("run-regressions").disabled = active || !(snapshot?.regressions?.length);
  $("system-label").textContent = active ? "Worker active" : "Backend online";
  $("system-dot").className = `state-dot live${state === "error" ? " error" : ""}`;
}

function renderRegressions(cases) {
  $("regression-count").textContent = formatter.format(cases.length);
  if (!cases.length) {
    $("regression-grid").innerHTML = `
      <div class="empty-regressions">
        <strong>No regression cases yet</strong>
        <span>Flag a tile from the terrain right-click menu to start the suite.</span>
      </div>`;
    return;
  }
  $("regression-grid").innerHTML = cases.map(item => {
    const fractions = dominantFractions(item.metrics);
    const figures = item.baked ? `
      <div class="comparison">
        <figure><img src="${escapeHtml(item.textureUrl)}" alt="Texture for ${escapeHtml(item.tile)}"><figcaption>texture</figcaption></figure>
        <figure><img src="${escapeHtml(item.classifierUrl)}" alt="Classifier result for ${escapeHtml(item.tile)}"><figcaption>classified</figcaption></figure>
      </div>` : `
      <div class="comparison">
        <figure><figcaption>not baked</figcaption></figure>
        <figure><figcaption>not baked</figcaption></figure>
      </div>`;
    return `
      <article class="regression-card">
        ${figures}
        <div class="regression-copy">
          <div class="regression-title">
            <a href="/training.html?tile=${encodeURIComponent(item.tile)}">${escapeHtml(item.tile)}</a>
            <span class="bake-state ${item.baked ? "" : "pending"}">${item.baked ? "baked" : "pending"}</span>
          </div>
          <p class="regression-note">${escapeHtml(item.note || "No review note")}</p>
          <div class="regression-meta">
            ${fractions.map(value => `<span>${escapeHtml(value)}</span>`).join("")}
            <span>${escapeHtml(formatDate(item.flaggedAt))}</span>
          </div>
        </div>
      </article>`;
  }).join("");
}

function updateScope() {
  const scope = $("job-scope").value;
  $("tile-field").classList.toggle("hidden", scope !== "selected");
  const notes = {
    selected: "Each target accumulates spatial votes from its D8 ancestor through the selected depth.",
    regressions: `${snapshot?.regressions?.length ?? 0} curated case(s) will be rebaked and compared.`,
    ready: `${formatter.format(snapshot?.inventory?.readyD12 ?? 0)} ready D12 targets, each with a D8→D12 ladder. This can be a long-running job.`,
  };
  $("scope-note").textContent = notes[scope];
  $("scope-note").className = `scope-note ${scope === "ready" ? "warning" : ""}`;
}

async function fetchStatus() {
  try {
    const response = await fetch("/api/classifier/jobs", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    snapshot = await response.json();
    renderInventory(snapshot.inventory);
    renderJob(snapshot.job);
    renderRegressions(snapshot.regressions);
    updateScope();
    $("form-error").textContent = "";
  } catch (error) {
    $("system-dot").className = "state-dot error";
    $("system-label").textContent = "Backend unavailable";
    $("form-error").textContent = `Status request failed: ${error.message}`;
  } finally {
    clearTimeout(pollTimer);
    const active = ["queued", "running"].includes(snapshot?.job?.status);
    pollTimer = setTimeout(fetchStatus, active ? 1000 : 5000);
  }
}

async function launchJob(scopeOverride = null) {
  const scope = scopeOverride || $("job-scope").value;
  const payload = {
    scope,
    useGoogle: $("use-google").checked,
  };
  if (scope === "selected") {
    payload.tiles = parseTileIds($("job-tiles").value);
    if (!payload.tiles.length) {
      $("form-error").textContent = "Enter at least one D8–D12 tile ID.";
      return;
    }
  }
  $("form-error").textContent = "";
  $("launch-job").disabled = true;
  try {
    const response = await fetch("/api/classifier/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    snapshot = { ...(snapshot || {}), job: result };
    renderJob(result);
    clearTimeout(pollTimer);
    pollTimer = setTimeout(fetchStatus, 350);
  } catch (error) {
    $("form-error").textContent = error.message;
    $("launch-job").disabled = false;
  }
}

export function initializeClassifierPage() {
  const requestedTile = validateLadderTileId(
    new URLSearchParams(location.search).get("tile"),
  );
  if (requestedTile) $("job-tiles").value = requestedTile;
  $("job-scope").addEventListener("change", updateScope);
  $("job-form").addEventListener("submit", event => {
    event.preventDefault();
    launchJob();
  });
  $("run-regressions").addEventListener("click", () => launchJob("regressions"));
  updateScope();
  fetchStatus();
}

if (typeof document !== "undefined" && $("job-form")) {
  initializeClassifierPage();
}
