const state = {
  apiBase: localStorage.getItem("apiBase") || "http://localhost:8787",
  user: null,
  workspaces: [],
  workspace: null,
  monitors: [],
  view: "overview",
  mentions: [],
  selectedMentionId: null,
  alerts: [],
  sourceHealth: []
};

const $ = (selector) => document.querySelector(selector);
const titles = {
  overview: ["Overview", "Workspace pulse across monitors, mentions, and alerts."],
  mentions: ["Mentions", "Filter and inspect mentions for a selected monitor."],
  alerts: ["Alerts", "Acknowledge or resolve negative mention alerts."],
  monitors: ["Monitors", "Manage keyword and Boolean monitors."],
  reports: ["Reports", "Daily report stubs from the reports worker."],
  settings: ["Settings", "API endpoint and notification delivery notes."],
  "source-health": ["Source health", "Availability matrix for discovery sources."]
};

const toast = $("#toast");
const dialog = $("#monitorDialog");

function notify(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 3200);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

async function api(path, options = {}) {
  const response = await fetch(`${state.apiBase}${path}`, {
    credentials: "include",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function panelFor(view) {
  const map = {
    overview: "#overviewPanel",
    mentions: "#mentionsPanel",
    alerts: "#alertsPanel",
    monitors: "#monitorsPanel",
    reports: "#reportsPanel",
    settings: "#settingsPanel",
    "source-health": "#sourceHealthPanel"
  };
  return $(map[view]);
}

function setView(view) {
  state.view = view;
  document.querySelectorAll(".nav").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  const [title, subtitle] = titles[view] || titles.overview;
  $("#pageTitle").textContent = title;
  $("#pageSubtitle").textContent = subtitle;
  $("#authPanel").classList.add("hidden");
  for (const key of Object.keys(titles)) {
    const panel = panelFor(key);
    if (panel) panel.classList.add("hidden");
  }
  if (!state.user) {
    if (view === "settings") {
      $("#settingsPanel").classList.remove("hidden");
    } else {
      $("#authPanel").classList.remove("hidden");
    }
    return;
  }
  const panel = panelFor(view);
  if (panel) panel.classList.remove("hidden");
}

function fillMonitorSelects() {
  for (const select of [$("#mentionMonitorSelect"), $("#alertMonitorSelect")]) {
    const previous = select.value;
    select.innerHTML = "";
    for (const monitor of state.monitors) {
      const option = document.createElement("option");
      option.value = monitor.monitor_id || monitor.id;
      option.textContent = monitor.name || option.value;
      select.appendChild(option);
    }
    if ([...select.options].some((item) => item.value === previous)) select.value = previous;
  }
}

async function refreshMonitors() {
  if (!state.workspace) return;
  const data = await api(`/v1/workspaces/${state.workspace.workspaceId}/monitors`);
  state.monitors = data.monitors || [];
  fillMonitorSelects();
}

async function refreshSourceHealth() {
  try {
    const data = await api("/v1/source-health");
    state.sourceHealth = data.sources || [];
  } catch {
    state.sourceHealth = [];
  }
}

function renderSourceGrid(target, sources) {
  target.innerHTML = "";
  if (!sources.length) {
    target.innerHTML = '<div class="empty">Source health unavailable.</div>';
    return;
  }
  for (const source of sources) {
    const item = document.createElement("div");
    item.className = "source-item";
    item.innerHTML = `<strong>${escapeHtml(source.source)}</strong><span class="avail ${escapeHtml(source.availability)}">${escapeHtml(source.availability)}</span><small>keyword ${source.capabilities?.keywordSearch ? "yes" : "no"} · boolean ${source.capabilities?.booleanSearch ? "yes" : "no"}</small>`;
    target.appendChild(item);
  }
}

async function loadOverviewStats() {
  $("#monitorCount").textContent = String(state.monitors.length);
  let mentions = 0;
  let alerts = 0;
  for (const monitor of state.monitors) {
    const monitorId = monitor.monitor_id || monitor.id;
    try {
      const mentionData = await api(`/v1/workspaces/${state.workspace.workspaceId}/monitors/${monitorId}/mentions?limit=100`);
      mentions += (mentionData.mentions || []).length;
    } catch {}
    try {
      const alertData = await api(`/v1/workspaces/${state.workspace.workspaceId}/monitors/${monitorId}/alerts`);
      alerts += (alertData.alerts || []).filter((item) => item.state !== "resolved").length;
    } catch {}
  }
  $("#mentionCount").textContent = String(mentions);
  $("#alertCount").textContent = String(alerts);
  const available = state.sourceHealth.filter((item) => !["degraded", "disabled", "contract-required"].includes(item.availability)).length;
  $("#sourceCoverage").textContent = state.sourceHealth.length ? `${available}/${state.sourceHealth.length}` : "—";
  renderSourceGrid($("#overviewSourceList"), state.sourceHealth.slice(0, 6));
}

function renderMonitors() {
  const list = $("#monitorList");
  list.innerHTML = "";
  if (!state.monitors.length) {
    list.innerHTML = '<div class="empty">No monitors yet. Create the first keyword or Boolean monitor.</div>';
    return;
  }
  for (const monitor of state.monitors) {
    const row = document.createElement("div");
    row.className = "monitor-row";
    row.innerHTML = `<div><strong>${escapeHtml(monitor.name || "Unnamed")}</strong><small>${escapeHtml(monitor.type || "monitor")} · ${escapeHtml(monitor.status || "unknown")}</small></div><span class="status-chip">${escapeHtml(monitor.priority || "normal")}</span>`;
    list.appendChild(row);
  }
}

function renderMentionDetail(mention) {
  const pane = $("#mentionDetail");
  if (!mention) {
    pane.classList.add("empty");
    pane.textContent = "Select a mention to inspect.";
    return;
  }
  pane.classList.remove("empty");
  pane.innerHTML = `
    <div class="eyebrow">${escapeHtml(mention.source)}</div>
    <h2>${escapeHtml(mention.title || mention.excerpt || "Untitled mention")}</h2>
    <p>${escapeHtml(mention.excerpt || "")}</p>
    <p><strong>Sentiment</strong> ${escapeHtml(mention.sentiment)} · <strong>Severity</strong> ${escapeHtml(mention.severity_score)} · <strong>Relevance</strong> ${escapeHtml(mention.relevance_score)}</p>
    <p><a href="${escapeHtml(mention.canonical_url || "#")}" target="_blank" rel="noreferrer">Open source</a></p>
  `;
}

function renderMentions() {
  const list = $("#mentionList");
  list.innerHTML = "";
  if (!state.mentions.length) {
    list.innerHTML = '<div class="empty">No mentions for these filters.</div>';
    renderMentionDetail(null);
    return;
  }
  for (const mention of state.mentions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `list-item${mention.id === state.selectedMentionId ? " active" : ""}`;
    button.innerHTML = `<strong>${escapeHtml(mention.title || mention.excerpt || "Untitled")}</strong><small>${escapeHtml(mention.source)} · ${escapeHtml(mention.sentiment)} · sev ${escapeHtml(mention.severity_score)}</small>`;
    button.addEventListener("click", () => {
      state.selectedMentionId = mention.id;
      renderMentions();
      renderMentionDetail(mention);
    });
    list.appendChild(button);
  }
  const selected = state.mentions.find((item) => item.id === state.selectedMentionId) || state.mentions[0];
  state.selectedMentionId = selected?.id ?? null;
  renderMentionDetail(selected || null);
}

async function loadMentions() {
  if (!state.workspace) return;
  const monitorId = $("#mentionMonitorSelect").value;
  if (!monitorId) {
    state.mentions = [];
    renderMentions();
    return;
  }
  const params = new URLSearchParams();
  params.set("limit", "50");
  const sentiment = $("#mentionSentiment").value;
  const minSeverity = $("#mentionMinSeverity").value;
  const source = $("#mentionSource").value.trim();
  if (sentiment) params.set("sentiment", sentiment);
  if (minSeverity) params.set("minSeverity", minSeverity);
  if (source) params.set("source", source);
  const data = await api(`/v1/workspaces/${state.workspace.workspaceId}/monitors/${monitorId}/mentions?${params}`);
  state.mentions = data.mentions || [];
  renderMentions();
}

function renderAlerts() {
  const list = $("#alertList");
  list.innerHTML = "";
  if (!state.alerts.length) {
    list.innerHTML = '<div class="empty">No alerts for this monitor.</div>';
    return;
  }
  for (const alert of state.alerts) {
    const row = document.createElement("div");
    row.className = "list-item";
    row.innerHTML = `
      <strong>${escapeHtml(alert.type || "alert")} · ${escapeHtml(alert.severity)}</strong>
      <small>${escapeHtml(alert.state)} · ${escapeHtml(alert.reason || "No reason")}</small>
      <div class="actions">
        <button type="button" class="secondary" data-action="acknowledged">Ack</button>
        <button type="button" class="primary" data-action="resolved">Resolve</button>
      </div>
    `;
    row.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", async () => {
        const monitorId = $("#alertMonitorSelect").value;
        try {
          await api(`/v1/workspaces/${state.workspace.workspaceId}/monitors/${monitorId}/alerts/${alert.id}`, {
            method: "PATCH",
            body: JSON.stringify({ state: button.dataset.action })
          });
          notify(`Alert ${button.dataset.action}`);
          await loadAlerts();
        } catch (error) {
          notify(error.message);
        }
      });
    });
    list.appendChild(row);
  }
}

