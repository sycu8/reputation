import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  browserFailureAction,
  congestionBackoffDelaySeconds,
  CRAWL_QUEUE_MAX_RETRIES,
  CONGESTION_HOP_CAP,
  domainBusyWakeDelaySeconds,
  drainDomainWake,
  fetchFailureAction,
  handleCrawlQueueBatch
} from "../packages/crawler-core/src/crawl-failure.ts";
import { DomainCoordinatorDO } from "../workers/state/src/index.ts";

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
  if (url === "https://render.example/a") throw new Error("browser_http_429:0:Too many requests");
  if (url === "https://render.example/b") throw new Error("browser_http_500:0:too many sessions");
  if (url === "https://render.example/c") throw new Error("browser_http_503:0:upstream timeout");
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

test("congestion re-send delay doubles by hop and then stays at 900s", async () => {
  const expected = [30, 60, 120, 240, 480, 900, 900, 900, 900, 900, 900, 900];
  const fromHint = [];
  for (let hop = 0; hop < CONGESTION_HOP_CAP; hop += 1) {
    fromHint.push(congestionBackoffDelaySeconds(250, hop));
  }
  assert.deepEqual(fromHint, expected);
  assert.equal(fromHint.reduce((sum, delay) => sum + delay, 0), 7230);
  assert.equal(congestionBackoffDelaySeconds(120_000, 0), 120);
  assert.equal(congestionBackoffDelaySeconds(120_000, 2), 120);
  assert.equal(congestionBackoffDelaySeconds(120_000, 3), 240);
  assert.equal(congestionBackoffDelaySeconds(1_200_000, 0), 900);

  const seen = [];
  for (let hop = 0; hop < CONGESTION_HOP_CAP; hop += 1) {
    const message = fake(hop === 0 ? job("https://busy.example/a") : job("https://busy.example/a", hop));
    const sent = [];
    await handleCrawlQueueBatch([message], {
      worker: "fetch",
      process,
      failureAction,
      async noteUrlFailure() { return 0; },
      async rememberSkip() {},
      async requeue(_body, delaySeconds, hops) { sent.push({ delaySeconds, hops }); },
      log() {}
    });
    assert.equal(sent.length, 1);
    seen.push(sent[0].delaySeconds);
    assert.equal(sent[0].hops, hop + 1);
    assert.deepEqual(message.ops, [{ op: "ack" }]);
  }
  assert.deepEqual(seen, expected);
});

test("browser session limits re-send with hop backoff instead of retry()", async () => {
  const rateLimited = fake(job("https://render.example/a"));
  const sessions = fake(job("https://render.example/b", 2));
  const serverError = fake(job("https://render.example/c"));
  const sent = [];
  const events = [];
  await handleCrawlQueueBatch([rateLimited, sessions, serverError], {
    worker: "browser",
    process,
    failureAction,
    async noteUrlFailure() { return 1; },
    async rememberSkip() {},
    async requeue(body, delaySeconds, hops) { sent.push({ url: body.payload.url, delaySeconds, hops }); },
    log(_level, event, fields) { events.push({ event, hops: fields.hops, delaySeconds: fields.delaySeconds }); }
  });
  assert.deepEqual(rateLimited.ops, [{ op: "ack" }]);
  assert.deepEqual(sessions.ops, [{ op: "ack" }]);
  assert.deepEqual(serverError.ops, [{ op: "retry", options: { delaySeconds: 30 } }]);
  assert.deepEqual(sent, [
    { url: "https://render.example/a", delaySeconds: 30, hops: 1 },
    { url: "https://render.example/b", delaySeconds: 120, hops: 3 }
  ]);
  assert.equal(events.filter((item) => item.event === "crawl_browser_session_busy").length, 2);
  assert.equal(events.some((item) => item.event === "crawl_browser_failed"), true);
});

