import { initTheme } from "./theme.js";

function isLocalDashboardHost() {
  const host = window.location.hostname || "127.0.0.1";
  return location.port === "8788" || host === "localhost" || host === "127.0.0.1";
}

function resolveDefaultApiBase() {
  const host = window.location.hostname || "127.0.0.1";
  if (isLocalDashboardHost()) return `http://${host}:8787`;
  if (host.endsWith(".workers.dev")) {
    return "https://reputa-api-production.sycu-lee.workers.dev";
  }
  // Same-origin Workers route on the custom hostname.
  return `${location.origin}/api`;
}

function isUsableApiBase(value) {
  try {
    const url = new URL(value);
    if (location.protocol === "https:" && url.protocol === "http:") return false;
    if (!isLocalDashboardHost() && url.port === "8787") return false;
    return Boolean(url.origin);
  } catch {
    return false;
  }
}

function defaultApiBase() {
  const stored = localStorage.getItem("apiBase");
  if (stored && isUsableApiBase(stored)) return stored.replace(/\/$/, "");
  if (stored) localStorage.removeItem("apiBase");
  return resolveDefaultApiBase();
}

const FEEDBACK_ACTIONS = [
  { action: "relevant", label: "Relevant" },
  { action: "not_relevant", label: "Not relevant" },
  { action: "wrong_sentiment", label: "Wrong sentiment" },
  { action: "resolved", label: "Resolved" },
  { action: "flagged", label: "Flag" }
];

const state = {
  apiBase: defaultApiBase(),
  user: null,
  workspaces: [],
  workspace: null,
  monitors: [],
  view: "overview",
  mentions: [],
  selectedMentionId: null,
  alerts: [],
  sourceHealth: [],
  reportStats: null,
  adminTenants: []
};

const $ = (selector) => document.querySelector(selector);
const titles = {
  overview: ["Overview", "Workspace pulse across monitors, mentions, and alerts."],
  mentions: ["Mentions", "Filter and inspect mentions for a selected monitor."],
  alerts: ["Alerts", "Acknowledge or resolve negative mention alerts."],
  monitors: ["Monitors", "Manage keyword and Boolean monitors."],
  reports: ["Reports", "Live mention and alert aggregates for this workspace."],
  settings: ["Settings", "API endpoint and billing checkout."],
  "source-health": ["Source health", "Availability matrix for discovery sources."],
  admin: ["Admin", "Tenant registry and platform source health."]
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

function canManageMonitors() {
  const role = state.workspace?.role;
  return role === "owner" || role === "admin" || state.user?.globalRole === "super_admin";
}

function canManageBilling() {
  return canManageMonitors();
}

function isSuperAdmin() {
  return state.user?.globalRole === "super_admin";
}

function updateRoleChrome() {
  const showNew = Boolean(state.user && state.workspace && canManageMonitors());
  $("#newMonitorBtn").classList.toggle("hidden", !showNew);
  $("#billingForm")?.classList.toggle("hidden", !(state.user && state.workspace && canManageBilling()));
  $("#adminNavBtn")?.classList.toggle("hidden", !isSuperAdmin());
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`${state.apiBase}${path}`, {
      credentials: "include",
      headers: { "content-type": "application/json", ...(options.headers || {}) },
      ...options
    });
  } catch {
    throw new Error(`Failed to reach API at ${state.apiBase}. Check Settings → API base URL.`);
  }
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
    "source-health": "#sourceHealthPanel",
    admin: "#adminPanel"
  };
  return $(map[view]);
}

function setView(view) {
  if (view === "admin" && !isSuperAdmin()) {
    view = "overview";
  }
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
      $("#appTopbar")?.classList.remove("hidden");
    } else {
      $("#authPanel").classList.remove("hidden");
      $("#appTopbar")?.classList.add("hidden");
    }
    return;
  }
  $("#appTopbar")?.classList.remove("hidden");
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

function renderBarList(target, entries, emptyLabel) {
  target.innerHTML = "";
  if (!entries.length) {
    target.innerHTML = `<div class="empty">${escapeHtml(emptyLabel)}</div>`;
    return;
  }
  const max = Math.max(...entries.map((item) => item.count), 1);
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "bar-row";
    const pct = Math.round((entry.count / max) * 100);
    row.innerHTML = `<span>${escapeHtml(entry.label)}</span><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><strong>${entry.count}</strong>`;
    target.appendChild(row);
  }
}

