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
import {
  browserFailureAction,
  browserRunFailureMessage,
  countsTowardUrlCap,
  crawlFailureLog,
  noteUrlFailure
} from "../packages/crawler-core/src/crawl-failure.ts";
import {
  busyRequeueDelaySeconds,
  crawlAttemptKey,
  crawlCacheHit,
  crawlCacheSkipReason,
  discoveryDedupeKey,
  isHardPaywalledHost,
  parseHardPaywallHosts,
  shouldApplyUrlRetryCap,
  URL_RETRY_CAP,
  urlRetryCapReached
} from "../packages/crawler-core/src/index.ts";
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
  const busy = fetchFailureAction("domain_busy:120000", { random: () => 0 });
  assert.equal(busy.action, "requeue");
  assert.equal(busy.waitMs, 120000);
  assert.deepEqual(fetchFailureAction("upstream_http_503"), { action: "retry" });
  assert.deepEqual(fetchFailureAction("upstream_http_401"), { action: "ack" });
  assert.deepEqual(fetchFailureAction("upstream_http_402"), { action: "ack" });
  assert.deepEqual(fetchFailureAction("upstream_http_404"), { action: "ack" });
  assert.deepEqual(fetchFailureAction("ssrf_blocked_host"), { action: "ack" });
  assert.deepEqual(fetchFailureAction("body_too_large"), { action: "ack" });
});

test("domain_busy keeps the coordinator hint for hop backoff", () => {
  const low = fetchFailureAction("domain_busy:250", { random: () => 0, attempts: 1, urlFailures: 0 });
  assert.equal(low.action, "requeue");
  assert.equal(low.waitMs, 250);
  const high = fetchFailureAction("domain_busy:250", { random: () => 1, attempts: 1, urlFailures: 0 });
  assert.equal(high.action, "requeue");
  assert.equal(high.waitMs, 250);
  const mid = busyRequeueDelaySeconds(250, () => 0.5);
  assert.ok(mid >= 30 && mid <= 60);
  const pool = browserFailureAction("browser_pool_busy:250", { random: () => 0, attempts: 1, urlFailures: 0 });
  assert.equal(pool.action, "requeue");
  assert.equal(pool.waitMs, 250);
  assert.deepEqual(crawlFailureLog("fetch", "domain_busy:250", low), { level: "info", event: "crawl_domain_busy" });
  assert.equal(crawlFailureLog("browser", "domain_busy:250", low).level, "info");
  assert.notEqual(crawlFailureLog("browser", "browser_http_500", { action: "retry", delaySeconds: 30 }).event, "crawl_domain_busy");
});

