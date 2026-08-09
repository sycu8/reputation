/**
 * Sanitized production-scale seed for local QA.
 * Fake brands/emails only — no real customer PII.
 */
import api from "../apps/api-worker/src/index.ts";
import { apiCall, cookieFrom, makeLocalEnv, shardFromSessionCookie } from "../tests/helpers/local-env.mjs";

export const QA_PASSWORD = "Local-QA-Passphrase-2026!";

const MONITORS = [
  { name: "Northwind Traders", type: "company", query: '"Northwind Traders" OR Northwind' },
  { name: "Contoso Cloud", type: "brand", query: '"Contoso Cloud" AND NOT "Contoso School"' },
  { name: "Fabrikam Wallet", type: "product", query: '"Fabrikam Wallet" OR FabrikamWallet' }
];

const SOURCES = ["web", "news", "rss", "reddit", "youtube"];
const SENTIMENTS = ["negative", "neutral", "positive"];

function excerptFor(monitorName, sentiment, i) {
  if (sentiment === "negative") {
    return `${monitorName} still has not refunded order #QA-${1000 + i}. Support closed the ticket without resolution.`;
  }
  if (sentiment === "positive") {
    return `Impressed with ${monitorName} onboarding — clear docs and fast support for ticket QA-${1000 + i}.`;
  }
  return `Weekly digest mentioning ${monitorName} in a comparison roundup item QA-${1000 + i}.`;
}

async function seedMentions(env, workspaceId, monitorId, monitorName, count) {
  const stub = env.MONITOR_DO.get(env.MONITOR_DO.idFromName(`${workspaceId}:${monitorId}`));
  let alerts = 0;
  for (let i = 0; i < count; i += 1) {
    const sentiment = SENTIMENTS[i % SENTIMENTS.length];
    const severity = sentiment === "negative" ? 60 + (i % 35) : sentiment === "positive" ? 10 + (i % 20) : 20 + (i % 25);
    const source = SOURCES[i % SOURCES.length];
    const contentId = `seed:${monitorId}:${i}`;
    const write = await stub.fetch("https://do.internal/internal/mentions/upsert", {
      method: "POST",
      body: JSON.stringify({
        contentId,
        canonicalUrl: `https://example.test/mentions/${monitorId}/${i}`,
        source,
        title: `${monitorName} mention ${i + 1}`,
        excerpt: excerptFor(monitorName, sentiment, i),
        discoveredAt: new Date(Date.now() - i * 3600_000).toISOString(),
        publishedAt: new Date(Date.now() - i * 3600_000 - 60_000).toISOString(),
        relevanceScore: 70 + (i % 30),
        sentiment,
        sentimentConfidence: 0.55 + ((i % 40) / 100),
        severityScore: severity,
        topic: sentiment === "negative" ? "refund" : "general",
        language: i % 2 === 0 ? "en" : "vi",
        rawR2Key: `raw/seed/${monitorId}/${i}.json`,
        relevanceReason: "Seed Boolean match",
        sentimentReason: "Seed classifier",
        severityReason: "Seed severity",
        riskCategories: sentiment === "negative" ? ["refund"] : [],
        aiModel: "seed-fixture",
        aiVersion: "qa-1",
        simHash: (BigInt(i + 1) * 0x9e3779b97f4a7c15n & ((1n << 64n) - 1n)).toString(16).padStart(16, "0"),
        storyClusterId: `cluster-${monitorId}-${Math.floor(i / 7)}`
      })
    });
    if (!write.ok) throw new Error(`mention_seed_failed_${write.status}`);
    const result = await write.json();
    await env.RAW_CONTENT.put(`raw/seed/${monitorId}/${i}.json`, JSON.stringify({
      title: `${monitorName} mention ${i + 1}`,
      extractedText: excerptFor(monitorName, sentiment, i),
      source,
      sanitized: true
    }));

    if (sentiment === "negative" && severity >= 60) {
      const alert = await stub.fetch("https://do.internal/internal/alerts/upsert", {
        method: "POST",
        body: JSON.stringify({
          mentionId: result.mentionId,
          type: "negative_mention",
          severity: severity >= 76 ? "critical" : "high",
          dedupeKey: `seed-alert:${contentId}`,
          reason: excerptFor(monitorName, sentiment, i)
        })
      });
      if (alert.ok) {
        const alertBody = await alert.json();
        if (alertBody.created) {
          alerts += 1;
          const state = i % 5 === 0 ? "acknowledged" : i % 7 === 0 ? "resolved" : "pending";
          if (state !== "pending") {
            await stub.fetch(`https://do.internal/internal/alerts/${alertBody.alertId}`, {
              method: "PATCH",
              body: JSON.stringify({ state })
            });
          }
          await stub.fetch("https://do.internal/internal/alerts/deliveries/upsert", {
            method: "POST",
            body: JSON.stringify({
              alertId: alertBody.alertId,
              channel: "email",
              status: state === "resolved" ? "sent" : "pending",
              attempt: 1
            })
          });
        }
      }
    }
  }
  return alerts;
}