async function collectWorkspaceAggregates() {
  const sentimentCounts = { negative: 0, neutral: 0, positive: 0, unknown: 0 };
  const sourceCounts = new Map();
  const perMonitor = [];
  let mentionTotal = 0;
  let openAlerts = 0;
  let negative = 0;

  for (const monitor of state.monitors) {
    const monitorId = monitor.monitor_id || monitor.id;
    let mentions = [];
    let alerts = [];
    try {
      const mentionData = await api(`/v1/workspaces/${state.workspace.workspaceId}/monitors/${monitorId}/mentions?limit=100`);
      mentions = mentionData.mentions || [];
    } catch {}
    try {
      const alertData = await api(`/v1/workspaces/${state.workspace.workspaceId}/monitors/${monitorId}/alerts`);
      alerts = alertData.alerts || [];
    } catch {}

    mentionTotal += mentions.length;
    const open = alerts.filter((item) => item.state !== "resolved").length;
    openAlerts += open;
    let monitorNegative = 0;
    for (const mention of mentions) {
      const sentiment = String(mention.sentiment || "unknown").toLowerCase();
      if (sentimentCounts[sentiment] === undefined) sentimentCounts.unknown += 1;
      else sentimentCounts[sentiment] += 1;
      if (sentiment === "negative") {
        negative += 1;
        monitorNegative += 1;
      }
      const source = mention.source || "unknown";
      sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
    }
    perMonitor.push({
      id: monitorId,
      name: monitor.name || monitorId,
      mentions: mentions.length,
      negative: monitorNegative,
      openAlerts: open
    });
  }

  return {
    mentionTotal,
    negative,
    openAlerts,
    monitorTotal: state.monitors.length,
    sentimentCounts,
    sourceCounts,
    perMonitor
  };
}

async function loadOverviewStats() {
  $("#monitorCount").textContent = String(state.monitors.length);
  const stats = await collectWorkspaceAggregates();
  state.reportStats = stats;
  $("#mentionCount").textContent = String(stats.mentionTotal);
  $("#alertCount").textContent = String(stats.openAlerts);
  const available = state.sourceHealth.filter((item) => !["degraded", "disabled", "contract-required"].includes(item.availability)).length;
  $("#sourceCoverage").textContent = state.sourceHealth.length ? `${available}/${state.sourceHealth.length}` : "—";
  renderSourceGrid($("#overviewSourceList"), state.sourceHealth.slice(0, 6));
}

function renderReports() {
  const stats = state.reportStats;
  if (!stats) {
    $("#reportMentionTotal").textContent = "0";
    $("#reportNegative").textContent = "0";
    $("#reportOpenAlerts").textContent = "0";
    $("#reportMonitorTotal").textContent = String(state.monitors.length);
    renderBarList($("#reportSentimentBars"), [], "No mention data yet.");
    renderBarList($("#reportSourceBars"), [], "No source breakdown yet.");
    $("#reportMonitorBreakdown").innerHTML = '<div class="empty">No monitors.</div>';
    return;
  }
  $("#reportMentionTotal").textContent = String(stats.mentionTotal);
  $("#reportNegative").textContent = String(stats.negative);
  $("#reportOpenAlerts").textContent = String(stats.openAlerts);
  $("#reportMonitorTotal").textContent = String(stats.monitorTotal);

  const sentimentEntries = Object.entries(stats.sentimentCounts)
    .filter(([, count]) => count > 0)
    .map(([label, count]) => ({ label, count }));
  renderBarList($("#reportSentimentBars"), sentimentEntries, "No sentiment signals yet.");

  const sourceEntries = [...stats.sourceCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count }));
  renderBarList($("#reportSourceBars"), sourceEntries, "No source breakdown yet.");

  const list = $("#reportMonitorBreakdown");
  list.innerHTML = "";
  if (!stats.perMonitor.length) {
    list.innerHTML = '<div class="empty">No monitors.</div>';
    return;
  }
  for (const row of stats.perMonitor) {
    const item = document.createElement("div");
    item.className = "monitor-row";
    item.innerHTML = `<div><strong>${escapeHtml(row.name)}</strong><small>${row.mentions} mentions · ${row.negative} negative · ${row.openAlerts} open alerts</small></div>`;
    list.appendChild(item);
  }
}

async function loadReports() {
  if (!state.workspace) return;
  state.reportStats = await collectWorkspaceAggregates();
  renderReports();
}