test("transient errors keep retrying after the cap so the queue can dead-letter them", () => {
  assert.equal(urlRetryCapReached(URL_RETRY_CAP - 1), false);
  assert.equal(urlRetryCapReached(URL_RETRY_CAP), true);
  const cappedBusy = fetchFailureAction("domain_busy:250", { random: () => 0, attempts: 4, urlFailures: URL_RETRY_CAP });
  assert.equal(cappedBusy.action, "requeue");
  assert.equal(cappedBusy.waitMs, 250);
  const cappedFetch = fetchFailureAction("upstream_http_503", { attempts: 4, urlFailures: URL_RETRY_CAP });
  assert.equal(cappedFetch.action, "retry");
  assert.equal(cappedFetch.delaySeconds, undefined);
  const cappedBackoff = fetchFailureAction("upstream_backoff_429:45000", { attempts: 4, urlFailures: URL_RETRY_CAP });
  assert.equal(cappedBackoff.action, "retry");
  assert.equal(cappedBackoff.delaySeconds, 45);
  const cappedBrowser = browserFailureAction("browser_http_503", { attempts: 4, urlFailures: URL_RETRY_CAP, random: () => 0 });
  assert.equal(cappedBrowser.action, "retry");
  const cappedPool = browserFailureAction("browser_pool_busy:250", { attempts: 4, urlFailures: URL_RETRY_CAP, random: () => 0 });
  assert.equal(cappedPool.action, "requeue");
  assert.equal(cappedPool.waitMs, 250);
  const session = browserFailureAction("browser_http_429", { random: () => 0 });
  assert.equal(session.action, "requeue");
  assert.equal(session.waitMs, 0);
  const hinted = browserFailureAction("browser_http_429:120000:Too many requests", { random: () => 0 });
  assert.equal(hinted.action, "requeue");
  assert.equal(hinted.waitMs, 120000);
  const sessions = browserFailureAction("Unable to create new browser: too many sessions", { random: () => 0 });
  assert.equal(sessions.action, "requeue");
  assert.equal(sessions.waitMs, 0);
  for (const message of ["Rate limit exceeded", "RATE LIMITED", "rate-limited", "browser_http_503:0:Rate limit exceeded"]) {
    const decision = browserFailureAction(message, { random: () => 0 });
    assert.equal(decision.action, "requeue", message);
    assert.equal(decision.waitMs, 0, message);
    assert.equal(countsTowardUrlCap(message), false, message);
  }
  assert.equal(browserFailureAction("upstream_http_503", { random: () => 0 }).action, "retry");
  assert.equal(browserFailureAction("browser_http_500:0:too many sessions", { random: () => 0 }).action, "requeue");
  for (const message of ["Rate limit exceeded", "RATE LIMITED", "rate-limited", "rate_limited", "ratelimited", "rate limiting", "Too many requests", "browser_http_503:0:Rate limit exceeded"]) {
    const decision = browserFailureAction(message, { random: () => 0 });
    assert.equal(decision.action, "requeue", message);
    assert.equal(decision.waitMs, 0, message);
    assert.equal(countsTowardUrlCap(message, "browser"), false, message);
  }
  for (const message of ["generate limited", "Corporate Limited", "upstream_http_503: rate limited"]) {
    assert.equal(browserFailureAction(message, { random: () => 0 }).action, "retry", message);
    assert.equal(countsTowardUrlCap(message, "fetch"), true, message);
    assert.equal(countsTowardUrlCap(message), true, message);
  }
  assert.equal(browserFailureAction("browser_http_422:0:rate limited").action, "ack");
  assert.equal(browserFailureAction("browser_http_404:0:Too many requests").action, "ack");
  assert.deepEqual(
    crawlFailureLog("browser", "browser_http_422:0:rate limited", { action: "ack" }),
    { level: "warn", event: "crawl_browser_skipped" }
  );
  assert.deepEqual(
    crawlFailureLog("fetch", "upstream_http_503: rate limited", { action: "retry" }),
    { level: "error", event: "crawl_fetch_failed" }
  );
  assert.equal(browserFailureAction("browser_extraction_too_small").action, "ack");
  for (const status of [401, 402, 404, 422]) {
    assert.equal(browserFailureAction(`browser_http_${status}`).action, "ack");
  }
  assert.equal(browserFailureAction("browser_http_404:0:Not Found").action, "ack");
  assert.equal(fetchFailureAction("hard_paywall_host").action, "ack");
  assert.equal(crawlFailureLog("browser", "browser_http_422", { action: "ack" }).level, "warn");
  assert.deepEqual(
    crawlFailureLog("browser", "browser_http_429:0:Too many requests", { action: "requeue", waitMs: 0 }),
    { level: "info", event: "crawl_browser_session_busy" }
  );
});

test("browser run failures keep the status, retry-after, and session-limit text", () => {
  const now = Date.parse("2026-10-18T10:00:00.000Z");
  const limited = browserRunFailureMessage(429, "30", JSON.stringify({
    success: false,
    errors: [{ message: "Too many requests" }]
  }), now);
  assert.equal(limited, "browser_http_429:30000:Too many requests");
  assert.equal(browserFailureAction(limited).action, "requeue");
  assert.equal(browserFailureAction(limited).waitMs, 30000);
  const sessions = browserRunFailureMessage(500, null, "Unable to create new browser: too many sessions", now);
  assert.equal(sessions, "browser_http_500:0:Unable to create new browser: too many sessions");
  assert.equal(browserFailureAction(sessions).action, "requeue");
  const httpDate = browserRunFailureMessage(429, "Sun, 18 Oct 2026 10:00:15 GMT", "", now);
  assert.equal(httpDate, "browser_http_429:15000");
  assert.equal(browserFailureAction("browser_http_503:0:upstream timeout").action, "retry");
});

test("per-URL cap ignores congestion and is scoped per tenant", () => {
  assert.equal(countsTowardUrlCap("domain_busy:250"), false);
  assert.equal(countsTowardUrlCap("browser_pool_busy:1000"), false);
  assert.equal(countsTowardUrlCap("upstream_http_503"), true);
  assert.equal(countsTowardUrlCap("upstream_backoff_429:30000"), true);
  assert.equal(countsTowardUrlCap("browser_http_503"), true);
  assert.equal(countsTowardUrlCap("browser_http_429"), false);
  assert.equal(countsTowardUrlCap("browser_http_429:1000:Too many requests"), false);
  assert.equal(countsTowardUrlCap("too many sessions"), false);
  assert.equal(countsTowardUrlCap("Rate limit exceeded", "fetch"), true);
  assert.equal(countsTowardUrlCap("Rate limit exceeded", "browser"), false);
  assert.equal(countsTowardUrlCap("rate_limited", "browser"), false);
  assert.equal(countsTowardUrlCap("ratelimited", "fetch"), true);
  assert.equal(countsTowardUrlCap("rate limiting", "browser"), false);
  assert.equal(countsTowardUrlCap("upstream_http_permanent:404"), false);
  assert.equal(countsTowardUrlCap("browser_http_422"), false);
  assert.equal(shouldApplyUrlRetryCap(1), true);
  assert.equal(shouldApplyUrlRetryCap(undefined), true);
  assert.equal(shouldApplyUrlRetryCap(2), false);
  assert.equal(shouldApplyUrlRetryCap(4), false);
  const left = crawlAttemptKey("tenant-a", "hash");
  const right = crawlAttemptKey("tenant-b", "hash");
  assert.equal(left, "crawl-attempts:tenant-a:hash");
  assert.notEqual(left, right);
  assert.equal(crawlAttemptKey(undefined, "hash"), "crawl-attempts:_:hash");
});

