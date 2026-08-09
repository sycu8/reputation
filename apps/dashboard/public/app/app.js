import { initTheme } from "./theme.js";

function isLocalDashboardHost() {
  const host = window.location.hostname || "127.0.0.1";
  return location.port === "8788" || host === "localhost" || host === "127.0.0.1";
}

/** Production API on the custom host (`/api/*` → API Worker). */
const PRODUCTION_API_BASE = "https://reputation.orangecloud.vn/api";

function resolveDefaultApiBase() {
  if (isLocalDashboardHost()) {
    const host = window.location.hostname || "127.0.0.1";
    return `http://${host}:8787`;
  }
  return PRODUCTION_API_BASE;
}

function isUsableApiBase(value) {
  try {
    const url = new URL(value);
    if (location.protocol === "https:" && url.protocol === "http:") return false;
    if (!isLocalDashboardHost() && url.port === "8787") return false;
    // Same-origin /api works after path-prefix strip on the custom host.
    if (url.hostname === location.hostname) {
      const path = url.pathname.replace(/\/$/, "");
      if (path !== "/api") return false;
    }
    // Dedicated API worker remains a valid manual override.
    if (url.hostname.endsWith(".workers.dev") && !url.hostname.startsWith("reputa-api-")) return false;
    return Boolean(url.origin);
  } catch {
    return false;
  }
}

function defaultApiBase() {
  const stored = localStorage.getItem("apiBase");
  if (stored && isUsableApiBase(stored)) {
    try {
      const url = new URL(stored);
      // Migrate older workers.dev defaults to the custom-host API base.
      if (
        !isLocalDashboardHost()
        && url.hostname === "reputa-api-production.sycu-lee.workers.dev"
      ) {
        localStorage.setItem("apiBase", PRODUCTION_API_BASE);
        return PRODUCTION_API_BASE;
      }
    } catch {
      /* fall through */
    }
    return stored.replace(/\/$/, "");
  }
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
  overview: ["Overview", "Hear what the market is saying about you — across monitors and channels."],
  mentions: ["Mentions", "Filter by time, channel, and sentiment. Inspect every story clearly."],
  insights: ["Insights", "Brand sentiment, audience mix, and competitor listening side-by-side."],
  alerts: ["Alerts", "Newest published stories first. Filter, open the source, then Ack or Resolve."],
  monitors: ["Monitors", "Manage brand and competitor monitors, including official website and social pages."],
  reports: ["Reports", "Presentation-ready listening rollups for stakeholders."],
  settings: ["Settings", "API endpoint, plan comparison, and Stripe upgrade."],
  "source-health": ["Source health", "Public and authorized channels — closed groups stay contract-required until access is granted."],
  admin: ["Admin", "Tenant registry and platform source health."]
};

const CONTENT_TYPE_LABELS = {
  news: "News",
  web: "Article",
  rss: "Blog post",
  reddit: "Reddit",
  youtube: "YouTube video",
  x: "X post",
  facebook: "Facebook",
  tiktok: "TikTok video",
  linkedin: "LinkedIn",
  facebook_group: "Facebook group",
  telegram: "Telegram group",
  zalo: "Zalo group",
  discord: "Discord server"
};