test("Browser Run rate-limit text is re-sent and lookalike phrases are not", async () => {
  const tooMany = fake(job("https://render.example/rate"));
  const limited = fake(job("https://render.example/rate"));
  const company = fake(job("https://render.example/rate"));
  const sent = [];
  const browserAction = (errorMessage, attempts, urlFailures) => browserFailureAction(errorMessage, { attempts, urlFailures, random: () => 0 });
  await handleCrawlQueueBatch([tooMany], {
    worker: "browser",
    async process() { throw new Error("Too many requests"); },
    failureAction: browserAction,
    async noteUrlFailure() { return 0; },
    async rememberSkip() {},
    async requeue(_body, delaySeconds, hops) { sent.push({ delaySeconds, hops, kind: "too-many" }); },
    log() {}
  });
  await handleCrawlQueueBatch([limited], {
    worker: "browser",
    async process() { throw new Error("Rate limit exceeded"); },
    failureAction: browserAction,
    async noteUrlFailure() { return 0; },
    async rememberSkip() {},
    async requeue(_body, delaySeconds, hops) { sent.push({ delaySeconds, hops, kind: "rate" }); },
    log() {}
  });
  await handleCrawlQueueBatch([company], {
    worker: "browser",
    async process() { throw new Error("Corporate Limited"); },
    failureAction: browserAction,
    async noteUrlFailure() { return 0; },
    async rememberSkip() {},
    async requeue() { sent.push({ kind: "company" }); },
    log() {}
  });
  assert.deepEqual(sent, [
    { delaySeconds: 30, hops: 1, kind: "too-many" },
    { delaySeconds: 30, hops: 1, kind: "rate" }
  ]);
  assert.deepEqual(tooMany.ops, [{ op: "ack" }]);
  assert.deepEqual(limited.ops, [{ op: "ack" }]);
  assert.equal(company.ops[0].op, "retry");
});

test("congestion re-send stops at the hop cap and acks", async () => {
  const under = fake(job("https://busy.example/a", CONGESTION_HOP_CAP - 1));
  const capped = fake(job("https://busy.example/a", CONGESTION_HOP_CAP));
  const sent = [];
  const events = [];
  const counts = [];
  await handleCrawlQueueBatch([under, capped], {
    worker: "browser",
    process,
    failureAction,
    async noteUrlFailure() { return 0; },
    async rememberSkip() {},
    async requeue(body, delaySeconds, hops) {
      sent.push({ hops, delaySeconds, previous: body.congestionHops });
    },
    log(level, event, fields) { events.push({ level, event, hops: fields.hops, error: fields.error }); },
    count(event) { counts.push(event); }
  });
  assert.deepEqual(sent, [{ hops: CONGESTION_HOP_CAP, delaySeconds: 900, previous: CONGESTION_HOP_CAP - 1 }]);
  assert.deepEqual(under.ops, [{ op: "ack" }]);
  assert.deepEqual(capped.ops, [{ op: "ack" }]);
  assert.deepEqual(events.filter((item) => item.event === "crawl_congestion_cap"), [
    { level: "warn", event: "crawl_congestion_cap", hops: CONGESTION_HOP_CAP, error: "domain_busy:250" }
  ]);
  assert.deepEqual(counts, ["crawl_congestion_cap"]);
  assert.equal(events.filter((item) => item.event === "crawl_domain_busy").length, 1);
  assert.deepEqual(counts, ["crawl_congestion_cap"]);
});

test("browser rate-limit text without a 429 prefix is re-sent", async () => {
  const message = fake(job("https://render.example/rate"));
  const sent = [];
  await handleCrawlQueueBatch([message], {
    worker: "browser",
    async process() { throw new Error("Rate limit exceeded"); },
    failureAction: (errorMessage, attempts, urlFailures) => browserFailureAction(errorMessage, { attempts, urlFailures, random: () => 0 }),
    async noteUrlFailure() { return 0; },
    async rememberSkip() {},
    async requeue(_body, delaySeconds, hops) { sent.push({ delaySeconds, hops }); },
    log() {}
  });
  assert.deepEqual(message.ops, [{ op: "ack" }]);
  assert.deepEqual(sent, [{ delaySeconds: 30, hops: 1 }]);
});