test("browser cache hits forward stored content and skips stay terminal", () => {
  const hit = crawlCacheHit({
    contentId: "c1",
    rawR2Key: "content/h/b/browser.json",
    fetchedAt: "2026-10-18T00:00:00.000Z",
    canonicalUrl: "https://example.com/story"
  });
  assert.deepEqual(hit, {
    contentId: "c1",
    rawR2Key: "content/h/b/browser.json",
    fetchedAt: "2026-10-18T00:00:00.000Z",
    canonicalUrl: "https://example.com/story"
  });
  assert.equal(crawlCacheHit({ contentId: "c1", skip: "upstream_http_permanent:404" }), null);
  assert.equal(crawlCacheSkipReason({ skip: "browser_http_404", contentId: "c1" }), "browser_http_404");
  assert.equal(crawlCacheHit({ contentId: "c1" }), null);
});

test("hard-paywall hosts are configurable and tracking params share a dedupe key", () => {
  assert.equal(isHardPaywalledHost("www.ft.com"), true);
  assert.equal(isHardPaywalledHost("markets.ft.com"), true);
  assert.equal(isHardPaywalledHost("www.nytimes.com"), true);
  assert.equal(isHardPaywalledHost("ft.com.example"), false);
  assert.equal(isHardPaywalledHost("notft.com"), false);
  assert.equal(isHardPaywalledHost("example.com"), false);
  const custom = parseHardPaywallHosts("wsj.com, www.ft.com");
  assert.equal(isHardPaywalledHost("www.wsj.com", custom), true);
  assert.equal(isHardPaywalledHost("www.nytimes.com", custom), false);
  assert.deepEqual(parseHardPaywallHosts(""), ["ft.com", "nytimes.com"]);
  const left = discoveryDedupeKey("https://www.ft.com/content/abc?syn-25a8e0=1&utm_source=x&fbclid=1");
  const right = discoveryDedupeKey("https://www.ft.com/content/abc?syn-bbbb=2");
  assert.equal(left, right);
  assert.equal(left, "https://www.ft.com/content/abc");
});

