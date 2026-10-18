import test from "node:test";
import assert from "node:assert/strict";
import {
  DOMAIN_BUSY_COOLDOWN_MIN_SECONDS,
  DOMAIN_BUSY_JITTER_SECONDS,
  MAX_URL_CRAWL_ATTEMPTS,
  URL_ATTEMPT_TTL_SECONDS,
  URL_TERMINAL_TTL_SECONDS,
  assertUrlCrawlAllowed,
  classifyCrawlQueueFailure,
  domainBusyDelaySeconds,
  isHardPaywallHost,
  normalizeUrl,
  prepareDiscoveredUrl,
  readUrlCrawlGuard,
  recordUrlCrawlOutcome,
  urlGuardKey
} from "../packages/crawler-core/src/index.ts";
import { fetchFailureAction } from "../workers/crawler-fetch/src/upstream.ts";

function sequence(values) {
  let index = 0;
  return () => values[index++] ?? 0;
}

test("short domain_busy hints wait 30-60s plus jitter instead of a 1s loop", () => {
  assert.equal(domainBusyDelaySeconds(250, sequence([0, 0])), DOMAIN_BUSY_COOLDOWN_MIN_SECONDS);
  assert.equal(domainBusyDelaySeconds(250, sequence([0.999999, 0.999999])), 60 + DOMAIN_BUSY_JITTER_SECONDS);
  assert.equal(domainBusyDelaySeconds(250, sequence([0, 0.999999])), 30 + DOMAIN_BUSY_JITTER_SECONDS);
  assert.equal(domainBusyDelaySeconds(120_000, sequence([0, 0])), 120);
  assert.equal(domainBusyDelaySeconds(45_000), 45);
  assert.equal(domainBusyDelaySeconds(20 * 60_000), 900);

  const busy = classifyCrawlQueueFailure({
    message: "domain_busy:250",
    attempts: 0,
    failureEvent: "crawl_browser_failed",
    random: sequence([0, 0])
  });
  assert.equal(busy.action, "retry");
  assert.equal(busy.delaySeconds, 30);
  assert.equal(busy.level, "info");
  assert.equal(busy.event, "crawl_domain_throttled");
  assert.equal(busy.countAttempt, true);
  assert.equal(busy.terminal, null);
  assert.deepEqual(fetchFailureAction("domain_busy:250", { random: sequence([0, 0]) }), {
    action: "retry",
    delaySeconds: 30
  });
  assert.deepEqual(fetchFailureAction("domain_busy:120000"), { action: "retry", delaySeconds: 120 });

  const pool = classifyCrawlQueueFailure({
    message: "browser_pool_busy:250",
    attempts: 1,
    failureEvent: "crawl_browser_failed",
    random: sequence([0.999999, 0])
  });
  assert.equal(pool.event, "crawl_pool_throttled");
  assert.equal(pool.level, "info");
  assert.equal(pool.delaySeconds, 60);
});

test("retries per canonical URL stop at the cap", () => {
  const under = classifyCrawlQueueFailure({
    message: "upstream_http_503",
    attempts: MAX_URL_CRAWL_ATTEMPTS - 1,
    failureEvent: "crawl_fetch_failed"
  });
  assert.equal(under.action, "retry");
  assert.equal(under.event, "crawl_fetch_failed");
  assert.equal(under.level, "error");
  assert.equal(under.delaySeconds, undefined);

  const capped = classifyCrawlQueueFailure({
    message: "domain_busy:250",
    attempts: MAX_URL_CRAWL_ATTEMPTS,
    failureEvent: "crawl_browser_failed",
    random: sequence([0, 0])
  });
  assert.equal(capped.action, "ack");
  assert.equal(capped.event, "crawl_retry_capped");
  assert.equal(capped.level, "warn");
  assert.equal(capped.countAttempt, false);
  assert.deepEqual(fetchFailureAction("upstream_http_503", { attempts: MAX_URL_CRAWL_ATTEMPTS }), { action: "ack" });
  assert.deepEqual(fetchFailureAction("crawl_retry_capped"), { action: "ack" });
});

test("URL normalization strips syn-*, utm_*, and fbclid before dedupe", () => {
  const left = normalizeUrl("https://www.Example.com/story/?syn-25c5=1&utm_source=news&fbclid=abc&id=9#section");
  const right = normalizeUrl("https://www.example.com/story?id=9&syn-other=2&FBCLID=zzz&utm_medium=social");
  assert.equal(left, "https://www.example.com/story?id=9");
  assert.equal(right, left);
  assert.equal(prepareDiscoveredUrl("https://www.example.com/story?syn-1=a&id=9&fbclid=q"), left);
  assert.equal(
    normalizeUrl("https://Example.com:443/path/?utm_source=x&b=2&a=1#section"),
    "https://example.com/path?a=1&b=2"
  );
});

