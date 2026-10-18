import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BrowserPoolDO, browserPoolAdminAllowed } from "../workers/state/src/index.ts";
import { BROWSER_POOL_LEASE_TTL_MS, BROWSER_RUN_ACCOUNT_CONCURRENCY } from "../packages/crawler-core/src/index.ts";

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
    this.alarms = [];
    this.storage = {
      sql,
      transaction: async (closure) => closure(),
      setAlarm: async (when) => { this.alarms.push(when); },
      deleteAlarm: async () => { this.alarms.push(null); }
    };
  }
}

function acquireRequest(maxActive = BROWSER_RUN_ACCOUNT_CONCURRENCY) {
  return new Request("https://do.internal/internal/acquire", {
    method: "POST",
    body: JSON.stringify({ maxActive })
  });
}

test("stuck legacy counter does not block acquires; cap is the account concurrency", async () => {
  const fake = new FakeState();
  const pool = new BrowserPoolDO(fake, {});
  fake.storage.sql.exec(`UPDATE pool_state SET active=100, max_active=100 WHERE key='global'`);
  const response = await pool.fetch(acquireRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.granted, true);
  assert.equal(body.active, 1);
  assert.equal(body.maxActive, BROWSER_RUN_ACCOUNT_CONCURRENCY);
  assert.equal(typeof body.leaseId, "string");
  assert.ok(body.expiresAt > Date.now());
  assert.equal(fake.alarms.length, 1);
});

test("release by lease id frees the slot and a second release is a no-op", async () => {
  const pool = new BrowserPoolDO(new FakeState(), {});
  const first = await (await pool.fetch(acquireRequest())).json();
  const second = await (await pool.fetch(acquireRequest())).json();
  const released = await pool.fetch(new Request("https://do.internal/internal/release", {
    method: "POST",
    body: JSON.stringify({ leaseId: first.leaseId })
  }));
  const releasedBody = await released.json();
  assert.equal(releasedBody.ok, true);
  assert.equal(releasedBody.released, 1);
  assert.equal(releasedBody.active, 1);
  const again = await (await pool.fetch(new Request("https://do.internal/internal/release", {
    method: "POST",
    body: JSON.stringify({ leaseId: first.leaseId })
  }))).json();
  assert.equal(again.released, 0);
  assert.equal(again.active, 1);
  assert.equal(second.active, 2);
});

test("expired leases are swept by alarm and no longer count toward the cap", async () => {
  const fake = new FakeState();
  const pool = new BrowserPoolDO(fake, {});
  await pool.fetch(acquireRequest(1));
  const blocked = await pool.fetch(acquireRequest(1));
  assert.equal(blocked.status, 429);
  fake.storage.sql.exec(`UPDATE pool_leases SET expires_at=?`, Date.now() - 1000);
  await pool.alarm();
  const after = await (await pool.fetch(new Request("https://do.internal/internal/state"))).json();
  assert.equal(after.state.active, 0);
  const retried = await pool.fetch(acquireRequest(1));
  assert.equal(retried.status, 200);
});

test("lease ttl is long enough to cover a browser content action", () => {
  assert.ok(BROWSER_POOL_LEASE_TTL_MS >= 60_000);
});

test("release without a lease id frees the oldest lease", async () => {
  const pool = new BrowserPoolDO(new FakeState(), {});
  await pool.fetch(acquireRequest());
  await pool.fetch(acquireRequest());
  const released = await (await pool.fetch(new Request("https://do.internal/internal/release", {
    method: "POST",
    body: JSON.stringify({})
  }))).json();
  assert.equal(released.released, 1);
  assert.equal(released.active, 1);
});

test("reset clears leases and the legacy counter", async () => {
  const fake = new FakeState();
  const pool = new BrowserPoolDO(fake, { BROWSER_POOL_MAX: "2" });
  await pool.fetch(acquireRequest(50));
  await pool.fetch(acquireRequest(50));
  const full = await pool.fetch(acquireRequest(50));
  assert.equal(full.status, 429);
  const reset = await (await pool.fetch(new Request("https://do.internal/internal/reset", { method: "POST", body: "{}" }))).json();
  assert.equal(reset.ok, true);
  assert.equal(reset.cleared, 2);
  assert.equal(reset.maxActive, 2);
  const state = await (await pool.fetch(new Request("https://do.internal/internal/state"))).json();
  assert.equal(state.state.active, 0);
  assert.equal(state.state.maxActive, 2);
  const granted = await pool.fetch(acquireRequest(50));
  assert.equal(granted.status, 200);
});

test("browser pool admin route fails closed without a token", () => {
  assert.equal(browserPoolAdminAllowed(undefined, "Bearer secret"), "not_configured");
  assert.equal(browserPoolAdminAllowed("secret", "Bearer other"), "unauthorized");
  assert.equal(browserPoolAdminAllowed("secret", "Bearer secret"), "ok");
});
