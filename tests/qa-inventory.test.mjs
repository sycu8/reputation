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
  for (const key of ["facebook_group", "telegram", "zalo", "discord"]) {
    const closed = body.sources.find((item) => item.source === key);
    assert.ok(closed, `missing closed-group source ${key}`);
    assert.equal(closed.availability, "contract-required");
  }
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
  assert.ok(alerts.some((item) => item.mention && (item.mention.canonical_url || item.mention.title || item.mention_id || item.mention.id)));
  const pending = alerts.find((item) => item.state === "pending") || alerts[0];
  const ack = await apiCall(api, world.env, "PATCH", `/v1/workspaces/${ws}/monitors/${monitorId}/alerts/${pending.id}`, { state: "acknowledged" }, cookie);
  assert.equal(ack.status, 200);
  const resolve = await apiCall(api, world.env, "PATCH", `/v1/workspaces/${ws}/monitors/${monitorId}/alerts/${pending.id}`, { state: "resolved" }, cookie);
  assert.equal(resolve.status, 200);

  const filtered = await apiCall(
    api,
    world.env,
    "GET",
    `/v1/workspaces/${ws}/monitors/${monitorId}/alerts?minSeverity=0&limit=20`,
    undefined,
    cookie
  );
  assert.equal(filtered.status, 200);
  assert.ok(Array.isArray((await filtered.json()).alerts));
});

test("SUPER_ADMIN_EMAILS promotes an existing account on /v1/me", async () => {
  if (!world) world = await buildSeededEnv({ mentionsPerMonitor: 4 });
  const email = `promote-${Date.now()}@example.com`;
  const envNoAdmin = { ...world.env, SUPER_ADMIN_EMAILS: "" };
  const signup = await apiCall(api, envNoAdmin, "POST", "/v1/auth/signup", {
    email,
    password: QA_PASSWORD,
    workspaceName: "Promote WS"
  });
  assert.equal(signup.status, 201);
  const created = await signup.json();
  assert.equal(created.user.globalRole, "user");
  const token = created.session.token;

  const envAdmin = { ...world.env, SUPER_ADMIN_EMAILS: email };
  const me = await api.fetch(
    new Request("https://api.local/v1/me", {
      headers: { Authorization: `Bearer ${token}` }
    }),
    envAdmin
  );
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.globalRole, "super_admin");
});

test("deploy defaults SUPER_ADMIN_EMAILS to sycu.lee@gmail.com", async () => {
  const { readFileSync } = await import("node:fs");
  const deploy = readFileSync(new URL("../scripts/deploy-cloudspace.mjs", import.meta.url), "utf8");
  assert.match(deploy, /sycu\.lee@gmail\.com/);
  assert.match(deploy, /collector@pulsewatch\.orangecloud\.vn/);
  assert.match(deploy, /SUPER_ADMIN_EMAILS/);
  assert.match(deploy, /resolveSuperAdminEmails/);
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
  assert.match(setCookie, /SameSite=Lax/i);
});

test("production auth cookies are Secure + SameSite=None for cross-origin dashboard", async () => {
  const world = await buildSeededEnv({ mentionsPerMonitor: 1 });
  world.env.ENVIRONMENT = "production";
  world.env.ALLOWED_ORIGINS = "https://reputa-dashboard-production.sycu-lee.workers.dev,https://reputation.orangecloud.vn";

  const preflight = await api.fetch(
    new Request("http://localhost/v1/auth/login", {
      method: "OPTIONS",
      headers: {
        Origin: "https://reputa-dashboard-production.sycu-lee.workers.dev",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type"
      }
    }),
    world.env
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://reputa-dashboard-production.sycu-lee.workers.dev");

  const login = await apiCall(api, world.env, "POST", "/v1/auth/login", {
    email: world.accounts.owner.email,
    password: QA_PASSWORD
  });
  assert.equal(login.status, 200);
  const body = await login.json();
  assert.ok(body.session?.token);
  const setCookie = login.headers.get("set-cookie") || "";
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=None/i);
  assert.match(setCookie, /Partitioned/i);

  const viaBearer = await api.fetch(
    new Request("https://api.local/v1/me", {
      method: "GET",
      headers: {
        Origin: "https://reputa-dashboard-production.sycu-lee.workers.dev",
        Authorization: `Bearer ${body.session.token}`
      }
    }),
    world.env
  );
  assert.equal(viaBearer.status, 200);
  assert.equal((await viaBearer.json()).user.email, world.accounts.owner.email);
});

