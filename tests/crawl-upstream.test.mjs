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
  assert.equal(browserFailureAction("browser_http_500:0:too many sessions", { random: () => 0 }).action, "requeue");
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