async function loadAlerts() {
  if (!state.workspace) return;
  const monitorId = $("#alertMonitorSelect").value;
  if (!monitorId) {
    state.alerts = [];
    renderAlerts();
    return;
  }
  const data = await api(`/v1/workspaces/${state.workspace.workspaceId}/monitors/${monitorId}/alerts`);
  state.alerts = data.alerts || [];
  renderAlerts();
}

function renderSignedOut() {
  state.user = null;
  $("#newMonitorBtn").classList.add("hidden");
  $("#logoutBtn").classList.add("hidden");
  $("#sessionState").textContent = "Signed out";
  setView(state.view === "settings" ? "settings" : "overview");
}

async function renderSignedIn() {
  $("#newMonitorBtn").classList.remove("hidden");
  $("#logoutBtn").classList.remove("hidden");
  $("#sessionState").textContent = state.user?.email || "Signed in";
  $("#workspaceName").textContent = state.workspace?.workspaceName || "Workspace";
  $("#workspaceRole").textContent = state.workspace?.role || "—";
  renderMonitors();
  await refreshSourceHealth();
  renderSourceGrid($("#sourceHealthList"), state.sourceHealth);
  await loadOverviewStats();
  setView(state.view);
  if (state.view === "mentions") await loadMentions();
  if (state.view === "alerts") await loadAlerts();
}