test("url failure counter advances inside the retry window", async () => {
  const store = new Map();
  const cache = {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); }
  };
  assert.equal(await noteUrlFailure(cache, "tenant-a", "abc"), 1);
  assert.equal(await noteUrlFailure(cache, "tenant-a", "abc"), 2);
  assert.equal(await noteUrlFailure(cache, "tenant-b", "abc"), 1);
  assert.equal(store.size, 2);
  assert.equal(store.get("crawl-attempts:tenant-a:abc"), "2");
  assert.equal(store.get("crawl-attempts:tenant-b:abc"), "1");
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
    let alarm = null;
    this.storage = {
      sql,
      transaction: async (closure) => closure(),
      setAlarm: async (at) => { alarm = at; },
      getAlarm: async () => alarm,
      deleteAlarm: async () => { alarm = null; }
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

async function park(coordinator, lane, urlKey, body = { payload: { url: `https://${lane}.example/${urlKey}` } }, tenantId = "", monitorId = "") {
  const response = await coordinator.fetch(new Request("https://do.internal/internal/park", {
    method: "POST",
    body: JSON.stringify({
      lane,
      urlKey,
      bodyJson: JSON.stringify(body),
      delaySeconds: 30,
      hops: 1,
      tenantId,
      monitorId
    })
  }));
  assert.equal(response.status, 200);
  return response.json();
}

async function postLane(coordinator, path, body) {
  const response = await coordinator.fetch(new Request(`https://do.internal${path}`, {
    method: "POST",
    body: JSON.stringify(body)
  }));
  assert.equal(response.status, 200);
  return response.json();
}

test("domain park keeps one wake and take respects the busy lease", async () => {
  const coordinator = new DomainCoordinatorDO(new FakeState(), {});
  const first = await park(coordinator, "browser", "tenant-a\u001fhttps://hot.example/a");
  assert.equal(first.scheduleWake, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.waiting, 1);
  assert.ok(first.token);
  const second = await park(coordinator, "browser", "tenant-a\u001fhttps://hot.example/a");
  assert.equal(second.scheduleWake, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.waiting, 1);
  assert.equal(second.token, first.token);
  const other = await park(coordinator, "browser", "tenant-a\u001fhttps://hot.example/b");
  assert.equal(other.scheduleWake, false);
  assert.equal(other.waiting, 2);
  const fetchLane = await park(coordinator, "fetch", "tenant-a\u001fhttps://hot.example/a");
  assert.equal(fetchLane.scheduleWake, true);
  assert.equal(fetchLane.waiting, 1);

  const stale = await postLane(coordinator, "/internal/take", { lane: "browser", limit: 2, token: "other-chain" });
  assert.equal(stale.stale, true);
  assert.equal(stale.jobs.length, 0);

  const taken = await postLane(coordinator, "/internal/take", { lane: "browser", limit: 2, token: first.token });
  assert.equal(taken.stale, false);
  assert.equal(taken.jobs.length, 2);
  assert.equal(taken.waiting, 2);
  assert.equal(taken.retryAfterMs, 0);
  const parsed = taken.jobs.map((job) => JSON.parse(job.bodyJson).payload.url);
  assert.deepEqual(parsed, ["https://browser.example/tenant-a\u001fhttps://hot.example/a", "https://browser.example/tenant-a\u001fhttps://hot.example/b"]);
  const again = await postLane(coordinator, "/internal/take", { lane: "browser", limit: 2, token: first.token });
  assert.equal(again.jobs.length, 0);
  await postLane(coordinator, "/internal/release-claim", { lane: "browser", urlKey: taken.jobs[0].urlKey });
  const reclaimed = await postLane(coordinator, "/internal/take", { lane: "browser", limit: 1, token: first.token });
  assert.equal(reclaimed.jobs.length, 1);
  assert.equal(reclaimed.jobs[0].urlKey, taken.jobs[0].urlKey);
  for (const job of taken.jobs) await postLane(coordinator, "/internal/complete", { lane: "browser", urlKey: job.urlKey });
  const afterComplete = await (await coordinator.fetch(new Request("https://do.internal/internal/state"))).json();
  assert.equal(afterComplete.waiting, 1);

  const released = await coordinator.fetch(new Request("https://do.internal/internal/release", {
    method: "POST",
    body: JSON.stringify({ domain: "hot.example", status: 429, retryAfterMs: 60_000 })
  }));
  assert.equal(released.status, 200);
  const parkedAgain = await park(coordinator, "browser", "tenant-a\u001fhttps://hot.example/c");
  const blocked = await postLane(coordinator, "/internal/take", { lane: "browser", limit: 2, token: parkedAgain.token });
  assert.deepEqual(blocked.jobs, []);
  assert.equal(blocked.stale, false);
  assert.equal(blocked.waiting, 1);
  assert.ok(blocked.retryAfterMs >= 250);

  const state = await (await coordinator.fetch(new Request("https://do.internal/internal/state"))).json();
  assert.equal(state.waiting, 2);

  const leased = new DomainCoordinatorDO(new FakeState(), {});
  for (let slot = 0; slot < 2; slot += 1) {
    const acquired = await leased.fetch(new Request("https://do.internal/internal/acquire", {
      method: "POST",
      body: JSON.stringify({ domain: "hot.example", maxConcurrency: 2, minDelayMs: 0 })
    }));
    assert.equal(acquired.status, 200);
  }
  const fetchPark = await park(leased, "fetch", "tenant-a\u001fhttps://hot.example/fetch");
  const browserPark = await park(leased, "browser", "tenant-a\u001fhttps://hot.example/browser");
  const fetchTake = await postLane(leased, "/internal/take", { lane: "fetch", limit: 2, token: fetchPark.token });
  const browserTake = await postLane(leased, "/internal/take", { lane: "browser", limit: 2, token: browserPark.token });
  assert.equal(fetchTake.jobs.length, 1);
  assert.equal(browserTake.jobs.length, 0);
  assert.equal(browserTake.stale, false);
  assert.ok(browserTake.retryAfterMs >= 250);
});

test("domain park overflows at the configured cap and a large body falls back", async () => {
  const coordinator = new DomainCoordinatorDO(new FakeState(), { DOMAIN_PARK_CAP: "4" });
  for (let index = 0; index < 4; index += 1) {
    const parked = await park(coordinator, "fetch", `tenant\u001fhttps://hot.example/${index}`, undefined, "tenant-a");
    assert.equal(parked.overflow, false);
    assert.equal(parked.scheduleWake, index === 0);
  }
  const overflow = await park(coordinator, "fetch", "tenant\u001fhttps://hot.example/overflow", undefined, "tenant-a");
  assert.equal(overflow.overflow, true);
  assert.equal(overflow.fallback, true);
  assert.equal(overflow.scheduleWake, false);
  assert.equal(overflow.waiting, 4);
  const otherTenant = await park(coordinator, "fetch", "tenant-b\u001fhttps://hot.example/other", undefined, "tenant-b");
  assert.equal(otherTenant.overflow, false);
  assert.equal(otherTenant.waiting, 5);
  const huge = await coordinator.fetch(new Request("https://do.internal/internal/park", {
    method: "POST",
    body: JSON.stringify({
      lane: "fetch",
      urlKey: "tenant\u001foversized",
      bodyJson: "x".repeat(16 * 1024 + 1),
      delaySeconds: 30,
      hops: 1,
      tenantId: "tenant-a"
    })
  }));
  const fallback = await huge.json();
  assert.equal(fallback.fallback, true);
  assert.equal(fallback.overflow, false);
  assert.equal(fallback.waiting, 5);
});

test("a wake token stays one chain across the delivery lag and the alarm expires a dead wake", async () => {
  const alarms = [];
  const sent = [];
  const fake = new FakeState();
  let stored = null;
  fake.storage.setAlarm = async (at) => { stored = at; alarms.push(at); };
  fake.storage.getAlarm = async () => stored;
  fake.storage.deleteAlarm = async () => { stored = null; alarms.push("cleared"); };
  let now = Date.now();
  const coordinator = new DomainCoordinatorDO(fake, {
    nowMs: () => now,
    CRAWL_DLQ: { async send(body) { sent.push(body); } }
  });
  const first = await park(coordinator, "browser", "tenant\u001fmon\u001fhttps://hot.example/a", undefined, "tenant-a", "mon-a");
  assert.equal(first.scheduleWake, true);
  assert.ok(alarms.some((item) => typeof item === "number"));
  now += 31_000;
  const lagged = await park(coordinator, "browser", "tenant\u001fmon\u001fhttps://hot.example/b", undefined, "tenant-a", "mon-a");
  assert.equal(lagged.scheduleWake, false);
  assert.equal(lagged.token, first.token);
  now += 130_000;
  const rotated = await park(coordinator, "browser", "tenant\u001fmon\u001fhttps://hot.example/c", undefined, "tenant-a", "mon-a");
  assert.equal(rotated.scheduleWake, true);
  assert.notEqual(rotated.token, first.token);
  const stale = await postLane(coordinator, "/internal/take", { lane: "browser", limit: 1, token: first.token });
  assert.equal(stale.stale, true);
  assert.equal(stale.jobs.length, 0);
  const stateBefore = await (await coordinator.fetch(new Request("https://do.internal/internal/state"))).json();
  assert.equal(stateBefore.waiting, 3);

  now += 60 * 60 * 1000;
  await coordinator.alarm();
  const state = await (await coordinator.fetch(new Request("https://do.internal/internal/state"))).json();
  assert.equal(sent.length, 3);
  assert.ok(sent.every((body) => body.parkExpiredReason === "crawl_domain_park_stranded"));
  assert.equal(state.waiting, 0);
  assert.equal(state.expired, 3);
  assert.equal(state.parkEvents.length, 3);
  assert.ok(alarms.includes("cleared"));
});

test("a fresh wake with a stale park does not re-arm the alarm for now", async () => {
  const alarms = [];
  const fake = new FakeState();
  fake.storage.setAlarm = async (at) => { alarms.push(at); };
  fake.storage.deleteAlarm = async () => { alarms.push("cleared"); };
  let now = 1_700_000_000_000;
  const coordinator = new DomainCoordinatorDO(fake, { nowMs: () => now });
  await park(coordinator, "browser", "tenant\u001fhttps://hot.example/stale", { payload: { url: "https://hot.example/stale" }, tenantId: "tenant-a" }, "tenant-a", "mon-a");
  now += 20 * 60 * 1000;
  await postLane(coordinator, "/internal/note-wake", { lane: "browser", delaySeconds: 30, hops: 1 });
  alarms.length = 0;
  let rearms = 0;
  for (let step = 0; step < 100; step += 1) {
    await coordinator.alarm();
    const scheduled = alarms[alarms.length - 1];
    if (typeof scheduled === "number" && scheduled <= now) rearms += 1;
  }
  assert.equal(rearms, 0);
  const numeric = alarms.filter((item) => typeof item === "number");
  assert.ok(numeric.length > 0);
  assert.ok(numeric.every((item) => item >= now + 60_000));
  const state = await (await coordinator.fetch(new Request("https://do.internal/internal/state"))).json();
  assert.equal(state.waiting, 1);
  assert.equal(state.expired, 0);
});

test("an expired park is dead-lettered before it is deleted", async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (line) => { warnings.push(String(line)); };
  const sent = [];
  try {
    let now = 1_700_000_000_000;
    const coordinator = new DomainCoordinatorDO(new FakeState(), {
      nowMs: () => now,
      CRAWL_DLQ: { async send(body) { sent.push(body); } }
    });
    await park(coordinator, "browser", "expiry-probe\u001fhttps://hot.example/a", {
      jobId: "job-a",
      tenantId: "expiry-probe",
      payload: { url: "https://hot.example/a" }
    }, "expiry-probe", "mon-a");
    await park(coordinator, "browser", "expiry-probe\u001fhttps://hot.example/b", {
      jobId: "job-b",
      tenantId: "expiry-probe",
      payload: { url: "https://hot.example/b" }
    }, "expiry-probe", "mon-a");
    now += 60 * 60 * 1000;
    await coordinator.alarm();
    assert.equal(sent.length, 2);
    assert.ok(sent.every((body) => body.parkExpiredReason === "crawl_domain_park_stranded" && body.parkExpiredDomain === "hot.example"));
    const expired = warnings.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter((item) => item && item.message === "crawl_domain_park_stranded" && item.tenantId === "expiry-probe");
    assert.equal(expired.length, 2);
    assert.ok(expired.every((item) => item.count === 1));
    const state = await (await coordinator.fetch(new Request("https://do.internal/internal/state"))).json();
    assert.equal(state.waiting, 0);
    assert.equal(state.expired, 2);
  } finally {
    console.warn = original;
  }
});

