const state = {
  apiBase: localStorage.getItem("apiBase") || "http://localhost:8787",
  user: null,
  workspaces: [],
  workspace: null,
  monitors: []
};

const $ = (selector) => document.querySelector(selector);
const authPanel = $("#authPanel");
const appPanel = $("#appPanel");
const settingsPanel = $("#settingsPanel");
const toast = $("#toast");
const dialog = $("#monitorDialog");

function notify(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 3200);
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

async function bootstrap() {
  try {
    const me = await api("/v1/me");
    state.user = me.user;
    const data = await api("/v1/workspaces");
    state.workspaces = data.memberships || [];
    state.workspace = state.workspaces[0] || null;
    await refreshMonitors();
    renderSignedIn();
  } catch {
    renderSignedOut();
  }
}

async function refreshMonitors() {
  if (!state.workspace) return;
  const data = await api(`/v1/workspaces/${state.workspace.workspaceId}/monitors`);
  state.monitors = data.monitors || [];
}

function renderSignedOut() {
  state.user = null;
  authPanel.classList.remove("hidden");
  appPanel.classList.add("hidden");
  $("#newMonitorBtn").classList.add("hidden");
  $("#logoutBtn").classList.add("hidden");
  $("#sessionState").textContent = "Signed out";
}

function renderSignedIn() {
  authPanel.classList.add("hidden");
  appPanel.classList.remove("hidden");
  settingsPanel.classList.add("hidden");
  $("#newMonitorBtn").classList.remove("hidden");
  $("#logoutBtn").classList.remove("hidden");
  $("#sessionState").textContent = state.user?.email || "Signed in";
  $("#workspaceName").textContent = state.workspace?.workspaceName || "Workspace";
  $("#workspaceRole").textContent = state.workspace?.role || "—";
  $("#monitorCount").textContent = String(state.monitors.length);
  const list = $("#monitorList");
  list.innerHTML = "";
  if (!state.monitors.length) {
    list.innerHTML = '<div class="empty">No monitors yet. Create the first keyword or Boolean monitor.</div>';
    return;
  }
  for (const monitor of state.monitors) {
    const row = document.createElement("div");
    row.className = "monitor-row";
    row.innerHTML = `<div><strong>${escapeHtml(monitor.name || "Unnamed")}</strong><small>${escapeHtml(monitor.type || "monitor")} · ${escapeHtml(monitor.status || "unknown")}</small></div><span class="pill">${escapeHtml(monitor.priority || "normal")}</span>`;
    list.appendChild(row);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
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
    renderSignedIn();
    notify("Monitor created");
  } catch (error) { notify(error.message); }
});

$("#apiForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  state.apiBase = String(form.get("apiBase") || "").replace(/\/$/, "") || "http://localhost:8787";
  localStorage.setItem("apiBase", state.apiBase);
  notify("API endpoint saved");
});

for (const button of document.querySelectorAll(".nav")) {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    const view = button.dataset.view;
    $("#pageTitle").textContent = view === "settings" ? "Settings" : view === "monitors" ? "Monitors" : "Overview";
    settingsPanel.classList.toggle("hidden", view !== "settings");
    if (state.user) appPanel.classList.toggle("hidden", view === "settings");
    if (!state.user) authPanel.classList.toggle("hidden", view === "settings");
  });
}

bootstrap();