test("a thrown count does not stop the cap ack", async () => {
  const capped = fake(job("https://busy.example/a", CONGESTION_HOP_CAP));
  await handleCrawlQueueBatch([capped], {
    worker: "fetch",
    process,
    failureAction,
    async noteUrlFailure() { return 0; },
    async rememberSkip() {},
    async requeue() { throw new Error("should not requeue"); },
    log() {},
    count() { throw new Error("analytics_down"); }
  });
  assert.deepEqual(capped.ops, [{ op: "ack" }]);
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

function parkDeps(coordinator, sent, events, process) {
  return {
    worker: "browser",
    process,
    failureAction,
    async noteUrlFailure() { return 0; },
    async rememberSkip() {},
    async requeue(body, delaySeconds, hops) {
      sent.push({ wake: body.congestionWake ?? null, url: body.payload.url, delaySeconds, hops });
    },
    async parkDomain(input) {
      const response = await coordinator.fetch(new Request("https://do.internal/internal/park", {
        method: "POST",
        body: JSON.stringify({
          lane: "browser",
          urlKey: input.urlKey,
          bodyJson: JSON.stringify(input.body),
          delaySeconds: input.delaySeconds,
          hops: input.hops,
          tenantId: input.tenantId ?? "",
          monitorId: input.monitorId ?? ""
        })
      }));
      assert.equal(response.status, 200);
      return response.json();
    },
    async noteWake(domain, delaySeconds, hops) {
      const response = await coordinator.fetch(new Request("https://do.internal/internal/note-wake", {
        method: "POST",
        body: JSON.stringify({ lane: "browser", delaySeconds, hops, domain })
      }));
      assert.equal(response.status, 200);
    },
    random: () => 0,
    log(level, event, fields) {
      events.push({ level, event, url: fields.url, hops: fields.hops });
    }
  };
}

async function hotProcess(message) {
  if (message.body.congestionWake) throw new Error("domain_busy:250");
  const url = message.body.payload.url;
  if (typeof url === "string" && url.startsWith("https://hot.example/")) throw new Error("domain_busy:250");
  if (url === "https://pool.example/a") throw new Error("browser_pool_busy:250");
  throw new Error(`unexpected:${url}`);
}

test("a hot domain parks each domain_busy job and sends one wake", async () => {
  const coordinator = new DomainCoordinatorDO(new FakeState(), {});
  const messages = Array.from({ length: 20 }, (_item, index) => fake(job(`https://hot.example/p${index}`)));
  const pool = fake(job("https://pool.example/a"));
  const sent = [];
  const events = [];
  await handleCrawlQueueBatch([...messages, pool], parkDeps(coordinator, sent, events, hotProcess));
  assert.equal(sent.length, 2);
  const wake = sent.find((item) => item.wake === "hot.example");
  const poolSend = sent.find((item) => item.wake == null);
  assert.equal(wake.delaySeconds, 30);
  assert.equal(wake.hops, 1);
  assert.equal(poolSend.url, "https://pool.example/a");
  assert.equal(poolSend.hops, 1);
  for (const message of messages) assert.deepEqual(message.ops, [{ op: "ack" }]);
  assert.deepEqual(pool.ops, [{ op: "ack" }]);

  const extra = fake(job("https://hot.example/extra"));
  const again = [];
  await handleCrawlQueueBatch([extra], parkDeps(coordinator, again, [], hotProcess));
  assert.deepEqual(again, []);
  assert.deepEqual(extra.ops, [{ op: "ack" }]);
  assert.equal(events.filter((item) => item.event === "crawl_domain_park_full").length, 0);
});

test("a domain wake that is still busy is re-sent once", async () => {
  const coordinator = new DomainCoordinatorDO(new FakeState(), {});
  const wake = fake({ ...job("https://hot.example/p0", 3), congestionWake: "hot.example" });
  const sent = [];
  let parked = 0;
  const deps = parkDeps(coordinator, sent, [], async (message) => {
    if (message.body.congestionWake) throw new Error("domain_busy:800");
    throw new Error("unexpected");
  });
  const originalPark = deps.parkDomain;
  deps.parkDomain = async (input) => {
    parked += 1;
    return originalPark(input);
  };
  await handleCrawlQueueBatch([wake], deps);
  assert.equal(parked, 0);
  assert.deepEqual(sent, [{ wake: "hot.example", url: "https://hot.example/p0", delaySeconds: domainBusyWakeDelaySeconds(800, 3, () => 0), hops: 4 }]);
  assert.equal(sent[0].delaySeconds, 30);
  assert.deepEqual(wake.ops, [{ op: "ack" }]);

  const more = fake(job("https://hot.example/later"));
  const follow = [];
  await handleCrawlQueueBatch([more], parkDeps(coordinator, follow, [], hotProcess));
  assert.deepEqual(follow, []);
});

test("a wake with parked jobs left uses a short delay and does not climb hops", async () => {
  const message = fake({ ...job("https://hot.example/p0", 4), congestionWake: "hot.example" });
  const sent = [];
  const noted = [];
  await handleCrawlQueueBatch([message], {
    worker: "fetch",
    async process() { throw new Error("domain_wake:1000"); },
    failureAction,
    async noteUrlFailure() { return 0; },
    async rememberSkip() {},
    async requeue(body, delaySeconds, hops) {
      sent.push({ wake: body.congestionWake, delaySeconds, hops });
    },
    async noteWake(_domain, delaySeconds, hops) {
      noted.push({ delaySeconds, hops });
    },
    random: () => 0,
    log() {}
  });
  assert.deepEqual(sent, [{ wake: "hot.example", delaySeconds: 1, hops: 0 }]);
  assert.deepEqual(noted, [{ delaySeconds: 1, hops: 0 }]);
  assert.deepEqual(message.ops, [{ op: "ack" }]);
});

test("overflow with fallback false still re-sends the original job", async () => {
  const message = fake(job("https://hot.example/overflow"));
  const sent = [];
  await handleCrawlQueueBatch([message], {
    worker: "browser",
    async process() { throw new Error("domain_busy:250"); },
    failureAction,
    async noteUrlFailure() { return 0; },
    async rememberSkip() {},
    async requeue(body, delaySeconds, hops) {
      sent.push({ url: body.payload.url, wake: body.congestionWake ?? null, delaySeconds, hops });
    },
    async parkDomain() {
      return { overflow: true, fallback: false, scheduleWake: false, duplicate: false, token: "" };
    },
    log() {}
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://hot.example/overflow");
  assert.equal(sent[0].wake, null);
  assert.deepEqual(message.ops, [{ op: "ack" }]);
});

function drainHarness(take, run, releaseWake, hooks = {}) {
  const completed = [];
  const released = [];
  return {
    completed,
    released,
    drain: () => drainDomainWake({
      take,
      run,
      async complete(urlKey) {
        completed.push(urlKey);
        if (hooks.complete) await hooks.complete(urlKey);
      },
      async releaseClaim(urlKey) { released.push(urlKey); },
      releaseWake
    })
  };
}

test("drainDomainWake claims one job at a time and deletes it only after a successful run", async () => {
  const busy = drainHarness(
    async () => ({ jobs: [], waiting: 4, retryAfterMs: 250 }),
    async () => { throw new Error("should not run"); },
    async () => { throw new Error("should not release"); }
  );
  await assert.rejects(() => busy.drain(), /domain_busy:250/);
  assert.deepEqual(busy.completed, []);

  const ran = [];
  let calls = 0;
  const freed = drainHarness(
    async () => {
      calls += 1;
      if (calls === 1) return { jobs: [{ body: "a", urlKey: "ka" }], waiting: 1, retryAfterMs: 0 };
      if (calls === 2) return { jobs: [{ body: "b", urlKey: "kb" }], waiting: 0, retryAfterMs: 0 };
      return { jobs: [], waiting: 0, retryAfterMs: 0 };
    },
    async (body) => { ran.push(body); },
    async () => ({ waiting: 0, retryAfterMs: 0 })
  );
  await freed.drain();
  assert.deepEqual(ran, ["a", "b"]);
  assert.deepEqual(freed.completed, ["ka", "kb"]);

  let takes = 0;
  const paced = drainHarness(
    async () => {
      takes += 1;
      if (takes === 1) return { jobs: [{ body: "a", urlKey: "ka" }], waiting: 3, retryAfterMs: 0 };
      return { jobs: [], waiting: 3, retryAfterMs: 0 };
    },
    async () => {},
    async () => { throw new Error("release should not run after domain_wake"); }
  );
  await assert.rejects(() => paced.drain(), /domain_wake:1000/);
  assert.deepEqual(paced.completed, ["ka"]);

  const crashed = drainHarness(
    async () => ({ jobs: [{ body: "a", urlKey: "ka" }], waiting: 1, retryAfterMs: 0 }),
    async () => { throw new Error("upstream_http_503"); },
    async () => { throw new Error("should not release"); }
  );
  await assert.rejects(() => crashed.drain(), /upstream_http_503/);
  assert.deepEqual(crashed.completed, []);
  assert.deepEqual(crashed.released, ["ka"]);

  let drained = false;
  const stale = drainHarness(
    async () => ({ jobs: [], waiting: 4, retryAfterMs: 0, stale: true }),
    async () => { drained = true; },
    async () => { throw new Error("should not release"); }
  );
  await stale.drain();
  assert.equal(drained, false);
});

test("a thrown congestion counter still acks the hop cap", async () => {
  const capped = fake(job("https://busy.example/a", CONGESTION_HOP_CAP));
  await handleCrawlQueueBatch([capped], {
    worker: "browser",
    process,
    failureAction,
    async noteUrlFailure() { return 0; },
    async rememberSkip() {},
    async requeue() { throw new Error("should not requeue"); },
    count() { throw new Error("analytics_down"); },
    log() {}
  });
  assert.deepEqual(capped.ops, [{ op: "ack" }]);
});

test("a fetch rate-limit error counts toward the URL cap and a browser one does not", async () => {
  const noted = [];
  const fetched = fake(job("https://fetch.example/rate"));
  await handleCrawlQueueBatch([fetched], {
    worker: "fetch",
    async process() { throw new Error("Rate limit exceeded"); },
    failureAction: (errorMessage, attempts, urlFailures) => fetchFailureAction(errorMessage, { attempts, urlFailures, random: () => 0 }),
    async noteUrlFailure(_body, errorMessage) {
      noted.push(errorMessage);
      return 1;
    },
    async rememberSkip() {},
    async requeue() {},
    log() {}
  });
  assert.deepEqual(noted, ["Rate limit exceeded"]);
  assert.equal(fetched.ops[0].op, "retry");

  const browserNoted = [];
  const rendered = fake(job("https://render.example/rate"));
  await handleCrawlQueueBatch([rendered], {
    worker: "browser",
    async process() { throw new Error("Rate limit exceeded"); },
    failureAction: (errorMessage, attempts, urlFailures) => browserFailureAction(errorMessage, { attempts, urlFailures, random: () => 0 }),
    async noteUrlFailure(_body, errorMessage) {
      browserNoted.push(errorMessage);
      return 1;
    },
    async rememberSkip() {},
    async requeue() {},
    log() {}
  });
  assert.deepEqual(browserNoted, []);
  assert.deepEqual(rendered.ops, [{ op: "ack" }]);
});

test("rate_limited, ratelimited, and rate limiting are re-sent as session congestion", async () => {
  const sent = [];
  const browserAction = (errorMessage, attempts, urlFailures) => browserFailureAction(errorMessage, { attempts, urlFailures, random: () => 0 });
  for (const phrase of ["rate_limited", "ratelimited", "rate limiting"]) {
    const message = fake(job("https://render.example/rate"));
    await handleCrawlQueueBatch([message], {
      worker: "browser",
      async process() { throw new Error(phrase); },
      failureAction: browserAction,
      async noteUrlFailure() { throw new Error("url cap must ignore session congestion"); },
      async rememberSkip() {},
      async requeue(_body, delaySeconds, hops) { sent.push({ phrase, delaySeconds, hops }); },
      log() {}
    });
    assert.deepEqual(message.ops, [{ op: "ack" }]);
  }
  assert.deepEqual(sent, [
    { phrase: "rate_limited", delaySeconds: 30, hops: 1 },
    { phrase: "ratelimited", delaySeconds: 30, hops: 1 },
    { phrase: "rate limiting", delaySeconds: 30, hops: 1 }
  ]);
});

test("a wake failure does not charge the carrier tenant URL cap", async () => {
  const noted = [];
  const wake = fake({
    ...job("https://carrier.example/secret"),
    congestionWake: "hot.example",
    tenantId: "carrier-tenant",
    monitorId: "carrier-monitor"
  });
  await handleCrawlQueueBatch([wake], {
    worker: "browser",
    async process() { throw new Error("domain_park_unavailable"); },
    failureAction,
    async noteUrlFailure() {
      noted.push("counted");
      return 1;
    },
    async rememberSkip() {},
    async requeue() {},
    log() {}
  });
  assert.deepEqual(noted, []);
  assert.equal(wake.ops[0].op, "retry");
});

test("a second monitor on the same URL is parked instead of acked as a duplicate", async () => {
  const coordinator = new DomainCoordinatorDO(new FakeState(), {});
  const first = fake(job("https://hot.example/same"));
  const secondBody = job("https://hot.example/same");
  secondBody.monitorId = "monitor-b";
  secondBody.jobId = "job-b";
  const second = fake(secondBody);
  const sent = [];
  const events = [];
  await handleCrawlQueueBatch([first, second], parkDeps(coordinator, sent, events, hotProcess));
  assert.equal(sent.filter((item) => item.wake === "hot.example").length, 1);
  assert.deepEqual(first.ops, [{ op: "ack" }]);
  assert.deepEqual(second.ops, [{ op: "ack" }]);
  assert.equal(events.filter((item) => item.event === "crawl_domain_park_duplicate").length, 0);
  const state = await (await coordinator.fetch(new Request("https://do.internal/internal/state"))).json();
  assert.equal(state.waiting, 2);

  const again = fake(job("https://hot.example/same"));
  const dupEvents = [];
  const dupSent = [];
  await handleCrawlQueueBatch([again], parkDeps(coordinator, dupSent, dupEvents, hotProcess));
  assert.deepEqual(dupSent, []);
  assert.deepEqual(again.ops, [{ op: "ack" }]);
  assert.equal(dupEvents.filter((item) => item.event === "crawl_domain_park_duplicate").length, 1);
});

test("a hop-capped wake sweeps each parked job and counts once", async () => {
  const coordinator = new DomainCoordinatorDO(new FakeState(), {});
  const sent = [];
  const events = [];
  await handleCrawlQueueBatch(
    [fake(job("https://hot.example/a")), fake(job("https://hot.example/b"))],
    parkDeps(coordinator, sent, events, hotProcess)
  );
  const wakeSend = sent.find((item) => item.wake === "hot.example");
  assert.ok(wakeSend);
  const stateBefore = await (await coordinator.fetch(new Request("https://do.internal/internal/state"))).json();
  const token = stateBefore.wake.find((item) => item.key === "browser").token;
  const capped = fake({
    schemaVersion: 1,
    jobId: "wake:hot.example",
    traceId: "wake:hot.example",
    priority: "normal",
    createdAt: "2026-10-18T00:00:00.000Z",
    attempt: 0,
    congestionHops: CONGESTION_HOP_CAP,
    congestionWake: "hot.example",
    congestionWakeToken: token,
    payload: { source: "web", url: "https://hot.example/", discoveryKey: "wake" }
  });
  const replayed = [];
  const counts = [];
  const capEvents = [];
  let waitingAtRequeue = null;
  await handleCrawlQueueBatch([capped], {
    ...parkDeps(coordinator, replayed, capEvents, async () => { throw new Error("domain_busy:60000"); }),
    async requeue(body, delaySeconds, hops) {
      const during = await (await coordinator.fetch(new Request("https://do.internal/internal/state"))).json();
      waitingAtRequeue = during.waiting;
      replayed.push({
        wake: body.congestionWake ?? null,
        url: body.payload.url,
        delaySeconds,
        hops,
        lifetime: body.congestionLifetime
      });
    },
    async sweepDomain() {
      const response = await coordinator.fetch(new Request("https://do.internal/internal/sweep", {
        method: "POST",
        body: JSON.stringify({ lane: "browser", limit: 32 })
      }));
      const swept = await response.json();
      return {
        jobs: (swept.jobs ?? []).map((item) => ({ body: JSON.parse(item.bodyJson), urlKey: item.urlKey })),
        remaining: swept.remaining
      };
    },
    async completeParked(_domain, urlKey) {
      const response = await coordinator.fetch(new Request("https://do.internal/internal/complete", {
        method: "POST",
        body: JSON.stringify({ lane: "browser", urlKey })
      }));
      assert.equal(response.status, 200);
    },
    count(event) { counts.push(event); }
  });
  assert.deepEqual(capped.ops, [{ op: "ack" }]);
  assert.deepEqual(counts, ["crawl_congestion_cap", "crawl_domain_park_expired", "crawl_domain_park_expired"]);
  assert.equal(capEvents.filter((item) => item.event === "crawl_domain_park_expired").length, 2);
  assert.equal(replayed.length, 2);
  assert.ok(waitingAtRequeue > 0);
  assert.deepEqual(replayed.map((item) => item.hops), [0, 0]);
  assert.deepEqual(replayed.map((item) => item.lifetime), [1, 1]);
  const stateAfter = await (await coordinator.fetch(new Request("https://do.internal/internal/state"))).json();
  assert.equal(stateAfter.waiting, 0);
});

test("a swept job past the lifetime cap is deleted instead of requeued", async () => {
  const message = fake({
    ...job("https://hot.example/", CONGESTION_HOP_CAP),
    congestionWake: "hot.example",
    congestionSweep: true
  });
  const sent = [];
  const completed = [];
  const counts = [];
  const events = [];
  const parkedBody = { ...job("https://hot.example/old"), congestionLifetime: CONGESTION_HOP_CAP };
  await handleCrawlQueueBatch([message], {
    worker: "browser",
    async process() { throw new Error("domain_busy:60000"); },
    failureAction,
    async noteUrlFailure() { return 0; },
    async rememberSkip() {},
    async requeue(body, delaySeconds, hops) {
      sent.push({ url: body.payload.url, hops, lifetime: body.congestionLifetime, sweep: body.congestionSweep ?? null });
    },
    async noteWake() {},
    async sweepDomain() {
      return { jobs: [{ body: parkedBody, urlKey: "k1" }], remaining: 0 };
    },
    async completeParked(_domain, urlKey) { completed.push(urlKey); },
    count(event) { counts.push(event); },
    log(_level, event) { events.push(event); }
  });
  assert.deepEqual(sent, []);
  assert.deepEqual(completed, ["k1"]);
  assert.equal(counts.includes("crawl_congestion_cap"), false);
  assert.deepEqual(counts, ["crawl_domain_park_expired"]);
  assert.ok(events.includes("crawl_domain_park_expired"));
  assert.deepEqual(message.ops, [{ op: "ack" }]);
});