test("an expired park stays when the DLQ send is refused", async () => {
  let now = 1_700_000_000_000;
  const unbound = new DomainCoordinatorDO(new FakeState(), { nowMs: () => now });
  await park(unbound, "browser", "stay\u001fhttps://hot.example/a", {
    payload: { url: "https://hot.example/a" }
  }, "tenant-a");
  now += 60 * 60 * 1000;
  await unbound.alarm();
  const stayed = await (await unbound.fetch(new Request("https://do.internal/internal/state"))).json();
  assert.equal(stayed.waiting, 1);
  assert.equal(stayed.expired, 0);

  const failing = new DomainCoordinatorDO(new FakeState(), {
    nowMs: () => now,
    CRAWL_DLQ: { async send() { throw new Error("dlq down"); } }
  });
  await park(failing, "browser", "stay\u001fhttps://hot.example/b", {
    payload: { url: "https://hot.example/b" }
  }, "tenant-a");
  now += 60 * 60 * 1000;
  await failing.alarm();
  const still = await (await failing.fetch(new Request("https://do.internal/internal/state"))).json();
  assert.equal(still.waiting, 1);
  assert.equal(still.expired, 0);
});

test("take rotates across tenants and stays oldest-first inside one tenant", async () => {
  const coordinator = new DomainCoordinatorDO(new FakeState(), {});
  let token = "";
  for (const url of ["h1", "h2", "h3"]) {
    const parked = await park(coordinator, "browser", `heavy\u001f${url}`, {
      tenantId: "heavy",
      payload: { url: `https://hot.example/${url}` }
    }, "heavy");
    if (!token) token = parked.token;
  }
  await park(coordinator, "browser", "light\u001flight", {
    tenantId: "light",
    payload: { url: "https://hot.example/light" }
  }, "light");
  const order = [];
  for (let step = 0; step < 4; step += 1) {
    const taken = await postLane(coordinator, "/internal/take", { lane: "browser", limit: 1, token });
    assert.equal(taken.jobs.length, 1);
    order.push(JSON.parse(taken.jobs[0].bodyJson).tenantId);
    await postLane(coordinator, "/internal/complete", { lane: "browser", urlKey: taken.jobs[0].urlKey });
  }
  assert.deepEqual(order, ["heavy", "light", "heavy", "heavy"]);
});

