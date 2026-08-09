import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import api from "../apps/api-worker/src/index.ts";
import {
  UserDirectoryDO,
  TenantDirectoryDO,
  MonitorDO,
  SchedulerShardDO,
  TenantBudgetDO
} from "../workers/state/src/index.ts";
import {
  StubBillingProvider,
  planFromPriceId
} from "../packages/billing/src/index.ts";
import { monitorLimitFor, PLAN_ENTITLEMENTS } from "../packages/auth/src/entitlements.ts";

class SqlAdapter {
  constructor() {
    this.db = new DatabaseSync(":memory:");
  }
  exec(query, ...bindings) {
    const statement = this.db.prepare(query);
    const trimmed = query.trim().toUpperCase();
    let values = [];
    if (trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA") || trimmed.includes(" RETURNING ")) {
      values = statement.all(...bindings);
    } else {
      statement.run(...bindings);
    }
    return {
      toArray: () => values,
      [Symbol.iterator]: function* () { yield* values; }
    };
  }
}

class FakeState {
  constructor() {
    const sql = new SqlAdapter();
    this.storage = {
      sql,
      transaction: async (closure) => closure()
    };
  }
}

class FakeNamespace {
  constructor(ClassRef) {
    this.ClassRef = ClassRef;
    this.instances = new Map();
  }
  idFromName(name) {
    return { name, toString: () => name };
  }
  get(id) {
    const name = id.name ?? id.toString();
    if (!this.instances.has(name)) this.instances.set(name, new this.ClassRef(new FakeState(), {}));
    const instance = this.instances.get(name);
    return {
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return instance.fetch(request);
      }
    };
  }
}

class FakeKV {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key) ?? null; }
  async put(key, value) { this.values.set(key, value); }
  async list({ prefix } = {}) {
    const keys = [...this.values.keys()]
      .filter((key) => !prefix || key.startsWith(prefix))
      .map((name) => ({ name }));
    return { keys };
  }
}

class FakeR2 {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.has(key) ? { key, body: this.values.get(key) } : null; }
  async put(key, value) { this.values.set(key, value); }
}

function makeEnv() {
  return {
    USER_DIRECTORY: new FakeNamespace(UserDirectoryDO),
    TENANT_DIRECTORY: new FakeNamespace(TenantDirectoryDO),
    MONITOR_DO: new FakeNamespace(MonitorDO),
    SCHEDULER_SHARD: new FakeNamespace(SchedulerShardDO),
    TENANT_BUDGET: new FakeNamespace(TenantBudgetDO),
    CONFIG_KV: new FakeKV(),
    RAW_CONTENT: new FakeR2(),
    ENVIRONMENT: "development",
    SESSION_COOKIE_NAME: "reputa_session",
    ALLOWED_ORIGINS: "http://localhost:8788",
    SUPER_ADMIN_EMAILS: "owner@example.com",
    BILLING_PROVIDER: "stub",
    BILLING_WEBHOOK_SECRET: "billing-test-secret"
  };
}

