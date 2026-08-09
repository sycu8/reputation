#!/usr/bin/env node
/**
 * Create / refresh the production collector workspace for max yield + accurate keywords.
 *
 * Collector is on the SUPER_ADMIN_EMAILS allowlist (ops) so it can run more monitors
 * and faster scan intervals than customer Starter limits.
 *
 * Usage:
 *   node scripts/bootstrap-production-collection.mjs
 */
const API_BASE = (process.env.API_BASE || "https://reputa-api-production.sycu-lee.workers.dev").replace(/\/$/, "");
const EMAIL = (process.env.COLLECTOR_EMAIL || "collector@pulsewatch.orangecloud.vn").toLowerCase();
const PASSWORD = process.env.COLLECTOR_PASSWORD || "PulseWatch-Collect-2026!";
const WORKSPACE = process.env.COLLECTOR_WORKSPACE || "PulseWatch Live Collection";
/** Fast ops cadence when collector is super_admin; otherwise API floors at 300s. */
const SCAN_INTERVAL_SEC = Number(process.env.COLLECTOR_SCAN_INTERVAL_SEC || 120);
const PRIORITY = process.env.COLLECTOR_PRIORITY || "priority";

/**
 * Precise Boolean keywords per monitor — maximize recall without topic bleed.
 * Vague industry terms that are not brand/product-specific are avoided on brand monitors.
 */