test("sweep returns a chunk and deletes a row only after complete", async () => {
  const coordinator = new DomainCoordinatorDO(new FakeState(), {});
  for (const url of ["a", "b", "c"]) {
    await park(coordinator, "browser", `tenant\u001fhttps://hot.example/${url}`, {
      payload: { url: `https://hot.example/${url}` }
    }, "tenant-a");
  }
  const swept = await postLane(coordinator, "/internal/sweep", { lane: "browser", limit: 2 });
  assert.equal(swept.jobs.length, 2);
  assert.equal(swept.remaining, 1);
  const during = await (await coordinator.fetch(new Request("https://do.internal/internal/state"))).json();
  assert.equal(during.waiting, 3);
  for (const job of swept.jobs) await postLane(coordinator, "/internal/complete", { lane: "browser", urlKey: job.urlKey });
  const after = await (await coordinator.fetch(new Request("https://do.internal/internal/state"))).json();
  assert.equal(after.waiting, 1);
});

test("revise-park stores the lifetime and a missing row is not created", async () => {
  const coordinator = new DomainCoordinatorDO(new FakeState(), {});
  await park(coordinator, "browser", "tenant\u001fhttps://hot.example/a", {
    payload: { url: "https://hot.example/a" },
    congestionLifetime: 1
  }, "tenant-a");
  const swept = await postLane(coordinator, "/internal/sweep", { lane: "browser", limit: 1 });
  const revised = await postLane(coordinator, "/internal/revise-park", {
    lane: "browser",
    urlKey: swept.jobs[0].urlKey,
    bodyJson: JSON.stringify({ payload: { url: "https://hot.example/a" }, congestionLifetime: 4 })
  });
  assert.equal(revised.ok, true);
  const again = await postLane(coordinator, "/internal/sweep", { lane: "browser", limit: 1 });
  assert.equal(JSON.parse(again.jobs[0].bodyJson).congestionLifetime, 4);
  const missing = await coordinator.fetch(new Request("https://do.internal/internal/revise-park", {
    method: "POST",
    body: JSON.stringify({ lane: "browser", urlKey: "missing", bodyJson: "{}" })
  }));
  assert.equal(missing.status, 404);
  const state = await (await coordinator.fetch(new Request("https://do.internal/internal/state"))).json();
  assert.equal(state.waiting, 1);
});

