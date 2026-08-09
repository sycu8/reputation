import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import api from "../apps/api-worker/src/index.ts";
import {
  UserDirectoryDO,
  TenantDirectoryDO,
  MonitorDO,
  SchedulerShardDO
} from "../workers/state/src/index.ts";
import { hasCapability, isSuperAdminEmail } from "../packages/auth/src/index.ts";
import { monitorLimitFor } from "../packages/auth/src/entitlements.ts";

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
  async delete(key) { this.values.delete(key); }
}

function makeEnv() {
  return {
    USER_DIRECTORY: new FakeNamespace(UserDirectoryDO),
    TENANT_DIRECTORY: new FakeNamespace(TenantDirectoryDO),
    MONITOR_DO: new FakeNamespace(MonitorDO),
    SCHEDULER_SHARD: new FakeNamespace(SchedulerShardDO),
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

async function call(env, method, path, body, cookie) {
  const headers = { origin: "http://localhost:8788" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  return api.fetch(new Request(`https://api.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env);
}

function cookieFrom(response) {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  return setCookie.split(";", 1)[0];
}

async function signup(env, email, workspaceName) {
  const response = await call(env, "POST", "/v1/auth/signup", { email, password: "correct-horse-battery-staple", workspaceName });
  assert.equal(response.status, 201);
  const body = await response.json();
  return { cookie: cookieFrom(response), body };
}

test("RBAC and plan primitives are deterministic", () => {
  assert.equal(hasCapability("viewer", "monitor.read"), true);
  assert.equal(hasCapability("viewer", "monitor.create"), false);
  assert.equal(hasCapability("analyst", "monitor.create"), true);
  assert.equal(hasCapability("owner", "monitor.delete"), true);
  assert.equal(hasCapability("viewer", "monitor.delete", "super_admin"), true);
  assert.equal(monitorLimitFor("starter", false).value, 3);
  assert.equal(monitorLimitFor("business", false).value, 30);
  assert.deepEqual(monitorLimitFor("starter", true), { unlimited: true });
  assert.equal(isSuperAdminEmail("OWNER@example.com", "owner@example.com"), true);
});

test("multi-tenant isolation, monitor/query CRUD, audit, and session revocation", async () => {
  const env = makeEnv();
  const a = await signup(env, "alice@example.com", "Alice Co");
  const b = await signup(env, "bob@example.com", "Bob Co");
  const aWorkspace = a.body.workspace.id;
  const bWorkspace = b.body.workspace.id;
  assert.notEqual(aWorkspace, bWorkspace);

  const createMonitor = await call(env, "POST", `/v1/workspaces/${aWorkspace}/monitors`, { name: "Alice Co", type: "company" }, a.cookie);
  assert.equal(createMonitor.status, 201);
  const created = await createMonitor.json();
  const monitorId = created.monitor.id;

  const forbidden = await call(env, "GET", `/v1/workspaces/${aWorkspace}/monitors`, undefined, b.cookie);
  assert.equal(forbidden.status, 403);

  const queryCreate = await call(env, "POST", `/v1/workspaces/${aWorkspace}/monitors/${monitorId}/queries`, { rawQuery: '"Alice Co" AND NOT "Alice School"' }, a.cookie);
  assert.equal(queryCreate.status, 201);
  const query = await queryCreate.json();
  assert.match(query.rawQuery, /Alice Co/);

  const queryList = await call(env, "GET", `/v1/workspaces/${aWorkspace}/monitors/${monitorId}/queries`, undefined, a.cookie);
  assert.equal(queryList.status, 200);
  assert.equal((await queryList.json()).queries.length, 1);

  const aTenant = env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(aWorkspace));
  const bobUserId = b.body.user.id;
  const addViewer = await aTenant.fetch("https://do.internal/internal/memberships", {
    method: "POST",
    body: JSON.stringify({ actorUserId: a.body.user.id, userId: bobUserId, role: "viewer" })
  });
  assert.equal(addViewer.status, 200);

  const viewerCanRead = await call(env, "GET", `/v1/workspaces/${aWorkspace}/monitors`, undefined, b.cookie);
  assert.equal(viewerCanRead.status, 200);
  const viewerCannotCreate = await call(env, "POST", `/v1/workspaces/${aWorkspace}/monitors`, { name: "Denied", type: "brand" }, b.cookie);
  assert.equal(viewerCannotCreate.status, 403);

  const update = await call(env, "PATCH", `/v1/workspaces/${aWorkspace}/monitors/${monitorId}`, { name: "Alice Reputation" }, a.cookie);
  assert.equal(update.status, 200);
  assert.equal((await update.json()).monitor.name, "Alice Reputation");

  const audit = await aTenant.fetch("https://do.internal/internal/audit");
  const events = (await audit.json()).events;
  assert.ok(events.some((event) => event.action === "monitor.create" && event.target_id === monitorId));
  assert.ok(events.some((event) => event.action === "monitor.update" && event.target_id === monitorId));

  const monitorState = env.MONITOR_DO.get(env.MONITOR_DO.idFromName(`${aWorkspace}:${monitorId}`));
  const mentionWrite = await monitorState.fetch("https://do.internal/internal/mentions/upsert", {
    method: "POST",
    body: JSON.stringify({
      contentId: "content-test-1",
      canonicalUrl: "https://example.com/post",
      source: "web",
      title: "Customer complaint",
      excerpt: "Alice Co has not refunded me",
      discoveredAt: new Date().toISOString(),
      relevanceScore: 98,
      sentiment: "negative",
      sentimentConfidence: 0.97,
      severityScore: 82,
      topic: "refund",
      language: "en",
      rawR2Key: "content/test/raw.json",
      relevanceReason: "Boolean match",
      sentimentReason: "Direct complaint",
      severityReason: "High-confidence refund complaint",
      riskCategories: ["refund"],
      aiModel: "test",
      aiVersion: "v1"
    })
  });
  assert.equal(mentionWrite.status, 201);
  const mentionsApi = await call(env, "GET", `/v1/workspaces/${aWorkspace}/monitors/${monitorId}/mentions?sentiment=negative&minSeverity=60`, undefined, a.cookie);
  assert.equal(mentionsApi.status, 200);
  assert.equal((await mentionsApi.json()).mentions.length, 1);

  const remove = await call(env, "DELETE", `/v1/workspaces/${aWorkspace}/monitors/${monitorId}`, undefined, a.cookie);
  assert.equal(remove.status, 200);
  const monitorsAfterDelete = await call(env, "GET", `/v1/workspaces/${aWorkspace}/monitors`, undefined, a.cookie);
  assert.equal((await monitorsAfterDelete.json()).monitors.length, 0);

  const logout = await call(env, "POST", "/v1/auth/logout", undefined, a.cookie);
  assert.equal(logout.status, 200);
  const revoked = await call(env, "GET", "/v1/me", undefined, a.cookie);
  assert.equal(revoked.status, 401);
});