async function call(env, method, path, body, cookie, extraHeaders = {}) {
  const headers = { origin: "http://localhost:8788", ...extraHeaders };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  return api.fetch(new Request(`https://api.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
  }), env);
}

function cookieFrom(response) {
  return response.headers.get("set-cookie").split(";", 1)[0];
}

test("plan entitlements and price id mapping", () => {
  assert.equal(planFromPriceId("price_pro"), "pro");
  assert.equal(planFromPriceId("price_usd_99"), "business");
  assert.equal(planFromPriceId("unknown"), null);
  assert.equal(PLAN_ENTITLEMENTS.starter.priceUsdMonthly, 29);
  assert.equal(monitorLimitFor("starter", false).value, 3);
  assert.deepEqual(monitorLimitFor("business", true), { unlimited: true });
});

test("stub billing provider verifies shared secret and HMAC signatures", async () => {
  const provider = new StubBillingProvider();
  const payload = JSON.stringify({
    eventId: "evt_1",
    type: "subscription.updated",
    tenantId: "tenant_1",
    plan: "pro",
    status: "active"
  });
  const okSimple = await provider.verifyWebhook(new Request("https://api.test/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Billing-Signature": "billing-test-secret" },
    body: payload
  }), "billing-test-secret");
  assert.equal(okSimple.eventId, "evt_1");
  assert.equal(okSimple.plan, "pro");

  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("billing-test-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const hex = Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const okHmac = await provider.verifyWebhook(new Request("https://api.test/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Billing-Signature": `sha256=${hex}` },
    body: payload
  }), "billing-test-secret");
  assert.equal(okHmac.eventId, "evt_1");

  await assert.rejects(() => provider.verifyWebhook(new Request("https://api.test/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Billing-Signature": "bad" },
    body: payload
  }), "billing-test-secret"));
});

test("billing checkout, webhook plan update, and admin tenant listing", async () => {
  const env = makeEnv();
  const signup = await call(env, "POST", "/v1/auth/signup", {
    email: "owner@example.com",
    password: "correct-horse-battery-staple",
    workspaceName: "Owner Co"
  });
  assert.equal(signup.status, 201);
  const body = await signup.json();
  const cookie = cookieFrom(signup);
  const workspaceId = body.workspace.id;

  const checkout = await call(env, "POST", `/v1/workspaces/${workspaceId}/billing/checkout`, {
    plan: "pro",
    successUrl: "https://app.test/success",
    cancelUrl: "https://app.test/cancel"
  }, cookie);
  assert.equal(checkout.status, 200);
  const checkoutBody = await checkout.json();
  assert.match(checkoutBody.checkout.checkoutUrl, /billing\.stub\.local/);

  const webhookPayload = JSON.stringify({
    eventId: "evt_upgrade_1",
    type: "subscription.updated",
    tenantId: workspaceId,
    plan: "pro",
    status: "active"
  });
  const webhook = await call(env, "POST", "/v1/billing/webhook", webhookPayload, undefined, {
    "content-type": "application/json",
    "X-Billing-Signature": "billing-test-secret"
  });
  assert.equal(webhook.status, 200);
  const webhookBody = await webhook.json();
  assert.equal(webhookBody.duplicate, false);
  assert.equal(webhookBody.plan, "pro");

  const duplicate = await call(env, "POST", "/v1/billing/webhook", webhookPayload, undefined, {
    "content-type": "application/json",
    "X-Billing-Signature": "billing-test-secret"
  });
  assert.equal((await duplicate.json()).duplicate, true);

  const workspace = await call(env, "GET", `/v1/workspaces/${workspaceId}`, undefined, cookie);
  assert.equal((await workspace.json()).workspace.plan, "pro");

  const tenants = await call(env, "GET", "/v1/admin/tenants", undefined, cookie);
  assert.equal(tenants.status, 200);
  const tenantBody = await tenants.json();
  assert.equal(tenantBody.tenants.length >= 1, true);

  const sourceHealth = await call(env, "GET", "/v1/source-health");
  assert.equal(sourceHealth.status, 200);
  assert.equal((await sourceHealth.json()).sources.length > 0, true);

  const adminHealth = await call(env, "GET", "/v1/admin/source-health", undefined, cookie);
  assert.equal(adminHealth.status, 200);
});

test("TenantBudgetDO usage increment and month query", async () => {
  const budget = new TenantBudgetDO(new FakeState(), {});
  const increment = await budget.fetch(new Request("https://do.internal/internal/usage/increment", {
    method: "POST",
    body: JSON.stringify({ month: "2026-08", crawlRequests: 2, mentionsProcessed: 5, aiUnits: 1.5 })
  }));
  assert.equal(increment.status, 200);
  const first = await increment.json();
  assert.equal(first.usage.crawl_requests, 2);
  assert.equal(first.usage.mentions_processed, 5);

  await budget.fetch(new Request("https://do.internal/internal/usage/increment", {
    method: "POST",
    body: JSON.stringify({ month: "2026-08", crawlRequests: 3 })
  }));
  const usage = await budget.fetch(new Request("https://do.internal/internal/usage?month=2026-08"));
  const body = await usage.json();
  assert.equal(body.usage.crawl_requests, 5);
});