test("a deep park raises the browser lease budget and a release without a lease id keeps the slot", async () => {
  let now = 1_700_000_000_000;
  const coordinator = new DomainCoordinatorDO(new FakeState(), { nowMs: () => now });
  for (let index = 0; index < 64; index += 1) {
    await park(coordinator, "browser", `tenant\u001fhttps://hot.example/${index}`, {
      payload: { url: `https://hot.example/${index}` }
    }, "tenant-a");
  }
  const ids = [];
  for (let slot = 0; slot < 4; slot += 1) {
    const acquired = await coordinator.fetch(new Request("https://do.internal/internal/acquire", {
      method: "POST",
      body: JSON.stringify({ domain: "hot.example", maxConcurrency: 2, minDelayMs: 0 })
    }));
    assert.equal(acquired.status, 200, `slot ${slot}`);
    ids.push((await acquired.json()).leaseId);
  }
  const denied = await coordinator.fetch(new Request("https://do.internal/internal/acquire", {
    method: "POST",
    body: JSON.stringify({ domain: "hot.example", maxConcurrency: 2, minDelayMs: 0 })
  }));
  assert.equal(denied.status, 429);
  const held = await (await coordinator.fetch(new Request("https://do.internal/internal/state"))).json();
  assert.equal(held.leases, 4);
  assert.equal(held.state.active_requests, 4);

  const bare = await coordinator.fetch(new Request("https://do.internal/internal/release", {
    method: "POST",
    body: JSON.stringify({ domain: "hot.example", status: 200, retryAfterMs: 0 })
  }));
  assert.equal(bare.status, 200);
  const afterBare = await (await coordinator.fetch(new Request("https://do.internal/internal/state"))).json();
  assert.equal(afterBare.leases, 4);
  const stillDenied = await coordinator.fetch(new Request("https://do.internal/internal/acquire", {
    method: "POST",
    body: JSON.stringify({ domain: "hot.example", maxConcurrency: 2, minDelayMs: 0 })
  }));
  assert.equal(stillDenied.status, 429);

  const released = await coordinator.fetch(new Request("https://do.internal/internal/release", {
    method: "POST",
    body: JSON.stringify({ domain: "hot.example", status: 200, leaseId: ids[0] })
  }));
  assert.equal(released.status, 200);
  const granted = await coordinator.fetch(new Request("https://do.internal/internal/acquire", {
    method: "POST",
    body: JSON.stringify({ domain: "hot.example", maxConcurrency: 2, minDelayMs: 0 })
  }));
  assert.equal(granted.status, 200);
  const after = await (await coordinator.fetch(new Request("https://do.internal/internal/state"))).json();
  assert.equal(after.leases, 4);
});

