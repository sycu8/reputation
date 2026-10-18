import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  classifyUpstreamStatus,
  domainBackoffDelayMs,
  fetchFailureAction,
  nextDomainBackoffMs,
  parseRetryAfterMs
} from "../workers/crawler-fetch/src/upstream.ts";
import { DomainCoordinatorDO } from "../workers/state/src/index.ts";

test("permanent 4xx are acked and 403/419 go to the browser", () => {
  for (const status of [400, 401, 402, 404, 405, 410, 422, 451]) {
    assert.equal(classifyUpstreamStatus(status), "permanent");
    assert.deepEqual(fetchFailureAction(`upstream_http_permanent:${status}`), { action: "ack" });
  }
  assert.equal(classifyUpstreamStatus(403), "browser");
  assert.equal(classifyUpstreamStatus(419), "browser");
  assert.equal(classifyUpstreamStatus(429), "backoff");
  assert.equal(classifyUpstreamStatus(408), "retry");
  assert.equal(classifyUpstreamStatus(520), "retry");
  assert.equal(classifyUpstreamStatus(503), "retry");
});

test("429 and domain backoff retry after a delay instead of immediately", () => {
  const decision = fetchFailureAction("upstream_backoff_429:45000");
  assert.equal(decision.action, "retry");
  assert.equal(decision.delaySeconds, 45);
  const busy = fetchFailureAction("domain_busy:120000");
  assert.equal(busy.action, "retry");
  assert.equal(busy.delaySeconds, 120);
  assert.deepEqual(fetchFailureAction("upstream_http_503"), { action: "retry" });
  assert.deepEqual(fetchFailureAction("ssrf_blocked_host"), { action: "ack" });
  assert.deepEqual(fetchFailureAction("body_too_large"), { action: "ack" });
});

test("retry-after and recent 429s grow per-domain backoff", () => {
  assert.equal(parseRetryAfterMs("30"), 30_000);
  const later = Date.parse("2026-10-18T00:01:00.000Z");
  assert.equal(parseRetryAfterMs("Sun, 18 Oct 2026 00:01:00 GMT", Date.parse("2026-10-18T00:00:00.000Z")), 60_000);
  assert.equal(domainBackoffDelayMs(0, null), 30_000);
  assert.equal(domainBackoffDelayMs(0, 90_000), 90_000);
  assert.equal(domainBackoffDelayMs(2, null), 120_000);
  assert.equal(domainBackoffDelayMs(8, null), 15 * 60_000);
  const cooled = nextDomainBackoffMs({ now: later, backoffUntil: 0, recent429: 6, retryAfterMs: null });
  assert.equal(cooled, 30_000);
});

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
      transaction: async (closure) => closure(),
      setAlarm: async () => {},
      deleteAlarm: async () => {}
    };
  }
}

test("domain release records 429 backoff without a prior acquire", async () => {
  const coordinator = new DomainCoordinatorDO(new FakeState(), {});
  const released = await coordinator.fetch(new Request("https://do.internal/internal/release", {
    method: "POST",
    body: JSON.stringify({ domain: "news.example", status: 429, retryAfterMs: 60_000 })
  }));
  assert.equal(released.status, 200);
  const state = await (await coordinator.fetch(new Request("https://do.internal/internal/state"))).json();
  assert.equal(state.state.domain, "news.example");
  assert.equal(state.state.recent_429, 1);
  assert.ok(state.state.backoff_until > Date.now());
  const acquire = await coordinator.fetch(new Request("https://do.internal/internal/acquire", {
    method: "POST",
    body: JSON.stringify({ domain: "news.example", maxConcurrency: 2, minDelayMs: 0 })
  }));
  assert.equal(acquire.status, 429);
});
