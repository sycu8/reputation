#!/usr/bin/env node
/**
 * Create a production collector workspace + monitors so the live pipeline has work.
 *
 * Usage:
 *   node scripts/bootstrap-production-collection.mjs
 *   API_BASE=https://reputa-api-production.sycu-lee.workers.dev node scripts/bootstrap-production-collection.mjs
 */
const API_BASE = (process.env.API_BASE || "https://reputa-api-production.sycu-lee.workers.dev").replace(/\/$/, "");
const EMAIL = (process.env.COLLECTOR_EMAIL || "collector@pulsewatch.orangecloud.vn").toLowerCase();
const PASSWORD = process.env.COLLECTOR_PASSWORD || "PulseWatch-Collect-2026!";
const WORKSPACE = process.env.COLLECTOR_WORKSPACE || "PulseWatch Live Collection";

const MONITORS = [
  { name: "Cloudflare", type: "company", query: "Cloudflare" },
  { name: "OrangeCloud", type: "brand", query: '"OrangeCloud" OR "PulseWatch"' },
  { name: "AI Agents", type: "product", query: '"AI agent" OR "AI agents"' }
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
  } catch (error) {
    if (error.status !== 409 && error.data?.error !== "account_exists") {
      // signup may return account_exists from DO as 409
    }
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
    const queries = await api(`/v1/workspaces/${workspaceId}/monitors/${monitorId}/queries`, { token });
    const hasQuery = (queries.queries || []).some((q) => q.rawQuery === spec.query);
    if (!hasQuery) {
      await api(`/v1/workspaces/${workspaceId}/monitors/${monitorId}/queries`, {
        method: "POST",
        token,
        body: { rawQuery: spec.query }
      });
      console.log(`  + query ${spec.query}`);
    }
  }

  console.log("\nCollector ready.");
  console.log(`  email: ${EMAIL}`);
  console.log(`  password: ${PASSWORD}`);
  console.log(`  app: https://reputa-dashboard-production.sycu-lee.workers.dev/app/`);
  console.log("Mentions appear after the next scheduler tick (~1 min) once discovery/crawl/AI complete.");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