function renderMonitors() {
  const list = $("#monitorList");
  list.innerHTML = "";
  if (!state.monitors.length) {
    list.innerHTML = canManageMonitors()
      ? '<div class="empty">No monitors yet. Create the first keyword or Boolean monitor.</div>'
      : '<div class="empty">No monitors in this workspace yet.</div>';
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
  const monitorId = $("#mentionMonitorSelect").value;
  pane.innerHTML = `
    <div class="eyebrow">${escapeHtml(mention.source)}</div>
    <h2>${escapeHtml(mention.title || mention.excerpt || "Untitled mention")}</h2>
    <p>${escapeHtml(mention.excerpt || "")}</p>
    <p><strong>Sentiment</strong> ${escapeHtml(mention.sentiment)} · <strong>Severity</strong> ${escapeHtml(mention.severity_score)} · <strong>Relevance</strong> ${escapeHtml(mention.relevance_score)}</p>
    <p><a href="${escapeHtml(mention.canonical_url || "#")}" target="_blank" rel="noreferrer">Open source</a></p>
    <div class="feedback-block">
      <div class="eyebrow">Feedback</div>
      <div class="feedback-actions" id="mentionFeedbackActions"></div>
    </div>
  `;
  const actions = $("#mentionFeedbackActions");
  for (const item of FEEDBACK_ACTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = item.label;
    button.addEventListener("click", async () => {
      if (!state.workspace || !monitorId) return;
      try {
        await api(`/v1/workspaces/${state.workspace.workspaceId}/monitors/${monitorId}/mentions/${mention.id}/feedback`, {
          method: "POST",
          body: JSON.stringify({ action: item.action })
        });
        notify(`Feedback saved: ${item.label}`);
      } catch (error) {
        notify(error.message);
      }
    });
    actions.appendChild(button);
  }
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

function renderAdminTenants() {
  const list = $("#adminTenantList");
  list.innerHTML = "";
  if (!state.adminTenants.length) {
    list.innerHTML = '<div class="empty">No tenant registry entries.</div>';
    return;
  }
  for (const tenant of state.adminTenants) {
    const row = document.createElement("div");
    row.className = "monitor-row";
    const name = tenant.name || tenant.workspaceName || tenant.id || "tenant";
    const plan = tenant.plan || "—";
    const id = tenant.id || tenant.workspaceId || "—";
    row.innerHTML = `<div><strong>${escapeHtml(name)}</strong><small>${escapeHtml(id)} · plan ${escapeHtml(plan)}</small></div><span class="status-chip">${escapeHtml(plan)}</span>`;
    list.appendChild(row);
  }
}

async function loadAdmin() {
  if (!isSuperAdmin()) return;
  const tenants = await api("/v1/admin/tenants");
  state.adminTenants = tenants.tenants || [];
  renderAdminTenants();
  try {
    const adminHealth = await api("/v1/admin/source-health");
    renderSourceGrid($("#adminSourceHealthList"), adminHealth.sources || []);
  } catch {
    await refreshSourceHealth();
    renderSourceGrid($("#adminSourceHealthList"), state.sourceHealth);
  }
}

function renderSignedOut() {
  state.user = null;
  state.workspace = null;
  state.workspaces = [];
  updateRoleChrome();
  $("#logoutBtn").classList.add("hidden");
  $("#workspaceSwitchWrap").classList.add("hidden");
  $("#sessionState").textContent = "Signed out";
  $("#billingCheckoutResult").textContent = "";
  setView(state.view === "settings" ? "settings" : "overview");
}

async function renderSignedIn() {
  $("#logoutBtn").classList.remove("hidden");
  $("#sessionState").textContent = state.user?.email || "Signed in";
  $("#workspaceName").textContent = state.workspace?.workspaceName || "Workspace";
  $("#workspaceRole").textContent = state.workspace?.role || "—";
  updateRoleChrome();
  renderMonitors();
  await refreshSourceHealth();
  renderSourceGrid($("#sourceHealthList"), state.sourceHealth);
  await loadOverviewStats();
  setView(state.view);
  if (state.view === "mentions") await loadMentions();
  if (state.view === "alerts") await loadAlerts();
  if (state.view === "reports") {
    renderReports();
  }
  if (state.view === "admin") await loadAdmin();
}

function pickDefaultWorkspace(memberships) {
  if (!memberships.length) return null;
  const preferred = memberships.find((item) => /acme/i.test(item.workspaceName || ""))
    || memberships.find((item) => item.role === "viewer" || item.role === "owner");
  return preferred || memberships[0];
}

function renderWorkspaceSwitcher() {
  const select = $("#workspaceSelect");
  const wrap = $("#workspaceSwitchWrap");
  if (!select || !wrap) return;
  select.innerHTML = "";
  for (const item of state.workspaces) {
    const option = document.createElement("option");
    option.value = item.workspaceId;
    option.textContent = `${item.workspaceName} (${item.role})`;
    select.appendChild(option);
  }
  if (state.workspace) select.value = state.workspace.workspaceId;
  wrap.classList.toggle("hidden", !state.user || state.workspaces.length < 2);
}

async function bootstrap() {
  try {
    const me = await api("/v1/me");
    state.user = me.user;
    const data = await api("/v1/workspaces");
    state.workspaces = data.memberships || [];
    state.workspace = pickDefaultWorkspace(state.workspaces);
    renderWorkspaceSwitcher();
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

$("#newMonitorBtn").addEventListener("click", () => {
  if (!canManageMonitors()) {
    notify("forbidden");
    return;
  }
  dialog.showModal();
});
$("#cancelMonitor").addEventListener("click", () => dialog.close());

$("#monitorForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.workspace) {
    notify("Select a workspace first");
    return;
  }
  if (!canManageMonitors()) {
    notify("forbidden");
    return;
  }
  const formEl = event.currentTarget;
  const form = Object.fromEntries(new FormData(formEl));
  if (!String(form.name || "").trim() || !String(form.query || "").trim() || !String(form.type || "").trim()) {
    notify("Name, type, and query are required");
    return;
  }
  try {
    const created = await api(`/v1/workspaces/${state.workspace.workspaceId}/monitors`, {
      method: "POST",
      body: JSON.stringify({ name: form.name, type: form.type })
    });
    const monitorId = created.monitor?.id;
    if (!monitorId) throw new Error("monitor_create_incomplete");
    await api(`/v1/workspaces/${state.workspace.workspaceId}/monitors/${monitorId}/queries`, {
      method: "POST",
      body: JSON.stringify({ rawQuery: form.query })
    });
    dialog.close();
    formEl.reset();
    await refreshMonitors();
    await renderSignedIn();
    notify("Monitor created");
  } catch (error) {
    notify(error.message || "monitor_create_failed");
  }
});

$("#workspaceSelect").addEventListener("change", async (event) => {
  const workspaceId = event.currentTarget.value;
  state.workspace = state.workspaces.find((item) => item.workspaceId === workspaceId) || null;
  try {
    await refreshMonitors();
    await renderSignedIn();
  } catch (error) {
    notify(error.message);
  }
});

$("#apiForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const next = String(form.get("apiBase") || "").replace(/\/$/, "") || resolveDefaultApiBase();
  if (!isUsableApiBase(next)) {
    notify("API base URL looks invalid for this page (use https production API, not :8787)");
    return;
  }
  state.apiBase = next;
  localStorage.setItem("apiBase", state.apiBase);
  $("#apiForm").querySelector('[name="apiBase"]').value = state.apiBase;
  notify("API endpoint saved");
});

$("#billingForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.workspace) {
    notify("Select a workspace first");
    return;
  }
  if (!canManageBilling()) {
    notify("forbidden");
    return;
  }
  const formEl = event.currentTarget;
  const plan = new FormData(formEl).get("plan");
  const origin = window.location.origin;
  try {
    const data = await api(`/v1/workspaces/${state.workspace.workspaceId}/billing/checkout`, {
      method: "POST",
      body: JSON.stringify({
        plan,
        successUrl: `${origin}/?billing=success`,
        cancelUrl: `${origin}/?billing=cancel`
      })
    });
    const url = data.checkout?.url || data.checkout?.checkoutUrl || "";
    const result = $("#billingCheckoutResult");
    if (url) {
      result.innerHTML = `Checkout ready (${escapeHtml(data.provider || "stub")}): <a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a>`;
      notify("Checkout session created");
    } else {
      result.textContent = JSON.stringify(data.checkout || data);
      notify("Checkout created");
    }
  } catch (error) {
    notify(error.message);
  }
});