test("custom-hostname /api prefix routes to the same handlers", async () => {
  const { normalizeApiPathname } = await import("../apps/api-worker/src/index.ts");
  assert.equal(normalizeApiPathname("/api/health"), "/health");
  assert.equal(normalizeApiPathname("/api/v1/me"), "/v1/me");
  assert.equal(normalizeApiPathname("/api/v1/auth/signup"), "/v1/auth/signup");
  assert.equal(normalizeApiPathname("/v1/me"), "/v1/me");
  assert.equal(normalizeApiPathname("/api"), "/");
  assert.equal(normalizeApiPathname("/health"), "/health");

  if (!world) world = await buildSeededEnv({ mentionsPerMonitor: 4 });
  const health = await api.fetch(new Request("https://reputation.orangecloud.vn/api/health"), world.env);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");

  const probeEmail = `api-prefix-${Date.now()}@example.com`;
  const signup = await api.fetch(
    new Request("https://reputation.orangecloud.vn/api/v1/auth/signup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: "https://reputation.orangecloud.vn"
      },
      body: JSON.stringify({
        email: probeEmail,
        password: QA_PASSWORD,
        workspaceName: "API Prefix Workspace"
      })
    }),
    world.env
  );
  assert.equal(signup.status, 201);
  const body = await signup.json();
  assert.ok(body.session?.token);

  const me = await api.fetch(
    new Request("https://reputation.orangecloud.vn/api/v1/me", {
      method: "GET",
      headers: {
        Origin: "https://reputation.orangecloud.vn",
        Authorization: `Bearer ${body.session.token}`
      }
    }),
    world.env
  );
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.email, probeEmail);

  const wrongMethod = await api.fetch(new Request("https://api.local/v1/auth/login"), world.env);
  assert.equal(wrongMethod.status, 405);
  assert.equal((await wrongMethod.json()).error, "method_not_allowed");
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
  const html = readFileSync(new URL("../apps/dashboard/public/app/index.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../apps/dashboard/public/app/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../apps/dashboard/public/app/styles.css", import.meta.url), "utf8");
  assert.match(html, /id="billingForm"/);
  assert.match(html, /id="adminPanel"/);
  assert.match(html, /id="adminNavBtn"/);
  assert.match(html, /id="reportSentimentBars"/);
  assert.match(html, /id="alertFrom"/);
  assert.match(html, /id="alertMinSeverity"/);
  assert.match(js, /alert\.mention/);
  assert.match(js, /Open source/);
  assert.match(js, /params\.set\("minSeverity"/);
  assert.match(html, /id="mentionFrom"/);
  assert.match(html, /id="mentionTo"/);
  assert.match(html, /facebook_group/);
  assert.match(html, /Including closed groups/);
  assert.match(html, /value="telegram"/);
  assert.match(html, /value="zalo"/);
  assert.match(html, /value="discord"/);
  assert.match(js, /facebook_group/);
  assert.match(js, /closed group — authorized access only/);
  assert.match(html, /Hear what the market is saying about you/);
  assert.match(html, /data-go-view="mentions"/);
  assert.match(html, /data-go-view="insights"/);
  assert.match(html, /overview-journeys/);
  assert.match(html, /overviewAlertTeaser/);
  assert.match(js, /goToView/);
  assert.match(js, /renderOverviewAlertTeaser/);
  assert.match(css, /\.journey-card/);
  assert.match(html, /Print \/ export report/);
  assert.match(js, /mentionTagsHtml/);
  assert.match(js, /sentiment-negative/);
  assert.match(js, /CONTENT_TYPE_LABELS/);
  assert.match(js, /loadInsights/);
  assert.match(js, /params\.set\("from"/);
  assert.match(css, /\.tag-sentiment\.sentiment-negative/);
  assert.match(css, /\.tag-sentiment\.sentiment-positive/);
  assert.match(css, /\.tag-sentiment\.sentiment-neutral/);
  assert.match(html, /href="\/docs\/index\.html"/);
  assert.match(js, /FEEDBACK_ACTIONS/);
  assert.match(js, /canManageMonitors/);
  assert.match(js, /STRIPE_PAYMENT_LINKS/);
  assert.match(js, /buy\.stripe\.com\/bJe4gz4O21QO0f4dvecZa05/);
  assert.match(js, /buy\.stripe\.com\/00w00j2FU1QO8LA8aUcZa06/);
  assert.match(js, /buy\.stripe\.com\/fZufZh3JY0MK3rg2QAcZa07/);
  assert.match(js, /\/v1\/admin\/tenants/);
  assert.match(js, /not_relevant/);
  assert.match(js, /resolveDefaultApiBase/);
  assert.match(js, /PRODUCTION_API_BASE/);
  assert.match(js, /reputa-api-production\.sycu-lee\.workers\.dev/);
  assert.match(js, /pulsewatch-session/);
  assert.match(js, /Bearer/);
  assert.match(js, /rememberSession/);
  assert.match(js, /missing_session_token/);
  assert.match(js, /PLAN_CATALOG/);
  assert.match(js, /PulseWatch Free/);
  assert.match(js, /\$9\.99/);
  assert.match(js, /\$19\.99/);
  assert.match(js, /\$39\.99/);
  assert.match(js, /data-plan-checkout/);
  assert.match(html, /PulseWatch by OrangeCloud/);
  assert.match(html, /PulseWatch Free/);
  assert.match(html, /PulseWatch Starter/);
  assert.match(html, /PulseWatch Pro/);
  assert.match(html, /PulseWatch Business/);
  assert.match(html, /Pay with Stripe/);
  assert.match(html, /Plans &amp; upgrade/);
  assert.match(html, /brand-mark\.svg/);
  assert.match(html, /Start on Free/);
  assert.match(html, /id="workspacePlan"/);
  assert.match(html, /\$9\.99/);
  assert.match(html, /\$19\.99/);
  assert.match(html, /\$39\.99/);
  assert.doesNotMatch(html, /OrangeCloud Reputation/);
  assert.doesNotMatch(html, /option value="starter">Starter</);
  assert.doesNotMatch(html, /\$29\/mo|\$49\/mo|\$99\/mo/);
});

