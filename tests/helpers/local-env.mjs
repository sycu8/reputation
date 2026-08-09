import { DatabaseSync } from "node:sqlite";
import {
  UserDirectoryDO,
  TenantDirectoryDO,
  MonitorDO,
  SchedulerShardDO,
  TenantBudgetDO
} from "../../workers/state/src/index.ts";

export class SqlAdapter {
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

export class FakeState {
  constructor() {
    const sql = new SqlAdapter();
    this.storage = {
      sql,
      transaction: async (closure) => closure()
    };
  }
}

export class FakeNamespace {
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

export class FakeKV {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key) ?? null; }
  async put(key, value) { this.values.set(key, String(value)); }
  async list({ prefix } = {}) {
    const keys = [...this.values.keys()]
      .filter((key) => !prefix || key.startsWith(prefix))
      .map((name) => ({ name }));
    return { keys };
  }
}

export class FakeR2 {
  constructor() { this.values = new Map(); }
  async get(key) {
    if (!this.values.has(key)) return null;
    const value = this.values.get(key);
    return {
      key,
      async text() { return typeof value === "string" ? value : new TextDecoder().decode(value); },
      body: value
    };
  }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}

export function makeLocalEnv(overrides = {}) {
  return {
    USER_DIRECTORY: new FakeNamespace(UserDirectoryDO),
    TENANT_DIRECTORY: new FakeNamespace(TenantDirectoryDO),
    MONITOR_DO: new FakeNamespace(MonitorDO),
    SCHEDULER_SHARD: new FakeNamespace(SchedulerShardDO),
    TENANT_BUDGET: new FakeNamespace(TenantBudgetDO),
    CONFIG_KV: new FakeKV(),
    RAW_CONTENT: new FakeR2(),
    ENVIRONMENT: "local-qa",
    SESSION_COOKIE_NAME: "reputa_session",
    ALLOWED_ORIGINS: "http://127.0.0.1:8788,http://localhost:8788",
    SUPER_ADMIN_EMAILS: "ops@pulsewatch.example",
    BILLING_PROVIDER: "stub",
    BILLING_WEBHOOK_SECRET: "local-billing-secret",
    ...overrides
  };
}

export async function apiCall(api, env, method, path, body, cookie, origin = "http://127.0.0.1:8788") {
  const headers = { origin };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  return api.fetch(new Request(`https://api.local${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env);
}

export function cookieFrom(response) {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;
  return setCookie.split(";", 1)[0];
}

/** Extract Durable Object user-shard id from a `name=value` cookie pair. */
export function shardFromSessionCookie(cookie) {
  if (!cookie) return null;
  const value = cookie.includes("=") ? cookie.slice(cookie.indexOf("=") + 1) : cookie;
  return value.split(".")[0] || null;
}
