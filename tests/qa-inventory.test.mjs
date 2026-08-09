import test from "node:test";
import assert from "node:assert/strict";
import api from "../apps/api-worker/src/index.ts";
import { apiCall } from "./helpers/local-env.mjs";
import { shardFromSessionCookie } from "./helpers/local-env.mjs";
import { buildSeededEnv, QA_PASSWORD } from "../scripts/seed-local-qa.mjs";

let world;

test("seed sanitized production-scale local world", async () => {
  world = await buildSeededEnv({ mentionsPerMonitor: 36 });
  assert.equal(world.stats.mentions, 108);
  assert.ok(world.stats.alertsCreated > 0);
  assert.equal(world.monitors.length, 3);
  assert.match(world.accounts.owner.email, /acme\.example$/);
});

test("A1 health and A2 source-health", async () => {
  const health = await apiCall(api, world.env, "GET", "/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");

  const sources = await apiCall(api, world.env, "GET", "/v1/source-health");
  assert.equal(sources.status, 200);
  const body = await sources.json();
  assert.ok(body.sources.length >= 9);
  const reddit = body.sources.find((item) => item.source === "reddit");
  assert.equal(reddit.availability, "contract-required");
});

test("A3/A4/A5/A6 auth session lifecycle", async () => {
  const bad = await apiCall(api, world.env, "POST", "/v1/auth/login", {
    email: world.accounts.owner.email,
    password: "wrong-password-xxxxxx"
  });
  assert.equal(bad.status, 401);

  const login = await apiCall(api, world.env, "POST", "/v1/auth/login", {
    email: world.accounts.owner.email,
    password: QA_PASSWORD
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);

  const me = await apiCall(api, world.env, "GET", "/v1/me", undefined, cookie);
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.email, world.accounts.owner.email);

  const logout = await apiCall(api, world.env, "POST", "/v1/auth/logout", undefined, cookie);
  assert.equal(logout.status, 200);
  const revoked = await apiCall(api, world.env, "GET", "/v1/me", undefined, cookie);
  assert.equal(revoked.status, 401);
});

test("A8 cross-tenant isolation and viewer cannot create", async () => {
  const forbidden = await apiCall(
    api,
    world.env,
    "GET",
    `/v1/workspaces/${world.accounts.owner.workspaceId}/monitors`,
    undefined,
    world.accounts.competitor.cookie
  );
  assert.equal(forbidden.status, 403);

  const viewerCreate = await apiCall(
    api,
    world.env,
    "POST",
    `/v1/workspaces/${world.accounts.owner.workspaceId}/monitors`,
    { name: "Should Fail", type: "brand" },
    world.accounts.viewer.cookie
  );
  assert.equal(viewerCreate.status, 403);

  const viewerRead = await apiCall(
    api,
    world.env,
    "GET",
    `/v1/workspaces/${world.accounts.owner.workspaceId}/monitors`,
    undefined,
    world.accounts.viewer.cookie
  );
  assert.equal(viewerRead.status, 200);
  assert.ok((await viewerRead.json()).monitors.length >= 3);
});

test("A8 starter plan limit edge case", async () => {
  // Acme already has 3 monitors on starter → fourth must 402
  const fourth = await apiCall(
    api,
    world.env,
    "POST",
    `/v1/workspaces/${world.accounts.owner.workspaceId}/monitors`,
    { name: "Over Limit", type: "company" },
    world.accounts.owner.cookie
  );
  assert.equal(fourth.status, 402);
});

test("A10 invalid boolean query", async () => {
  const monitorId = world.monitors[0].id;
  const bad = await apiCall(
    api,
    world.env,
    "POST",
    `/v1/workspaces/${world.accounts.owner.workspaceId}/monitors/${monitorId}/queries`,
    { rawQuery: '(unbalanced AND' },
    world.accounts.owner.cookie
  );
  assert.equal(bad.status, 400);
});

test("A11 mention filters and feedback", async () => {
  const monitorId = world.monitors[0].id;
  const ws = world.accounts.owner.workspaceId;
  const cookie = world.accounts.owner.cookie;

  const negative = await apiCall(api, world.env, "GET", `/v1/workspaces/${ws}/monitors/${monitorId}/mentions?sentiment=negative&minSeverity=60&limit=50`, undefined, cookie);
  assert.equal(negative.status, 200);
  const negBody = await negative.json();
  assert.ok(negBody.mentions.length > 0);
  assert.ok(negBody.mentions.every((item) => item.sentiment === "negative" && Number(item.severity_score) >= 60));

  const mentionId = negBody.mentions[0].id;
  const detail = await apiCall(api, world.env, "GET", `/v1/workspaces/${ws}/monitors/${monitorId}/mentions/${mentionId}`, undefined, cookie);
  assert.equal(detail.status, 200);

  const feedback = await apiCall(api, world.env, "POST", `/v1/workspaces/${ws}/monitors/${monitorId}/mentions/${mentionId}/feedback`, { action: "relevant" }, cookie);
  assert.equal(feedback.status, 200);
});

