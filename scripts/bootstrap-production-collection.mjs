#!/usr/bin/env node
/**
 * Create / refresh the production collector workspace so discovery has work.
 * Starter plan = 3 monitors max — we enrich with multiple queries per monitor.
 *
 * Usage:
 *   node scripts/bootstrap-production-collection.mjs
 */
const API_BASE = (process.env.API_BASE || "https://reputa-api-production.sycu-lee.workers.dev").replace(/\/$/, "");
const EMAIL = (process.env.COLLECTOR_EMAIL || "collector@pulsewatch.orangecloud.vn").toLowerCase();
const PASSWORD = process.env.COLLECTOR_PASSWORD || "PulseWatch-Collect-2026!";
const WORKSPACE = process.env.COLLECTOR_WORKSPACE || "PulseWatch Live Collection";

/** Max 3 monitors on starter; pack coverage into queries instead. */
const MONITORS = [
  {
    name: "Cloudflare",
    type: "company",
    queries: [
      "Cloudflare",
      "\"Cloudflare Workers\" OR Workers.dev",
      "\"Cloudflare Outage\" OR \"Cloudflare downtime\""
    ]
  },
  {
    name: "OrangeCloud",
    type: "brand",
    queries: [
      "OrangeCloud OR PulseWatch OR reputation.orangecloud.vn",
      "\"social listening\" OR \"reputation monitoring\"",
      "\"giám sát\" OR \"lắng nghe mạng xã hội\""
    ]
  },
  {
    name: "AI Agents",
    type: "product",
    queries: [
      "\"AI agent\" OR \"AI agents\"",
      "OpenAI OR ChatGPT OR AgentCN",
      "ransomware OR \"data breach\" OR cybersecurity"
    ]
  }
];

async function api(path, { method = "GET", token, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || `HTTP ${response.status}`);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function main() {
  console.log(`API ${API_BASE}`);
  let token;
  let workspaceId;
  try {
    const signup = await api("/v1/auth/signup", {
      method: "POST",
      body: { email: EMAIL, password: PASSWORD, workspaceName: WORKSPACE }
    });
    token = signup.session.token;
    workspaceId = signup.workspace.id;
    console.log(`Created account ${EMAIL} (role=${signup.user.globalRole}) workspace=${workspaceId}`);
  } catch {
    const login = await api("/v1/auth/login", {
      method: "POST",
      body: { email: EMAIL, password: PASSWORD }
    });
    token = login.session.token;
    const workspaces = await api("/v1/workspaces", { token });
    workspaceId = workspaces.memberships?.[0]?.workspaceId;
    if (!workspaceId) throw new Error("login succeeded but no workspace membership found");
    console.log(`Logged in ${EMAIL} (role=${login.user.globalRole}) workspace=${workspaceId}`);
  }

  const existing = await api(`/v1/workspaces/${workspaceId}/monitors`, { token });
  const byName = new Map((existing.monitors || []).map((m) => [m.name, m.monitor_id || m.id]));

  for (const spec of MONITORS) {
    let monitorId = byName.get(spec.name);
    if (!monitorId) {
      const created = await api(`/v1/workspaces/${workspaceId}/monitors`, {
        method: "POST",
        token,
        body: { name: spec.name, type: spec.type }
      });
      monitorId = created.monitor?.id;
      console.log(`Created monitor ${spec.name} -> ${monitorId}`);
    } else {
      console.log(`Reuse monitor ${spec.name} -> ${monitorId}`);
    }
    const listed = await api(`/v1/workspaces/${workspaceId}/monitors/${monitorId}/queries`, { token });
    const have = new Set((listed.queries || []).map((q) => q.rawQuery));
    for (const rawQuery of spec.queries) {
      if (have.has(rawQuery)) continue;
      await api(`/v1/workspaces/${workspaceId}/monitors/${monitorId}/queries`, {
        method: "POST",
        token,
        body: { rawQuery }
      });
      console.log(`  + query ${rawQuery}`);
    }
  }

  console.log("\nCollector ready.");
  console.log(`  email: ${EMAIL}`);
  console.log(`  password: ${PASSWORD}`);
  console.log(`  app: https://reputa-dashboard-production.sycu-lee.workers.dev/app/`);
  console.log("Mentions appear after the next scheduler tick (~1–5 min).");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