test("marketing landing page uses PulseWatch brand guide surfaces", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../apps/dashboard/public/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../apps/dashboard/public/landing.css", import.meta.url), "utf8");
  const js = readFileSync(new URL("../apps/dashboard/public/landing.js", import.meta.url), "utf8");
  assert.match(html, /PulseWatch \| Social Listening/);
  assert.match(html, /Know what the Internet is saying/);
  assert.match(html, /about you\./);
  assert.match(html, /PulseWatch by OrangeCloud/);
  assert.match(html, /id="pricing"/);
  assert.match(html, /PulseWatch Free/);
  assert.match(html, /PulseWatch Starter/);
  assert.match(html, /PulseWatch Pro/);
  assert.match(html, /PulseWatch Business/);
  assert.match(html, /\$9\.99/);
  assert.match(html, /\$19\.99/);
  assert.match(html, /\$39\.99/);
  assert.match(html, /Start free/);
  assert.match(html, /href="\/app\/#signup"/);
  assert.match(html, /Open PulseWatch/);
  assert.match(html, /Create account/);
  assert.match(html, /href="\/app\/"/);
  assert.match(html, /product showcase/);
  assert.match(html, /og:title/);
  assert.match(css, /#F97316/);
  assert.match(css, /#0B1220/);
  assert.match(js, /IntersectionObserver/);
  assert.doesNotMatch(html, /OrangeCloud Reputation/);
  assert.doesNotMatch(html, /buy\.stripe\.com/);
  assert.doesNotMatch(html, /Subscribe with Stripe/);
  assert.doesNotMatch(html, /\$29|\$49|\$99/);
  assert.doesNotMatch(html, /id="signupForm"|id="loginForm"|\/v1\/auth\//);
});

test("product app signed-out gate is not a marketing landing", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../apps/dashboard/public/app/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../apps/dashboard/public/app/styles.css", import.meta.url), "utf8");
  const js = readFileSync(new URL("../apps/dashboard/public/app/app.js", import.meta.url), "utf8");
  assert.match(html, /is-signed-out/);
  assert.match(html, /Back to PulseWatch/);
  assert.match(html, /Sign in to your workspace/);
  assert.match(html, /id="signupForm"/);
  assert.match(html, /id="loginForm"/);
  assert.match(css, /body\.is-signed-out \.sidebar/);
  assert.match(js, /classList\.add\("is-signed-out"\)/);
  assert.doesNotMatch(html, /Know what the Internet is saying about you/);
});
test("password hashing stays within Workers PBKDF2 iteration limit", async () => {
  const { readFileSync } = await import("node:fs");
  const state = readFileSync(new URL("../workers/state/src/index.ts", import.meta.url), "utf8");
  assert.match(state, /PASSWORD_ITERATIONS = 100_000/);
  assert.doesNotMatch(state, /PASSWORD_ITERATIONS = 210_000/);
  assert.match(state, /MAX_PASSWORD_ITERATIONS = 100_000/);
});

test("queue workers export fetch health handlers", async () => {
  const { readFileSync } = await import("node:fs");
  for (const service of ["processor", "discovery", "crawler-fetch", "crawler-browser", "alerts", "ai-classifier"]) {
    const src = readFileSync(new URL(`../workers/${service}/src/index.ts`, import.meta.url), "utf8");
    assert.match(src, /async fetch\(/);
    assert.match(src, /workerHealthResponse/);
  }
});

test("D13 API docs page documents core v1 surfaces", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../apps/dashboard/public/docs/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../apps/dashboard/public/docs/docs.css", import.meta.url), "utf8");
  assert.match(html, /PulseWatch API Reference/);
  assert.match(html, /\/v1\/auth\/signup/);
  assert.match(html, /\/v1\/workspaces\/\{workspaceId\}\/monitors/);
  assert.match(html, /billing\/checkout/);
  assert.match(html, /\/v1\/admin\/tenants/);
  assert.match(html, /PulseWatch by OrangeCloud/);
  assert.match(html, /PulseWatch Starter/);
  assert.match(html, /PulseWatch Free|free/);
  assert.doesNotMatch(html, /OrangeCloud Reputation/);
  assert.doesNotMatch(html, /<td><code>super_admin<\/code><\/td>/);
  assert.match(css, /--accent/);
  assert.match(css, /data-theme="light"/);
  assert.match(css, /#F97316/);
});

test("theme helper and dashboard expose light/dark mode toggle", async () => {
  const { readFileSync } = await import("node:fs");
  const theme = readFileSync(new URL("../apps/dashboard/public/theme.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../apps/dashboard/public/app/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../apps/dashboard/public/app/styles.css", import.meta.url), "utf8");
  const app = readFileSync(new URL("../apps/dashboard/public/app/app.js", import.meta.url), "utf8");
  assert.match(theme, /pulsewatch-theme/);
  assert.match(theme, /initTheme/);
  assert.match(html, /id="themeToggle"/);
  assert.match(html, /pulsewatch-theme/);
  assert.match(css, /data-theme="dark"/);
  assert.match(app, /initTheme/);
});