test("A12 alert ack/resolve workflow", async () => {
  const monitorId = world.monitors[0].id;
  const ws = world.accounts.owner.workspaceId;
  const cookie = world.accounts.owner.cookie;
  const listed = await apiCall(api, world.env, "GET", `/v1/workspaces/${ws}/monitors/${monitorId}/alerts`, undefined, cookie);
  assert.equal(listed.status, 200);
  const alerts = (await listed.json()).alerts;
  assert.ok(alerts.length > 0);
  const pending = alerts.find((item) => item.state === "pending") || alerts[0];
  const ack = await apiCall(api, world.env, "PATCH", `/v1/workspaces/${ws}/monitors/${monitorId}/alerts/${pending.id}`, { state: "acknowledged" }, cookie);
  assert.equal(ack.status, 200);
  const resolve = await apiCall(api, world.env, "PATCH", `/v1/workspaces/${ws}/monitors/${monitorId}/alerts/${pending.id}`, { state: "resolved" }, cookie);
  assert.equal(resolve.status, 200);
});

test("A13/A15 billing checkout and admin gate", async () => {
  const checkout = await apiCall(
    api,
    world.env,
    "POST",
    `/v1/workspaces/${world.accounts.owner.workspaceId}/billing/checkout`,
    { plan: "pro", successUrl: "http://127.0.0.1:8788/?ok=1", cancelUrl: "http://127.0.0.1:8788/?cancel=1" },
    world.accounts.owner.cookie
  );
  assert.equal(checkout.status, 200);
  assert.ok((await checkout.json()).checkout.checkoutUrl);

  const viewerCheckout = await apiCall(
    api,
    world.env,
    "POST",
    `/v1/workspaces/${world.accounts.owner.workspaceId}/billing/checkout`,
    { plan: "pro", successUrl: "http://127.0.0.1:8788/?ok=1", cancelUrl: "http://127.0.0.1:8788/?cancel=1" },
    world.accounts.viewer.cookie
  );
  assert.equal(viewerCheckout.status, 403);

  const adminDenied = await apiCall(api, world.env, "GET", "/v1/admin/tenants", undefined, world.accounts.owner.cookie);
  assert.equal(adminDenied.status, 403);

  const adminOk = await apiCall(api, world.env, "GET", "/v1/admin/tenants", undefined, world.accounts.ops.cookie);
  assert.equal(adminOk.status, 200);
  assert.ok((await adminOk.json()).tenants.length >= 1);
});

test("viewer membership includes Acme and insecure cookies for local-qa", async () => {
  const world = await buildSeededEnv({ mentionsPerMonitor: 3 });
  const listed = await apiCall(api, world.env, "GET", "/v1/workspaces", undefined, world.accounts.viewer.cookie);
  assert.equal(listed.status, 200);
  const memberships = (await listed.json()).memberships;
  assert.ok(memberships.some((item) => item.workspaceId === world.accounts.owner.workspaceId && item.role === "viewer"));

  const login = await apiCall(api, world.env, "POST", "/v1/auth/login", {
    email: world.accounts.owner.email,
    password: QA_PASSWORD
  });
  const setCookie = login.headers.get("set-cookie") || "";
  assert.equal(setCookie.includes("Secure"), false);
});

test("shardFromSessionCookie strips cookie name prefix", () => {
  assert.equal(shardFromSessionCookie("reputa_session=abc.def.ghi"), "abc");
});

test("D-shape: monitor directory fields usable by dashboard selects", async () => {
  const listed = await apiCall(
    api,
    world.env,
    "GET",
    `/v1/workspaces/${world.accounts.owner.workspaceId}/monitors`,
    undefined,
    world.accounts.owner.cookie
  );
  const monitors = (await listed.json()).monitors;
  for (const monitor of monitors) {
    const id = monitor.monitor_id || monitor.id;
    assert.ok(id, "monitor id missing for dashboard select");
    assert.ok(monitor.name);
  }
});

test("D11/D12 dashboard surfaces expose feedback, billing, admin, reports", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../apps/dashboard/public/index.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../apps/dashboard/public/app.js", import.meta.url), "utf8");
  assert.match(html, /id="billingForm"/);
  assert.match(html, /id="adminPanel"/);
  assert.match(html, /id="adminNavBtn"/);
  assert.match(html, /id="reportSentimentBars"/);
  assert.match(js, /FEEDBACK_ACTIONS/);
  assert.match(js, /canManageMonitors/);
  assert.match(js, /billing\/checkout/);
  assert.match(js, /\/v1\/admin\/tenants/);
  assert.match(js, /not_relevant/);
});