test("sweep retry counters stay on their own lane", async () => {
  const coordinator = new DomainCoordinatorDO(new FakeState(), {});
  for (const lane of ["browser", "browser", "fetch"]) {
    const response = await coordinator.fetch(new Request("https://do.internal/internal/note-wake", {
      method: "POST",
      body: JSON.stringify({ lane, delaySeconds: 30, hops: 0, sweepRetry: "fail" })
    }));
    assert.equal(response.status, 200);
  }
  const state = await (await coordinator.fetch(new Request("https://do.internal/internal/state"))).json();
  const browser = state.sweep.find((item) => item.lane === "browser");
  const fetchLane = state.sweep.find((item) => item.lane === "fetch");
  assert.equal(browser.retry_attempt, 2);
  assert.equal(fetchLane.retry_attempt, 1);
});

test("browser lease budget follows the browser lane only", async () => {
  const coordinator = new DomainCoordinatorDO(new FakeState(), {});
  for (let index = 0; index < 64; index += 1) {
    await park(coordinator, "fetch", `tenant\u001fhttps://hot.example/${index}`, {
      payload: { url: `https://hot.example/${index}` }
    }, "tenant-a");
  }
  for (let slot = 0; slot < 2; slot += 1) {
    const acquired = await coordinator.fetch(new Request("https://do.internal/internal/acquire", {
      method: "POST",
      body: JSON.stringify({ domain: "hot.example", maxConcurrency: 2, minDelayMs: 0 })
    }));
    assert.equal(acquired.status, 200);
  }
  const denied = await coordinator.fetch(new Request("https://do.internal/internal/acquire", {
    method: "POST",
    body: JSON.stringify({ domain: "hot.example", maxConcurrency: 2, minDelayMs: 0 })
  }));
  assert.equal(denied.status, 429);
});

test("acquire does not reset the alarm when the earliest deadline is unchanged", async () => {
  const alarms = [];
  const fake = new FakeState();
  let stored = null;
  fake.storage.setAlarm = async (at) => { stored = at; alarms.push(at); };
  fake.storage.getAlarm = async () => stored;
  fake.storage.deleteAlarm = async () => { stored = null; alarms.push("cleared"); };
  const now = 1_700_000_000_000;
  const coordinator = new DomainCoordinatorDO(fake, { nowMs: () => now });
  for (let slot = 0; slot < 2; slot += 1) {
    const acquired = await coordinator.fetch(new Request("https://do.internal/internal/acquire", {
      method: "POST",
      body: JSON.stringify({ domain: "hot.example", maxConcurrency: 2, minDelayMs: 0 })
    }));
    assert.equal(acquired.status, 200);
  }
  const sets = alarms.filter((item) => typeof item === "number");
  assert.equal(sets.length, 1);
  assert.ok(sets[0] >= now + 60_000);
});

test("a domain lease alarm stays in the future and then frees the slot", async () => {
  const alarms = [];
  const fake = new FakeState();
  let stored = null;
  fake.storage.setAlarm = async (at) => { stored = at; alarms.push(at); };
  fake.storage.getAlarm = async () => stored;
  fake.storage.deleteAlarm = async () => { stored = null; alarms.push("cleared"); };
  let now = 1_700_000_000_000;
  const coordinator = new DomainCoordinatorDO(fake, { nowMs: () => now });
  const acquired = await coordinator.fetch(new Request("https://do.internal/internal/acquire", {
    method: "POST",
    body: JSON.stringify({ domain: "hot.example", maxConcurrency: 2, minDelayMs: 0 })
  }));
  assert.equal(acquired.status, 200);
  const armed = alarms.filter((item) => typeof item === "number");
  assert.ok(armed.length > 0);
  assert.ok(armed.every((item) => item >= now + 60_000));
  alarms.length = 0;
  let rearms = 0;
  for (let step = 0; step < 100; step += 1) {
    await coordinator.alarm();
    const scheduled = alarms[alarms.length - 1];
    if (typeof scheduled === "number" && scheduled <= now) rearms += 1;
  }
  assert.equal(rearms, 0);
  assert.equal(alarms.filter((item) => typeof item === "number").length, 0);
  const held = await (await coordinator.fetch(new Request("https://do.internal/internal/state"))).json();
  assert.equal(held.leases, 1);
  now += 60_001;
  await coordinator.alarm();
  const cleared = await (await coordinator.fetch(new Request("https://do.internal/internal/state"))).json();
  assert.equal(cleared.leases, 0);
  assert.equal(cleared.state.active_requests, 0);
  assert.ok(alarms.includes("cleared"));
  const next = await coordinator.fetch(new Request("https://do.internal/internal/acquire", {
    method: "POST",
    body: JSON.stringify({ domain: "hot.example", maxConcurrency: 2, minDelayMs: 0 })
  }));
  assert.equal(next.status, 200);
});