const CHANNEL_LABELS = {
  news: "News",
  web: "Web",
  rss: "Blogs / RSS",
  reddit: "Reddit",
  youtube: "YouTube",
  x: "X",
  facebook: "Facebook",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  facebook_group: "Facebook groups",
  telegram: "Telegram",
  zalo: "Zalo",
  discord: "Discord"
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

function contentTypeLabel(source) {
  const key = String(source || "unknown").toLowerCase();
  return CONTENT_TYPE_LABELS[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : "Unknown");
}

function channelLabel(source) {
  const key = String(source || "unknown").toLowerCase();
  return CHANNEL_LABELS[key] || contentTypeLabel(key);
}

function parseMentionDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatMentionTime(value) {
  const date = parseMentionDate(value);
  if (!date) return "Time unknown";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function formatMentionTimeLine(mention) {
  const published = parseMentionDate(mention.published_at);
  const discovered = parseMentionDate(mention.discovered_at);
  if (published) {
    const pub = formatMentionTime(mention.published_at);
    if (discovered) return `Published ${pub} · Found ${formatMentionTime(mention.discovered_at)}`;
    return `Published ${pub}`;
  }
  if (discovered) return `Found ${formatMentionTime(mention.discovered_at)}`;
  return "Time unknown";
}

function sentimentTagHtml(sentiment) {
  const key = String(sentiment || "unknown").toLowerCase();
  const label = key === "negative" || key === "neutral" || key === "positive" ? key : "unknown";
  return `<span class="tag tag-sentiment sentiment-${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}

function mentionTagsHtml(mention) {
  const source = String(mention.source || "unknown").toLowerCase();
  const severity = Number(mention.severity_score);
  const severityLabel = Number.isFinite(severity) ? `Severity ${Math.round(severity)}` : "Severity —";
  return `
    <div class="tag-row">
      <span class="tag tag-channel">${escapeHtml(contentTypeLabel(source))}</span>
      ${sentimentTagHtml(mention.sentiment)}
      <span class="tag tag-severity">${escapeHtml(severityLabel)}</span>
    </div>
  `;
}

function emptyChannelSentiment() {
  return { positive: 0, neutral: 0, negative: 0, unknown: 0 };
}

function renderChannelSentimentGrid(target, channelSentiment, emptyLabel = "No channel sentiment yet.") {
  if (!target) return;
  target.innerHTML = "";
  const entries = [...(channelSentiment || new Map()).entries()]
    .map(([source, counts]) => ({
      source,
      label: channelLabel(source),
      total: (counts.positive || 0) + (counts.neutral || 0) + (counts.negative || 0) + (counts.unknown || 0),
      counts
    }))
    .filter((item) => item.total > 0)
    .sort((a, b) => b.total - a.total);
  if (!entries.length) {
    target.innerHTML = `<div class="empty">${escapeHtml(emptyLabel)}</div>`;
    return;
  }
  for (const entry of entries) {
    const pos = entry.counts.positive || 0;
    const neu = entry.counts.neutral || 0;
    const neg = entry.counts.negative || 0;
    const unk = entry.counts.unknown || 0;
    const total = Math.max(entry.total, 1);
    const card = document.createElement("div");
    card.className = "channel-sentiment-card";
    card.innerHTML = `
      <div class="channel-sentiment-head">
        <strong>${escapeHtml(entry.label)}</strong>
        <span>${entry.total}</span>
      </div>
      <div class="sentiment-stack" aria-hidden="true">
        <span class="seg pos" style="width:${(pos / total) * 100}%"></span>
        <span class="seg neu" style="width:${(neu / total) * 100}%"></span>
        <span class="seg neg" style="width:${(neg / total) * 100}%"></span>
        <span class="seg unk" style="width:${(unk / total) * 100}%"></span>
      </div>
      <div class="channel-sentiment-legend">
        <span class="sentiment-positive">${pos} positive</span>
        <span class="sentiment-neutral">${neu} neutral</span>
        <span class="sentiment-negative">${neg} negative</span>
      </div>
    `;
    target.appendChild(card);
  }
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
  renderPlanChrome();
}

const PLAN_CATALOG = {
  free: {
    key: "free",
    name: "PulseWatch Free",
    priceLabel: "$0",
    audience: "Try listening",
    features: [
      "1 monitor",
      "1K mentions / month",
      "1 user",
      "Scan about every 30 min",
      "Basic email alerts"
    ]
  },
  starter: {
    key: "starter",
    name: "PulseWatch Starter",
    priceLabel: "$9.99",
    audience: "For individuals",
    features: [
      "3 monitors",
      "10K mentions / month",
      "1 user",
      "Scan about every 15 min",
      "Email alerts + basic reports"
    ]
  },
  pro: {
    key: "pro",
    name: "PulseWatch Pro",
    priceLabel: "$19.99",
    audience: "For professionals & SMBs",
    recommended: true,
    features: [
      "10 monitors",
      "50K mentions / month",
      "5 users",
      "Scan about every 10 min",
      "Priority alerts + competitor insights"
    ]
  },
  business: {
    key: "business",
    name: "PulseWatch Business",
    priceLabel: "$39.99",
    audience: "For teams",
    features: [
      "30 monitors",
      "200K mentions / month",
      "15 users",
      "Scan about every 5 min",
      "Priority support + API access"
    ]
  }
};

const STRIPE_PAYMENT_LINKS = {
  starter: "https://buy.stripe.com/bJe4gz4O21QO0f4dvecZa05",
  pro: "https://buy.stripe.com/00w00j2FU1QO8LA8aUcZa06",
  business: "https://buy.stripe.com/fZufZh3JY0MK3rg2QAcZa07"
};

function planSummary(planKey) {
  const plan = PLAN_CATALOG[planKey] || PLAN_CATALOG.free;
  return `${plan.features[0]} · ${plan.features[1]} · ${plan.features[2]}`;
}

function currentPlanKey() {
  const key = String(state.workspace?.plan || "free").toLowerCase();
  return PLAN_CATALOG[key] ? key : "free";
}

function renderPlanChrome() {
  const key = currentPlanKey();
  const plan = PLAN_CATALOG[key];
  const chip = $("#workspacePlan");
  if (chip) chip.textContent = state.workspace ? plan.name.replace("PulseWatch ", "") : "—";
  const nameEl = $("#planCurrentName");
  const summaryEl = $("#planCurrentSummary");
  if (nameEl) nameEl.textContent = state.workspace ? `${plan.name} — ${plan.priceLabel}/mo` : "—";
  if (summaryEl) summaryEl.textContent = state.workspace ? planSummary(key) : "";
  renderPlanCompareGrid();
}

function renderPlanCompareGrid() {
  const grid = $("#planCompareGrid");
  if (!grid) return;
  const current = currentPlanKey();
  const canPay = Boolean(state.user && state.workspace && canManageBilling());
  for (const card of grid.querySelectorAll("[data-plan-card]")) {
    const key = card.dataset.planCard;
    card.classList.toggle("is-current", key === current);
    const checkout = card.querySelector("[data-plan-checkout]");
    const freeAction = card.querySelector('[data-plan-action="free"]');
    if (key === current) {
      if (checkout) {
        checkout.disabled = true;
        checkout.textContent = "Current plan";
        checkout.className = "ghost";
      }
      if (freeAction) {
        freeAction.disabled = true;
        freeAction.textContent = "Current plan";
        freeAction.className = "ghost";
      }
      continue;
    }
    if (checkout) {
      checkout.disabled = !canPay;
      checkout.textContent = canPay ? "Pay with Stripe" : "Owner/admin only";
      checkout.className = key === "pro" ? "primary" : "secondary";
      if (!canPay) checkout.className = "ghost";
    }
    if (freeAction) {
      freeAction.disabled = true;
      freeAction.textContent = "Included at signup";
      freeAction.className = "secondary";
    }
  }
}

async function refreshWorkspaceDetails() {
  if (!state.workspace?.workspaceId) return;
  try {
    const data = await api(`/v1/workspaces/${state.workspace.workspaceId}`);
    const workspace = data.workspace || {};
    state.workspace = {
      ...state.workspace,
      plan: workspace.plan || state.workspace.plan || "free",
      workspaceName: workspace.name || state.workspace.workspaceName,
      status: workspace.status || state.workspace.status
    };
  } catch {
    state.workspace.plan = state.workspace.plan || "free";
  }
  renderPlanChrome();
}

const SESSION_TOKEN_KEY = "pulsewatch-session";

function getSessionToken() {
  try {
    return sessionStorage.getItem(SESSION_TOKEN_KEY) || localStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

function setSessionToken(token) {
  try {
    if (token) {
      sessionStorage.setItem(SESSION_TOKEN_KEY, token);
      localStorage.setItem(SESSION_TOKEN_KEY, token);
    } else {
      sessionStorage.removeItem(SESSION_TOKEN_KEY);
      localStorage.removeItem(SESSION_TOKEN_KEY);
    }
  } catch {
    /* ignore storage failures */
  }
}

function rememberSession(data) {
  const token = data?.session?.token;
  if (typeof token === "string" && token.split(".").length >= 3) {
    setSessionToken(token);
    return data;
  }
  throw new Error("missing_session_token");
}

async function api(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  const token = getSessionToken();
  if (token && !headers.authorization && !headers.Authorization) {
    headers.authorization = `Bearer ${token}`;
  }
  let response;
  try {
    response = await fetch(`${state.apiBase}${path}`, {
      credentials: "include",
      ...options,
      headers
    });
  } catch {
    throw new Error(`Failed to reach API at ${state.apiBase}. Check Settings → API base URL.`);
  }
  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    if (/just a moment|cf-chl|challenge-platform|cloudflare/i.test(raw)) {
      throw new Error("API blocked by Cloudflare challenge. Set API base to the workers.dev API in Settings, then retry.");
    }
    throw new Error(`HTTP ${response.status}`);
  }
  if (!response.ok) {
    const message = data.error || `HTTP ${response.status}`;
    if (message === "authentication_required" && !token && !path.startsWith("/v1/auth/")) {
      throw new Error("authentication_required");
    }
    if (message === "authentication_required") {
      throw new Error("authentication_required — sign in again (hard-refresh if this persists)");
    }
    throw new Error(message);
  }
  return data;
}

function panelFor(view) {
  const map = {
    overview: "#overviewPanel",
    mentions: "#mentionsPanel",
    insights: "#insightsPanel",
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

async function goToView(view) {
  if (!view) return;
  setView(view);
  if (!state.user) return;
  try {
    if (view === "overview") await loadOverviewStats();
    if (view === "mentions") await loadMentions();
    if (view === "insights") await loadInsights();
    if (view === "alerts") await loadAlerts();
    if (view === "monitors") renderMonitors();
    if (view === "reports") await loadReports();
    if (view === "settings") updateRoleChrome();
    if (view === "source-health") {
      await refreshSourceHealth();
      renderSourceGrid($("#sourceHealthList"), state.sourceHealth);
    }
    if (view === "admin") await loadAdmin();
  } catch (error) {
    notify(error.message);
  }
}

function fillMonitorSelects() {
  for (const select of [$("#mentionMonitorSelect"), $("#alertMonitorSelect"), $("#insightsBrandSelect"), $("#insightsCompetitorSelect")]) {
    if (!select) continue;
    const previous = select.value;
    select.innerHTML = "";
    if (select.id === "insightsCompetitorSelect") {
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "All other monitors";
      select.appendChild(none);
    }
    for (const monitor of state.monitors) {
      const option = document.createElement("option");
      option.value = monitor.monitor_id || monitor.id;
      option.textContent = monitor.name || option.value;
      select.appendChild(option);
    }
    if ([...select.options].some((item) => item.value === previous)) select.value = previous;
  }
  if ($("#insightsBrandSelect") && !$("#insightsBrandSelect").value && state.monitors[0]) {
    $("#insightsBrandSelect").value = state.monitors[0].monitor_id || state.monitors[0].id;
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
    const label = channelLabel(source.source);
    const closedNote = ["facebook_group", "telegram", "zalo", "discord"].includes(String(source.source))
      ? " · closed group — authorized access only"
      : "";
    item.innerHTML = `<strong>${escapeHtml(label)}</strong><span class="avail ${escapeHtml(source.availability)}">${escapeHtml(source.availability)}</span><small>keyword ${source.capabilities?.keywordSearch ? "yes" : "no"} · boolean ${source.capabilities?.booleanSearch ? "yes" : "no"}${escapeHtml(closedNote)}</small>`;
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
  const channelSentiment = new Map();
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
    let monitorPositive = 0;
    let monitorNeutral = 0;
    const monitorSources = new Map();
    const monitorChannelSentiment = new Map();
    for (const mention of mentions) {
      const sentiment = String(mention.sentiment || "unknown").toLowerCase();
      if (sentimentCounts[sentiment] === undefined) sentimentCounts.unknown += 1;
      else sentimentCounts[sentiment] += 1;
      if (sentiment === "negative") {
        negative += 1;
        monitorNegative += 1;
      } else if (sentiment === "positive") {
        monitorPositive += 1;
      } else if (sentiment === "neutral") {
        monitorNeutral += 1;
      }
      const source = mention.source || "unknown";
      sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
      monitorSources.set(source, (monitorSources.get(source) || 0) + 1);
      if (!channelSentiment.has(source)) channelSentiment.set(source, emptyChannelSentiment());
      if (!monitorChannelSentiment.has(source)) monitorChannelSentiment.set(source, emptyChannelSentiment());
      const bucket = sentimentCounts[sentiment] === undefined ? "unknown" : sentiment;
      channelSentiment.get(source)[bucket] += 1;
      monitorChannelSentiment.get(source)[bucket] += 1;
    }
    perMonitor.push({
      id: monitorId,
      name: monitor.name || monitorId,
      mentions: mentions.length,
      negative: monitorNegative,
      positive: monitorPositive,
      neutral: monitorNeutral,
      openAlerts: open,
      sourceCounts: monitorSources,
      channelSentiment: monitorChannelSentiment,
      mentionsRaw: mentions
    });
  }

  return {
    mentionTotal,
    negative,
    openAlerts,
    monitorTotal: state.monitors.length,
    sentimentCounts,
    sourceCounts,
    channelSentiment,
    perMonitor,
    generatedAt: new Date().toISOString()
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
  if ($("#overviewPulseTotal")) $("#overviewPulseTotal").textContent = String(stats.mentionTotal);
  renderOverviewPulse(stats);
  renderChannelSentimentGrid($("#overviewChannelSentiment"), stats.channelSentiment, "Collect mentions to see channel sentiment.");
  renderOverviewAlertTeaser(stats);
  renderSourceGrid($("#overviewSourceList"), state.sourceHealth.slice(0, 6));
}

function renderOverviewPulse(stats) {
  const stack = $("#overviewPulseStack");
  const legend = $("#overviewPulseLegend");
  if (!stack || !legend) return;
  const counts = stats?.sentimentCounts || { positive: 0, neutral: 0, negative: 0, unknown: 0 };
  const total = Math.max(
    (counts.positive || 0) + (counts.neutral || 0) + (counts.negative || 0) + (counts.unknown || 0),
    1
  );
  stack.innerHTML = `
    <span class="seg pos" style="width:${((counts.positive || 0) / total) * 100}%"></span>
    <span class="seg neu" style="width:${((counts.neutral || 0) / total) * 100}%"></span>
    <span class="seg neg" style="width:${((counts.negative || 0) / total) * 100}%"></span>
    <span class="seg unk" style="width:${((counts.unknown || 0) / total) * 100}%"></span>
  `;
  legend.innerHTML = `
    <span class="sentiment-positive">${counts.positive || 0} positive</span>
    <span class="sentiment-neutral">${counts.neutral || 0} neutral</span>
    <span class="sentiment-negative">${counts.negative || 0} negative</span>
  `;
}

function renderOverviewAlertTeaser(stats) {
  const target = $("#overviewAlertTeaser");
  if (!target) return;
  const rows = [];
  for (const monitor of stats?.perMonitor || []) {
    for (const mention of monitor.mentionsRaw || []) {
      if (String(mention.sentiment || "").toLowerCase() !== "negative") continue;
      rows.push({
        monitorName: monitor.name,
        title: mention.title || mention.excerpt || "Negative mention",
        source: mention.source,
        score: mention.severity_score,
        published_at: mention.published_at,
        discovered_at: mention.discovered_at,
        url: mention.canonical_url
      });
    }
  }
  rows.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  const top = rows.slice(0, 4);
  target.innerHTML = "";
  if (!top.length) {
    target.innerHTML = `
      <div class="empty overview-empty-cta">
        <p>No negative signals in the current sample.</p>
        <button type="button" class="secondary" data-go-view="mentions">Explore mentions anyway</button>
      </div>
    `;
    return;
  }
  for (const item of top) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "overview-teaser-item";
    card.dataset.goView = "alerts";
    card.innerHTML = `
      <div class="tag-row">
        <span class="tag tag-channel">${escapeHtml(contentTypeLabel(item.source))}</span>
        ${sentimentTagHtml("negative")}
        <span class="tag tag-severity">Score ${escapeHtml(Number.isFinite(Number(item.score)) ? Math.round(Number(item.score)) : "—")}</span>
      </div>
      <strong>${escapeHtml(item.title)}</strong>
      <small>${escapeHtml(item.monitorName)} · ${escapeHtml(formatMentionTimeLine(item))}</small>
    `;
    target.appendChild(card);
  }
}

function renderReports() {
  const stats = state.reportStats;
  const generated = $("#reportGeneratedAt");
  if (generated) {
    generated.textContent = stats?.generatedAt
      ? `Generated ${formatMentionTime(stats.generatedAt)}`
      : "";
  }
  if ($("#reportTitle")) {
    $("#reportTitle").textContent = state.workspace?.workspaceName
      ? `What the market is saying about ${state.workspace.workspaceName}`
      : "What the market is saying";
  }
  if (!stats) {
    $("#reportMentionTotal").textContent = "0";
    $("#reportNegative").textContent = "0";
    $("#reportOpenAlerts").textContent = "0";
    $("#reportMonitorTotal").textContent = String(state.monitors.length);
    renderBarList($("#reportSentimentBars"), [], "No mention data yet.");
    renderBarList($("#reportSourceBars"), [], "No source breakdown yet.");
    renderChannelSentimentGrid($("#reportChannelSentiment"), new Map());
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
    .map(([label, count]) => ({ label: channelLabel(label), count }));
  renderBarList($("#reportSourceBars"), sourceEntries, "No source breakdown yet.");
  renderChannelSentimentGrid($("#reportChannelSentiment"), stats.channelSentiment);

  const list = $("#reportMonitorBreakdown");
  list.innerHTML = "";
  if (!stats.perMonitor.length) {
    list.innerHTML = '<div class="empty">No monitors.</div>';
    return;
  }
  for (const row of stats.perMonitor) {
    const item = document.createElement("div");
    item.className = "monitor-row";
    item.innerHTML = `<div><strong>${escapeHtml(row.name)}</strong><small>${row.mentions} mentions · <span class="sentiment-negative">${row.negative} negative</span> · <span class="sentiment-positive">${row.positive || 0} positive</span> · ${row.openAlerts} open alerts</small></div>`;
    list.appendChild(item);
  }
}

function renderInsights() {
  const stats = state.reportStats;
  const brandId = $("#insightsBrandSelect")?.value;
  const competitorId = $("#insightsCompetitorSelect")?.value;
  const brand = stats?.perMonitor?.find((item) => item.id === brandId) || stats?.perMonitor?.[0];
  renderChannelSentimentGrid(
    $("#insightsSentimentByChannel"),
    brand?.channelSentiment || new Map(),
    "No brand mentions yet for this monitor."
  );

  const audienceEntries = [...(brand?.sourceCounts || new Map()).entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label: `${channelLabel(label)} · ${contentTypeLabel(label)}`, count }));
  renderBarList($("#insightsAudienceBars"), audienceEntries, "No audience / channel mix yet.");

  const table = $("#insightsCompetitorTable");
  if (!table) return;
  table.innerHTML = "";
  const rows = (stats?.perMonitor || []).filter((item) => {
    if (!brand) return true;
    if (item.id === brand.id) return true;
    if (competitorId) return item.id === competitorId;
    return true;
  });
  if (!rows.length) {
    table.innerHTML = '<div class="empty">Create brand and competitor monitors to compare.</div>';
    return;
  }
  const header = document.createElement("div");
  header.className = "competitor-row competitor-head";
  header.innerHTML = "<span>Monitor</span><span>Mentions</span><span>Positive</span><span>Neutral</span><span>Negative</span><span>Top channel</span>";
  table.appendChild(header);
  for (const row of rows) {
    const topChannel = [...(row.sourceCounts || new Map()).entries()].sort((a, b) => b[1] - a[1])[0];
    const el = document.createElement("div");
    el.className = `competitor-row${brand && row.id === brand.id ? " is-brand" : ""}`;
    el.innerHTML = `
      <strong>${escapeHtml(row.name)}${brand && row.id === brand.id ? " <em>you</em>" : ""}</strong>
      <span>${row.mentions}</span>
      <span class="sentiment-positive">${row.positive || 0}</span>
      <span class="sentiment-neutral">${row.neutral || 0}</span>
      <span class="sentiment-negative">${row.negative || 0}</span>
      <span>${escapeHtml(topChannel ? channelLabel(topChannel[0]) : "—")}</span>
    `;
    table.appendChild(el);
  }
}

async function loadInsights() {
  if (!state.workspace) return;
  state.reportStats = await collectWorkspaceAggregates();
  renderInsights();
}

async function loadReports() {
  if (!state.workspace) return;
  state.reportStats = await collectWorkspaceAggregates();
  renderReports();
}

function monitorProfileLinks(profile) {
  if (!profile || typeof profile !== "object") return [];
  const labels = {
    website: "Website",
    facebook: "Facebook",
    x: "X",
    linkedin: "LinkedIn",
    youtube: "YouTube",
    tiktok: "TikTok",
    instagram: "Instagram",
    reddit: "Reddit"
  };
  return Object.entries(labels)
    .filter(([key]) => typeof profile[key] === "string" && profile[key])
    .map(([key, label]) => ({ key, label, url: profile[key] }));
}

function renderMonitors() {
  const list = $("#monitorList");
  list.innerHTML = "";
  if (!state.monitors.length) {
    list.innerHTML = canManageMonitors()
      ? '<div class="empty">No monitors yet. Create one with keywords plus optional website / social pages.</div>'
      : '<div class="empty">No monitors in this workspace yet.</div>';
    return;
  }
  for (const monitor of state.monitors) {
    const row = document.createElement("div");
    row.className = "monitor-row";
    const links = monitorProfileLinks(monitor.profile);
    const linkHtml = links.length
      ? `<div class="monitor-profile-links">${links.map((item) =>
        `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.label)}</a>`
      ).join("")}</div>`
      : `<div class="monitor-profile-links muted">No website / social pages yet</div>`;
    const notes = typeof monitor.profile?.notes === "string" && monitor.profile.notes
      ? `<p class="monitor-notes">${escapeHtml(monitor.profile.notes)}</p>`
      : "";
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(monitor.name || "Unnamed")}</strong>
        <small>${escapeHtml(monitor.type || "monitor")} · ${escapeHtml(monitor.status || "unknown")}</small>
        ${linkHtml}
        ${notes}
      </div>
      <span class="status-chip">${escapeHtml(monitor.priority || "normal")}</span>
    `;
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
  const relevance = mention.relevance_score;
  pane.innerHTML = `
    ${mentionTagsHtml(mention)}
    <p class="mention-time">${escapeHtml(formatMentionTimeLine(mention))}</p>
    <h2>${escapeHtml(mention.title || mention.excerpt || "Untitled mention")}</h2>
    <p>${escapeHtml(mention.excerpt || "")}</p>
    <p class="mention-meta"><strong>Relevance</strong> ${escapeHtml(relevance)} · <strong>Topic</strong> ${escapeHtml(mention.topic || "—")} · <strong>Language</strong> ${escapeHtml(mention.language || "—")}</p>
    <p><a href="${escapeHtml(mention.canonical_url || "#")}" target="_blank" rel="noreferrer">Open original</a></p>
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
    button.innerHTML = `
      ${mentionTagsHtml(mention)}
      <strong>${escapeHtml(mention.title || mention.excerpt || "Untitled")}</strong>
      <small class="mention-time">${escapeHtml(formatMentionTimeLine(mention))}</small>
    `;
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
  params.set("limit", "100");
  const sentiment = $("#mentionSentiment").value;
  const minSeverity = $("#mentionMinSeverity").value;
  const source = $("#mentionSource").value.trim();
  const from = $("#mentionFrom")?.value;
  const to = $("#mentionTo")?.value;
  if (sentiment) params.set("sentiment", sentiment);
  if (minSeverity) params.set("minSeverity", minSeverity);
  if (source) params.set("source", source);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const data = await api(`/v1/workspaces/${state.workspace.workspaceId}/monitors/${monitorId}/mentions?${params}`);
  let mentions = data.mentions || [];
  // Client refine by published_at when parseable and outside the selected window.
  if (from || to) {
    const fromMs = from ? Date.parse(`${from}T00:00:00.000Z`) : null;
    const toMs = to ? Date.parse(`${to}T23:59:59.999Z`) : null;
    mentions = mentions.filter((mention) => {
      const event = parseMentionDate(mention.published_at) || parseMentionDate(mention.discovered_at);
      if (!event) return true;
      const ms = event.getTime();
      if (fromMs !== null && !Number.isNaN(fromMs) && ms < fromMs) return false;
      if (toMs !== null && !Number.isNaN(toMs) && ms > toMs) return false;
      return true;
    });
  }
  state.mentions = mentions;
  renderMentions();
}

function alertPublicationMs(alert) {
  const mention = alert?.mention || {};
  return (
    parseMentionDate(mention.published_at)?.getTime()
    || parseMentionDate(mention.discovered_at)?.getTime()
    || parseMentionDate(alert?.created_at)?.getTime()
    || 0
  );
}

function sortAlertsByPublication(alerts) {
  return (alerts || []).slice().sort((left, right) => alertPublicationMs(right) - alertPublicationMs(left));
}

function renderAlerts() {
  const list = $("#alertList");
  list.innerHTML = "";
  if (!state.alerts.length) {
    list.innerHTML = '<div class="empty">No alerts for these filters.</div>';
    return;
  }
  for (const alert of state.alerts) {
    const mention = alert.mention || null;
    const row = document.createElement("div");
    row.className = "list-item alert-item";
    const score = mention?.severity_score;
    const scoreLabel = Number.isFinite(Number(score)) ? `Score ${Math.round(Number(score))}` : "Score —";
    const timeLine = mention
      ? formatMentionTimeLine({
          published_at: mention.published_at,
          discovered_at: mention.discovered_at || alert.created_at
        })
      : `Alert ${formatMentionTime(alert.created_at)}`;
    const title = mention?.title || alert.reason || "Untitled alert";
    const excerpt = mention?.excerpt || alert.reason || "";
    const sourceUrl = mention?.canonical_url || "";
    row.innerHTML = `
      <div class="tag-row">
        ${mention?.source ? `<span class="tag tag-channel">${escapeHtml(contentTypeLabel(mention.source))}</span>` : ""}
        ${mention?.sentiment ? sentimentTagHtml(mention.sentiment) : ""}
        <span class="tag tag-severity severity-${escapeHtml(String(alert.severity || "unknown").toLowerCase())}">${escapeHtml(alert.severity || "severity")}</span>
        <span class="tag tag-severity">${escapeHtml(scoreLabel)}</span>
        <span class="tag tag-state">${escapeHtml(alert.state || "pending")}</span>
      </div>
      <strong>${escapeHtml(title)}</strong>
      <small class="mention-time">${escapeHtml(timeLine)}</small>
      <p class="alert-excerpt">${escapeHtml(excerpt)}</p>
      <div class="actions">
        ${sourceUrl
          ? `<a class="secondary alert-source-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">Open source</a>`
          : `<span class="hint">No source URL</span>`}
        <button type="button" class="secondary" data-action="acknowledged">Ack</button>
        <button type="button" class="primary" data-action="resolved">Resolve</button>
      </div>
    `;
    row.querySelectorAll("button[data-action]").forEach((button) => {
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
  const params = new URLSearchParams();
  params.set("limit", "100");
  const from = $("#alertFrom")?.value;
  const to = $("#alertTo")?.value;
  const minSeverity = $("#alertMinSeverity")?.value;
  const severity = $("#alertSeverity")?.value;
  const stateFilter = $("#alertState")?.value;
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (minSeverity) params.set("minSeverity", minSeverity);
  if (severity) params.set("severity", severity);
  if (stateFilter) params.set("state", stateFilter);
  const data = await api(`/v1/workspaces/${state.workspace.workspaceId}/monitors/${monitorId}/alerts?${params}`);
  let alerts = data.alerts || [];
  // Prefer publication time for From–To when the story timestamp is parseable.
  if (from || to) {
    const fromMs = from ? Date.parse(`${from}T00:00:00.000Z`) : null;
    const toMs = to ? Date.parse(`${to}T23:59:59.999Z`) : null;
    alerts = alerts.filter((alert) => {
      const ms = alertPublicationMs(alert);
      if (!ms) return true;
      if (fromMs !== null && !Number.isNaN(fromMs) && ms < fromMs) return false;
      if (toMs !== null && !Number.isNaN(toMs) && ms > toMs) return false;
      return true;
    });
  }
  state.alerts = sortAlertsByPublication(alerts);
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
  setSessionToken(null);
  document.body.classList.add("is-signed-out");
  updateRoleChrome();
  $("#logoutBtn").classList.add("hidden");
  $("#workspaceSwitchWrap").classList.add("hidden");
  $("#sessionState").textContent = "Signed out";
  $("#billingCheckoutResult").textContent = "";
  setView(state.view === "settings" ? "settings" : "overview");
}

async function renderSignedIn() {
  document.body.classList.remove("is-signed-out");
  $("#logoutBtn").classList.remove("hidden");
  $("#sessionState").textContent = state.user?.email || "Signed in";
  $("#workspaceName").textContent = state.workspace?.workspaceName || "Workspace";
  $("#workspaceRole").textContent = state.workspace?.role || "—";
  await refreshWorkspaceDetails();
  updateRoleChrome();
  renderMonitors();
  await refreshSourceHealth();
  renderSourceGrid($("#sourceHealthList"), state.sourceHealth);
  await loadOverviewStats();
  setView(state.view);
  if (state.view === "mentions") await loadMentions();
  if (state.view === "alerts") await loadAlerts();
  if (state.view === "insights") await loadInsights();
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
  } catch (error) {
    renderSignedOut();
    throw error;
  }
}

$("#signupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    rememberSession(await api("/v1/auth/signup", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) }));
    await bootstrap();
    notify("Account created");
  } catch (error) {
    notify(error.message || "signup_failed");
  }
});

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    rememberSession(await api("/v1/auth/login", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) }));
    await bootstrap();
    notify("Signed in");
  } catch (error) {
    notify(error.message || "login_failed");
  }
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
    const profile = {
      website: form.website || "",
      facebook: form.facebook || "",
      x: form.x || "",
      linkedin: form.linkedin || "",
      youtube: form.youtube || "",
      tiktok: form.tiktok || "",
      instagram: form.instagram || "",
      reddit: form.reddit || "",
      notes: form.notes || ""
    };
    const created = await api(`/v1/workspaces/${state.workspace.workspaceId}/monitors`, {
      method: "POST",
      body: JSON.stringify({ name: form.name, type: form.type, profile })
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

function openStripeCheckout(plan) {
  if (!state.workspace) {
    notify("Select a workspace first");
    return;
  }
  if (!canManageBilling()) {
    notify("forbidden");
    return;
  }
  const url = STRIPE_PAYMENT_LINKS[plan];
  const result = $("#billingCheckoutResult");
  if (!url) {
    notify("invalid_plan");
    return;
  }
  if (result) {
    result.innerHTML = `Opening Stripe for <strong>${escapeHtml(plan)}</strong>: <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
  }
  window.open(url, "_blank", "noopener,noreferrer");
  notify("Opening Stripe checkout");
}

$("#billingForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-plan-checkout]");
  if (!button) return;
  event.preventDefault();
  openStripeCheckout(button.dataset.planCheckout);
});