async function bootstrap() {
  try {
    const me = await api("/v1/me");
    state.user = me.user;
    const data = await api("/v1/workspaces");
    state.workspaces = data.memberships || [];
    state.workspace = state.workspaces[0] || null;
    await refreshMonitors();
    await renderSignedIn();
  } catch {
    renderSignedOut();
  }
}

$("#signupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api("/v1/auth/signup", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    await bootstrap();
    notify("Account created");
  } catch (error) { notify(error.message); }
});

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api("/v1/auth/login", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    await bootstrap();
    notify("Signed in");
  } catch (error) { notify(error.message); }
});

$("#logoutBtn").addEventListener("click", async () => {
  try { await api("/v1/auth/logout", { method: "POST" }); } catch {}
  renderSignedOut();
});

$("#newMonitorBtn").addEventListener("click", () => dialog.showModal());
$("#cancelMonitor").addEventListener("click", () => dialog.close());

$("#monitorForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.workspace) return;
  const form = Object.fromEntries(new FormData(event.currentTarget));
  try {
    const created = await api(`/v1/workspaces/${state.workspace.workspaceId}/monitors`, {
      method: "POST",
      body: JSON.stringify({ name: form.name, type: form.type })
    });
    await api(`/v1/workspaces/${state.workspace.workspaceId}/monitors/${created.monitor.id}/queries`, {
      method: "POST",
      body: JSON.stringify({ rawQuery: form.query })
    });
    dialog.close();
    event.currentTarget.reset();
    await refreshMonitors();
    await renderSignedIn();
    notify("Monitor created");
  } catch (error) { notify(error.message); }
});

$("#apiForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  state.apiBase = String(form.get("apiBase") || "").replace(/\/$/, "") || "http://localhost:8787";
  localStorage.setItem("apiBase", state.apiBase);
  $("#apiForm").querySelector('[name="apiBase"]').value = state.apiBase;
  notify("API endpoint saved");
});

$("#mentionFilterBtn").addEventListener("click", () => loadMentions().catch((error) => notify(error.message)));
$("#mentionMonitorSelect").addEventListener("change", () => loadMentions().catch((error) => notify(error.message)));
$("#alertRefreshBtn").addEventListener("click", () => loadAlerts().catch((error) => notify(error.message)));
$("#alertMonitorSelect").addEventListener("change", () => loadAlerts().catch((error) => notify(error.message)));

for (const button of document.querySelectorAll(".nav")) {
  button.addEventListener("click", async () => {
    setView(button.dataset.view);
    try {
      if (!state.user) return;
      if (button.dataset.view === "overview") await loadOverviewStats();
      if (button.dataset.view === "mentions") await loadMentions();
      if (button.dataset.view === "alerts") await loadAlerts();
      if (button.dataset.view === "monitors") renderMonitors();
      if (button.dataset.view === "source-health") {
        await refreshSourceHealth();
        renderSourceGrid($("#sourceHealthList"), state.sourceHealth);
      }
    } catch (error) {
      notify(error.message);
    }
  });
}

$("#apiForm").querySelector('[name="apiBase"]').value = state.apiBase;
bootstrap();