test("hard-paywall hosts are skipped before crawl and permanent 4xx are not retried", () => {
  assert.equal(isHardPaywallHost("ft.com"), true);
  assert.equal(isHardPaywallHost("www.ft.com"), true);
  assert.equal(isHardPaywallHost("markets.ft.com"), true);
  assert.equal(isHardPaywallHost("nytimes.com"), true);
  assert.equal(isHardPaywallHost("www.nytimes.com"), true);
  assert.equal(isHardPaywallHost("cooking.nytimes.com"), true);
  assert.equal(isHardPaywallHost("notft.com"), false);
  assert.equal(isHardPaywallHost("example.com"), false);
  assert.equal(prepareDiscoveredUrl("https://www.ft.com/content/abc?syn-1=1&fbclid=z"), null);
  assert.equal(prepareDiscoveredUrl("https://www.nytimes.com/2026/10/18/business/story.html?utm_source=tw"), null);

  const paywall = classifyCrawlQueueFailure({
    message: "hard_paywall_host",
    attempts: 0,
    failureEvent: "crawl_fetch_failed"
  });
  assert.equal(paywall.action, "ack");
  assert.equal(paywall.level, "info");
  assert.equal(paywall.event, "crawl_paywall_skipped");
  assert.equal(paywall.terminal, "hard_paywall_host");

  for (const status of [401, 402, 403, 404, 410, 422]) {
    for (const message of [`browser_http_${status}`, `upstream_http_${status}`, `upstream_http_permanent:${status}`]) {
      const decision = classifyCrawlQueueFailure({
        message,
        attempts: 0,
        failureEvent: "crawl_browser_failed"
      });
      assert.equal(decision.action, "ack", message);
      assert.equal(decision.event, "crawl_permanent_skip", message);
      assert.equal(decision.level, "warn", message);
      assert.equal(decision.countAttempt, false, message);
      assert.equal(decision.terminal, message, message);
      assert.deepEqual(fetchFailureAction(message), { action: "ack" });
    }
  }

  const extraction = classifyCrawlQueueFailure({
    message: "browser_extraction_too_small",
    attempts: 0,
    failureEvent: "crawl_browser_failed"
  });
  assert.equal(extraction.action, "ack");
  assert.equal(extraction.event, "crawl_extraction_skipped");
  assert.equal(extraction.terminal, "browser_extraction_too_small");

  const transient = classifyCrawlQueueFailure({
    message: "browser_http_503",
    attempts: 0,
    failureEvent: "crawl_browser_failed"
  });
  assert.equal(transient.action, "retry");
  assert.equal(transient.event, "crawl_browser_failed");
  assert.equal(transient.level, "error");
});

function memoryStore() {
  const values = new Map();
  const options = new Map();
  return {
    options,
    async get(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async put(key, value, putOptions) {
      values.set(key, value);
      options.set(key, putOptions ?? null);
    }
  };
}

test("the per-URL guard counts retries and remembers permanent skips", async () => {
  const store = memoryStore();
  const urlHash = "abc123";
  assert.deepEqual(await readUrlCrawlGuard(store, urlHash), { attempts: 0, terminal: null });
  await assertUrlCrawlAllowed(store, urlHash);

  const retry = classifyCrawlQueueFailure({
    message: "domain_busy:250",
    attempts: 0,
    failureEvent: "crawl_fetch_failed",
    random: sequence([0, 0])
  });
  await recordUrlCrawlOutcome(store, urlHash, retry);
  assert.deepEqual(await readUrlCrawlGuard(store, urlHash), { attempts: 1, terminal: null });
  assert.equal(store.options.get(urlGuardKey(urlHash)).expirationTtl, URL_ATTEMPT_TTL_SECONDS);

  const permanent = classifyCrawlQueueFailure({
    message: "browser_http_404",
    attempts: 1,
    failureEvent: "crawl_browser_failed"
  });
  await recordUrlCrawlOutcome(store, urlHash, permanent);
  assert.equal((await readUrlCrawlGuard(store, urlHash)).terminal, "browser_http_404");
  assert.equal(store.options.get(urlGuardKey(urlHash)).expirationTtl, URL_TERMINAL_TTL_SECONDS);
  await assert.rejects(() => assertUrlCrawlAllowed(store, urlHash), /crawl_terminal:browser_http_404/);

  const cappedStore = memoryStore();
  await cappedStore.put(urlGuardKey("hot"), JSON.stringify({ attempts: MAX_URL_CRAWL_ATTEMPTS, terminal: null }), {
    expirationTtl: URL_ATTEMPT_TTL_SECONDS
  });
  await assert.rejects(() => assertUrlCrawlAllowed(cappedStore, "hot"), /crawl_retry_capped/);
});