$("#mentionFilterBtn").addEventListener("click", () => loadMentions().catch((error) => notify(error.message)));
$("#mentionMonitorSelect").addEventListener("change", () => loadMentions().catch((error) => notify(error.message)));
$("#alertFilterBtn")?.addEventListener("click", () => loadAlerts().catch((error) => notify(error.message)));
$("#alertRefreshBtn").addEventListener("click", () => loadAlerts().catch((error) => notify(error.message)));
$("#alertMonitorSelect").addEventListener("change", () => loadAlerts().catch((error) => notify(error.message)));
$("#reportRefreshBtn")?.addEventListener("click", () => loadReports().catch((error) => notify(error.message)));
$("#reportPrintBtn")?.addEventListener("click", () => {
  document.body.classList.add("printing-report");
  window.print();
  setTimeout(() => document.body.classList.remove("printing-report"), 500);
});
$("#insightsRefreshBtn")?.addEventListener("click", () => loadInsights().catch((error) => notify(error.message)));
$("#insightsBrandSelect")?.addEventListener("change", () => renderInsights());
$("#insightsCompetitorSelect")?.addEventListener("change", () => renderInsights());
$("#adminRefreshBtn")?.addEventListener("click", () => loadAdmin().catch((error) => notify(error.message)));

$("#authSettingsLink")?.addEventListener("click", () => {
  setView("settings");
});
$("#backToAuthLink")?.addEventListener("click", () => {
  setView("overview");
});

for (const button of document.querySelectorAll(".nav")) {
  button.addEventListener("click", async () => {
    await goToView(button.dataset.view);
  });
}

document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-go-view]");
  if (!trigger) return;
  const view = trigger.dataset.goView;
  if (!view) return;
  event.preventDefault();
  goToView(view);
});

$("#apiForm").querySelector('[name="apiBase"]').value = state.apiBase;
initTheme();
bootstrap().catch(() => {
  /* signed-out on first paint is normal */
}).finally(() => {
  if (location.hash === "#signup") {
    $("#signupForm")?.scrollIntoView({ behavior: "smooth", block: "center" });
    $("#signupForm")?.querySelector('input[name="email"]')?.focus();
  }
});