export async function buildSeededEnv(options = {}) {
  const mentionsPerMonitor = options.mentionsPerMonitor ?? 40;
  const env = makeLocalEnv(options.envOverrides);

  async function signup(email, workspaceName) {
    const response = await apiCall(api, env, "POST", "/v1/auth/signup", { email, password: QA_PASSWORD, workspaceName });
    if (response.status !== 201) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`signup_failed:${email}:${response.status}:${err.error || ""}`);
    }
    const body = await response.json();
    return { cookie: cookieFrom(response), body };
  }

  const owner = await signup("owner@acme.example", "Acme Listening");
  const viewer = await signup("viewer@acme.example", "Viewer Scratch");
  const competitor = await signup("owner@beacon.example", "Beacon Media");
  const ops = await signup("ops@pulsewatch.example", "PulseWatch Ops");

  const acmeId = owner.body.workspace.id;
  const acmePlan = await env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(acmeId)).fetch("https://do.internal/internal/workspace/plan", {
    method: "PATCH",
    body: JSON.stringify({ plan: "starter", actorUserId: owner.body.user.id })
  });
  if (!acmePlan.ok) throw new Error(`acme_plan_upgrade_${acmePlan.status}`);
  await env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(acmeId)).fetch("https://do.internal/internal/memberships", {
    method: "POST",
    body: JSON.stringify({ actorUserId: owner.body.user.id, userId: viewer.body.user.id, role: "viewer" })
  });
  const viewerShard = shardFromSessionCookie(viewer.cookie);
  if (!viewerShard) throw new Error("viewer_shard_missing");
  const membershipUpsert = await env.USER_DIRECTORY.get(env.USER_DIRECTORY.idFromName(viewerShard)).fetch("https://do.internal/internal/memberships", {
    method: "POST",
    body: JSON.stringify({ workspaceId: acmeId, workspaceName: owner.body.workspace.name, role: "viewer" })
  });
  if (!membershipUpsert.ok) throw new Error(`viewer_acme_membership_${membershipUpsert.status}`);
  const viewerMemberships = await env.USER_DIRECTORY.get(env.USER_DIRECTORY.idFromName(viewerShard)).fetch("https://do.internal/internal/memberships");
  const membershipBody = await viewerMemberships.json();
  if (!membershipBody.memberships?.some((item) => item.workspaceId === acmeId && item.role === "viewer")) {
    throw new Error("viewer_acme_membership_missing_after_upsert");
  }
  const monitors = [];
  let mentionTotal = 0;
  let alertTotal = 0;
  for (const spec of MONITORS) {
    const created = await apiCall(api, env, "POST", `/v1/workspaces/${acmeId}/monitors`, { name: spec.name, type: spec.type }, owner.cookie);
    if (created.status !== 201) throw new Error(`monitor_create_${created.status}`);
    const monitorBody = await created.json();
    const monitorId = monitorBody.monitor.id;
    const query = await apiCall(api, env, "POST", `/v1/workspaces/${acmeId}/monitors/${monitorId}/queries`, { rawQuery: spec.query }, owner.cookie);
    if (query.status !== 201) throw new Error(`query_create_${query.status}`);
    const alerts = await seedMentions(env, acmeId, monitorId, spec.name, mentionsPerMonitor);
    mentionTotal += mentionsPerMonitor;
    alertTotal += alerts;
    monitors.push({ id: monitorId, name: spec.name, type: spec.type, query: spec.query, mentions: mentionsPerMonitor, alerts });
  }

  const beaconMonitor = await apiCall(api, env, "POST", `/v1/workspaces/${competitor.body.workspace.id}/monitors`, { name: "Beacon Only", type: "brand" }, competitor.cookie);
  if (beaconMonitor.status !== 201) throw new Error(`beacon_monitor_${beaconMonitor.status}`);
  const beaconBody = await beaconMonitor.json();

  await env.CONFIG_KV.put(`notify:${acmeId}`, JSON.stringify({ email: "alerts@acme.example", telegramChatId: "10001" }));

  return {
    env,
    password: QA_PASSWORD,
    accounts: {
      owner: {
        email: "owner@acme.example",
        password: QA_PASSWORD,
        cookie: owner.cookie,
        workspaceId: acmeId,
        workspaceName: owner.body.workspace.name,
        userId: owner.body.user.id,
        globalRole: owner.body.user.globalRole
      },
      viewer: {
        email: "viewer@acme.example",
        password: QA_PASSWORD,
        cookie: viewer.cookie,
        workspaceId: acmeId,
        userId: viewer.body.user.id
      },
      competitor: {
        email: "owner@beacon.example",
        password: QA_PASSWORD,
        cookie: competitor.cookie,
        workspaceId: competitor.body.workspace.id,
        userId: competitor.body.user.id
      },
      ops: {
        email: "ops@pulsewatch.example",
        password: QA_PASSWORD,
        cookie: ops.cookie,
        workspaceId: ops.body.workspace.id,
        userId: ops.body.user.id,
        globalRole: ops.body.user.globalRole
      }
    },
    monitors,
    beaconMonitorId: beaconBody.monitor.id,
    stats: {
      workspaces: 4,
      monitors: monitors.length + 1,
      mentions: mentionTotal,
      alertsCreated: alertTotal,
      mentionsPerMonitor
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const world = await buildSeededEnv({ mentionsPerMonitor: Number(process.env.QA_MENTIONS_PER_MONITOR || 40) });
  console.log(JSON.stringify({ ok: true, stats: world.stats, monitors: world.monitors.map((m) => ({ id: m.id, name: m.name, alerts: m.alerts })) }, null, 2));
}