const MONITORS = [
  {
    name: "Cloudflare",
    type: "company",
    queries: [
      "Cloudflare",
      "\"Cloudflare Workers\" OR workers.dev",
      "\"Cloudflare Outage\" OR \"Cloudflare downtime\" OR \"Cloudflare down\"",
      "\"Durable Objects\" OR \"Workers AI\" OR \"Cloudflare R2\"",
      "\"Cloudflare Radar\" OR \"Cloudflare Warp\" OR \"Cloudflare DNS\"",
      "\"Cloudflare CDN\" OR \"Cloudflare Pages\" OR Wrangler"
    ]
  },
  {
    name: "OrangeCloud",
    type: "brand",
    queries: [
      "\"OrangeCloud\"",
      "PulseWatch",
      "reputation.orangecloud.vn",
      "\"PulseWatch\" AND (OrangeCloud OR reputation OR \"social listening\")",
      "\"OrangeCloud\" AND (Vietnam OR Cloudflare OR Workers)"
    ]
  },
  {
    name: "AI Agents",
    type: "product",
    queries: [
      "\"AI agent\" OR \"AI agents\"",
      "\"agentic AI\" OR \"autonomous agent\" OR \"AI coworker\"",
      "OpenAI OR ChatGPT OR \"GPT-4\" OR \"GPT-5\"",
      "Claude OR Anthropic OR \"Claude Code\"",
      "Gemini OR \"Google DeepMind\" OR AgentCN",
      "\"MCP server\" OR \"model context protocol\" OR \"tool use\""
    ]
  },
  {
    name: "Cybersecurity",
    type: "product",
    queries: [
      "ransomware OR \"data breach\" OR \"credential stuffing\"",
      "\"zero-day\" OR \"zero day\" OR CVE",
      "cybersecurity OR \"threat actor\" OR \"supply chain attack\"",
      "\"prompt injection\" OR \"AI jailbreak\" OR \"model poisoning\""
    ]
  },
  {
    name: "Vietnam Tech",
    type: "brand",
    queries: [
      "\"chuyển đổi số\" OR \"công nghệ\" Vietnam",
      "VNExpress OR \"Bộ TT&TT\" OR \"an toàn thông tin\"",
      "\"lừa đảo mạng\" OR \"tấn công mạng\" OR ransomware Vietnam",
      "FPT OR Viettel OR VNG OR \"Vingroup\""
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
  let role = "user";
  try {
    const signup = await api("/v1/auth/signup", {
      method: "POST",
      body: { email: EMAIL, password: PASSWORD, workspaceName: WORKSPACE }
    });
    token = signup.session.token;
    workspaceId = signup.workspace.id;
    role = signup.user.globalRole;
    console.log(`Created account ${EMAIL} (role=${role}) workspace=${workspaceId}`);
  } catch {
    const login = await api("/v1/auth/login", {
      method: "POST",
      body: { email: EMAIL, password: PASSWORD }
    });
    token = login.session.token;
    // Force allowlist sync (also done inside login after this deploy).
    const me = await api("/v1/me", { token });
    role = me.user?.globalRole || login.user.globalRole;
    const workspaces = await api("/v1/workspaces", { token });
    workspaceId = workspaces.memberships?.[0]?.workspaceId;
    if (!workspaceId) throw new Error("login succeeded but no workspace membership found");
    console.log(`Logged in ${EMAIL} (role=${role}) workspace=${workspaceId}`);
  }

  if (role !== "super_admin") {
    console.warn("Collector is not super_admin yet — monitor count/scan speed stay on plan limits.");
    console.warn("After deploy with SUPER_ADMIN_EMAILS including this email, re-run bootstrap.");
  }

  const existing = await api(`/v1/workspaces/${workspaceId}/monitors`, { token });
  const byName = new Map((existing.monitors || []).map((m) => [m.name, m.monitor_id || m.id]));

  for (const spec of MONITORS) {
    let monitorId = byName.get(spec.name);
    if (!monitorId) {
      try {
        const created = await api(`/v1/workspaces/${workspaceId}/monitors`, {
          method: "POST",
          token,
          body: {
            name: spec.name,
            type: spec.type,
            scanIntervalSec: SCAN_INTERVAL_SEC,
            priority: PRIORITY
          }
        });
        monitorId = created.monitor?.id;
        console.log(`Created monitor ${spec.name} -> ${monitorId} (scan=${SCAN_INTERVAL_SEC}s priority=${PRIORITY})`);
      } catch (error) {
        console.error(`Failed to create monitor ${spec.name}: ${error.message}`);
        continue;
      }
    } else {
      try {
        await api(`/v1/workspaces/${workspaceId}/monitors/${monitorId}`, {
          method: "PATCH",
          token,
          body: {
            scanIntervalSec: SCAN_INTERVAL_SEC,
            priority: PRIORITY,
            nextScanAt: new Date().toISOString()
          }
        });
        console.log(`Reuse monitor ${spec.name} -> ${monitorId} (boosted scan=${SCAN_INTERVAL_SEC}s)`);
      } catch (error) {
        console.log(`Reuse monitor ${spec.name} -> ${monitorId} (boost skipped: ${error.message})`);
      }
    }

    const listed = await api(`/v1/workspaces/${workspaceId}/monitors/${monitorId}/queries`, { token });
    const have = new Set((listed.queries || []).map((q) => q.rawQuery));
    // Disable vague legacy queries that dilute brand precision.
    const disableExact = new Set([
      "\"social listening\" OR \"reputation monitoring\"",
      "\"giám sát\" OR \"lắng nghe mạng xã hội\"",
      "\"brand monitoring\" OR \"media monitoring\"",
      "\"Orange Cloud\" OR OrangeCloud Vietnam",
      "OrangeCloud OR PulseWatch OR reputation.orangecloud.vn",
      "\"OrangeCloud\" OR \"PulseWatch\"",
      "ransomware OR \"data breach\" OR cybersecurity"
    ]);
    for (const q of listed.queries || []) {
      const queryId = q.id || q.query_id;
      if (!queryId || !disableExact.has(q.rawQuery)) continue;
      if (q.enabled === false) continue;
      try {
        await api(`/v1/workspaces/${workspaceId}/monitors/${monitorId}/queries/${queryId}`, {
          method: "PATCH",
          token,
          body: { enabled: false }
        });
        console.log(`  - disabled vague query ${q.rawQuery}`);
      } catch (error) {
        console.log(`  - disable skipped (${error.message}): ${q.rawQuery}`);
      }
    }
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

  console.log("\nCollector ready (max-yield profile).");
  console.log(`  email: ${EMAIL}`);
  console.log(`  password: ${PASSWORD}`);
  console.log(`  role: ${role}`);
  console.log(`  scanIntervalSec: ${SCAN_INTERVAL_SEC}`);
  console.log(`  app: https://reputa-dashboard-production.sycu-lee.workers.dev/app/`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