$("#mentionFilterBtn").addEventListener("click", () => loadMentions().catch((error) => notify(error.message)));
$("#mentionMonitorSelect").addEventListener("change", () => loadMentions().catch((error) => notify(error.message)));
$("#alertRefreshBtn").addEventListener("click", () => loadAlerts().catch((error) => notify(error.message)));
$("#alertMonitorSelect").addEventListener("change", () => loadAlerts().catch((error) => notify(error.message)));
$("#reportRefreshBtn")?.addEventListener("click", () => loadReports().catch((error) => notify(error.message)));
$("#adminRefreshBtn")?.addEventListener("click", () => loadAdmin().catch((error) => notify(error.message)));

for (const button of document.querySelectorAll(".nav")) {
  button.addEventListener("click", async () => {
    setView(button.dataset.view);
    try {
      if (!state.user) return;
      if (button.dataset.view === "overview") await loadOverviewStats();
      if (button.dataset.view === "mentions") await loadMentions();
      if (button.dataset.view === "alerts") await loadAlerts();
      if (button.dataset.view === "monitors") renderMonitors();
      if (button.dataset.view === "reports") await loadReports();
      if (button.dataset.view === "settings") updateRoleChrome();
      if (button.dataset.view === "source-health") {
        await refreshSourceHealth();
        renderSourceGrid($("#sourceHealthList"), state.sourceHealth);
      }
      if (button.dataset.view === "admin") await loadAdmin();
    } catch (error) {
      notify(error.message);
    }
  });
}

$("#apiForm").querySelector('[name="apiBase"]').value = state.apiBase;
initTheme();
bootstrap();
