import test from "node:test";
import assert from "node:assert/strict";
import {
  browserFailureAction,
  CRAWL_QUEUE_MAX_RETRIES,
  CONGESTION_HOP_CAP,
  fetchFailureAction,
  handleCrawlQueueBatch
} from "../packages/crawler-core/src/crawl-failure.ts";

function job(url, hops) {
  const body = {
    schemaVersion: 1,
    jobId: `job-${url}`,
    traceId: "trace",
    tenantId: "tenant-a",
    monitorId: "monitor-a",
    priority: "normal",
    createdAt: "2026-10-14T10:54:00.000Z",
    attempt: 0,
    payload: { source: "web", url, discoveryKey: "k" }
  };
  if (hops != null) body.congestionHops = hops;
  return body;
}

function fake(body, attempts = 1) {
  const ops = [];
  return {
    attempts,
    body,
    ops,
    ack() { ops.push({ op: "ack" }); },
    retry(options) { ops.push({ op: "retry", options: options ?? null }); }
  };
}

function failureAction(errorMessage, attempts, urlFailures) {
  const input = { attempts, urlFailures, random: () => 0 };
  if (errorMessage.startsWith("browser_")) return browserFailureAction(errorMessage, input);
  return fetchFailureAction(errorMessage, input);
}

async function process(message) {
  const url = message.body && message.body.payload ? message.body.payload.url : undefined;
  if (url === "https://ok.example/a") return;
  if (url === "https://gone.example/a") throw new Error("upstream_http_permanent:404");
  if (url === "https://down.example/a") throw new Error("upstream_http_503");
  if (url === "https://hot.example/a") throw new Error("upstream_backoff_429:900000");
  if (url === "https://busy.example/a") throw new Error("domain_busy:250");
  if (url === "https://pool.example/a") throw new Error("browser_pool_busy:250");
  if (url === "https://long.example/a") throw new Error("domain_busy:1200000");
  throw new TypeError("Cannot read properties of null (reading 'url')");
}

test("one batch acks, retries, and re-sends without sharing delays", async () => {
  const messages = [
    fake(job("https://ok.example/a")),
    fake(job("https://gone.example/a")),
    fake(job("https://down.example/a"), 2),
    fake(job("https://hot.example/a"), 1),
    fake(job("https://busy.example/a")),
    fake(job("https://pool.example/a"), 4),
    fake(job("https://long.example/a")),
    fake(job("https://busy.example/a", CONGESTION_HOP_CAP)),
    fake({ payload: null })
  ];
  const sent = [];
  const events = [];
  const noted = [];
  await handleCrawlQueueBatch(messages, {
    worker: "fetch",
    process,
    failureAction,
    async noteUrlFailure(_body, errorMessage) {
      noted.push(errorMessage);
      return 1;
    },
    async rememberSkip() {},
    async requeue(body, delaySeconds, hops) {
      sent.push({ url: body.payload.url, delaySeconds, hops });
    },
    log(level, event, fields) {
      events.push({ level, event, url: fields.url, error: fields.error, hops: fields.hops });
    }
  });

  assert.deepEqual(messages[0].ops, [{ op: "ack" }]);
  assert.deepEqual(messages[1].ops, [{ op: "ack" }]);
  assert.deepEqual(messages[2].ops, [{ op: "retry", options: null }]);
  assert.deepEqual(messages[3].ops, [{ op: "retry", options: { delaySeconds: 900 } }]);
  assert.deepEqual(messages[4].ops, [{ op: "ack" }]);
  assert.deepEqual(messages[5].ops, [{ op: "ack" }]);
  assert.deepEqual(messages[6].ops, [{ op: "ack" }]);
  assert.deepEqual(messages[7].ops, [{ op: "ack" }]);
  assert.deepEqual(messages[8].ops, [{ op: "ack" }]);

  assert.deepEqual(sent, [
    { url: "https://busy.example/a", delaySeconds: 30, hops: 1 },
    { url: "https://pool.example/a", delaySeconds: 30, hops: 1 },
    { url: "https://long.example/a", delaySeconds: 900, hops: 1 }
  ]);
  assert.equal(messages[2].ops[0].options, null);
  assert.ok(noted.includes("upstream_http_503"));
  assert.ok(noted.includes("upstream_backoff_429:900000"));
  assert.equal(noted.some((item) => item.startsWith("domain_busy:")), false);
  assert.equal(noted.some((item) => item.startsWith("browser_pool_busy:")), false);
  assert.equal(events.filter((item) => item.event === "crawl_congestion_cap").length, 1);
  assert.equal(events.filter((item) => item.event === "crawl_malformed_message").length, 1);
  assert.equal(events.some((item) => item.event === "crawl_domain_busy" && item.hops === CONGESTION_HOP_CAP + 1), false);
});

test("congestion re-send stops at the hop cap and acks", async () => {
  const under = fake(job("https://busy.example/a", CONGESTION_HOP_CAP - 1));
  const capped = fake(job("https://busy.example/a", CONGESTION_HOP_CAP));
  const sent = [];
  const events = [];
  await handleCrawlQueueBatch([under, capped], {
    worker: "browser",
    process,
    failureAction,
    async noteUrlFailure() { return 0; },
    async rememberSkip() {},
    async requeue(body, delaySeconds, hops) {
      sent.push({ hops, delaySeconds, previous: body.congestionHops });
    },
    log(_level, event, fields) { events.push({ event, hops: fields.hops, error: fields.error }); }
  });
  assert.deepEqual(sent, [{ hops: CONGESTION_HOP_CAP, delaySeconds: 30, previous: CONGESTION_HOP_CAP - 1 }]);
  assert.deepEqual(under.ops, [{ op: "ack" }]);
  assert.deepEqual(capped.ops, [{ op: "ack" }]);
  assert.equal(events.filter((item) => item.event === "crawl_congestion_cap").length, 1);
  assert.equal(events.filter((item) => item.event === "crawl_domain_busy").length, 1);
});

test("real transients keep retry() through attempt 4 so max_retries 3 can dead-letter them", async () => {
  assert.equal(CRAWL_QUEUE_MAX_RETRIES, 3);
  const sent = [];
  for (let attempts = 1; attempts <= CRAWL_QUEUE_MAX_RETRIES + 1; attempts += 1) {
    const message = fake(job("https://down.example/a"), attempts);
    await handleCrawlQueueBatch([message], {
      worker: "fetch",
      process,
      failureAction,
      async noteUrlFailure() { return attempts; },
      async rememberSkip() {},
      async requeue(body, delaySeconds, hops) { sent.push({ body, delaySeconds, hops }); },
      log() {}
    });
    assert.deepEqual(message.ops, [{ op: "retry", options: null }]);
  }
  assert.equal(sent.length, 0);
});

test("a failed congestion re-send retries that message and still finishes the batch", async () => {
  const busy = fake(job("https://busy.example/a"));
  const ok = fake(job("https://ok.example/a"));
  await handleCrawlQueueBatch([busy, ok], {
    worker: "fetch",
    process,
    failureAction,
    async noteUrlFailure() { return 0; },
    async rememberSkip() {},
    async requeue() { throw new Error("queue_full"); },
    log() {}
  });
  assert.deepEqual(busy.ops, [{ op: "retry", options: { delaySeconds: 30 } }]);
  assert.deepEqual(ok.ops, [{ op: "ack" }]);
});
