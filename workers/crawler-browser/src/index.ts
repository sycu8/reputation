import { assertPublicHttpUrl, BROWSER_RUN_ACCOUNT_CONCURRENCY, crawlAttemptKey, crawlCacheHit, crawlCacheSkipReason, createJob, htmlToPlainText, isHardPaywalledHost, normalizeUrl, parseHardPaywallHosts, sha256Hex, shouldApplyUrlRetryCap, unwrapBrowserRunPayload, urlRetryCapReached, type CrawlCacheRecord, type JobEnvelope } from "../../../packages/crawler-core/src/index.ts";
import type { SourceType } from "../../../packages/source-adapters/src/index.ts";
import { structuredLog, workerHealthResponse } from "../../../packages/observability/src/index.ts";
import { browserFailureAction, browserRunFailureMessage, domainBusyParkKey, drainDomainWake, handleCrawlQueueBatch, noteQueuedUrlFailure, rememberQueuedSkip, SWEEP_CHUNK, type DomainParkResult, type DomainSweepResult } from "../../../packages/crawler-core/src/crawl-failure.ts";

interface CrawlPayload {
  source: SourceType;
  url: string;
  discoveryKey: string;
  title?: string | undefined;
  snippet?: string | undefined;
  publishedAt?: string | undefined;
}

interface ProcessPayload {
  source: SourceType;
  canonicalUrl: string;
  contentId: string;
  rawR2Key: string;
  fetchedAt: string;
  discoveryTitle?: string | undefined;
  discoverySnippet?: string | undefined;
  publishedAt?: string | undefined;
  acquisition: "browser" | "cache";
}

interface Env {
  BROWSER: BrowserRun;
  RAW_CONTENT: R2Bucket;
  CRAWL_CACHE: KVNamespace;
  DOMAIN_DO: DurableObjectNamespace;
  BROWSER_POOL_DO: DurableObjectNamespace;
  CRAWL_BROWSER: Queue<JobEnvelope<CrawlPayload>>;
  /** Producer for parked jobs that passed the lifetime cap. The queue has no consumer. */
  CRAWL_DLQ?: Queue<JobEnvelope<CrawlPayload>>;
  PROCESS_CONTENT: Queue<JobEnvelope<ProcessPayload>>;
  ANALYTICS?: AnalyticsEngineDataset;
  /** Comma-separated registrable domains. Defaults to ft.com,nytimes.com when unset. */
  HARD_PAYWALL_HOSTS?: string;
}

async function doCall<T>(stub: DurableObjectStub, path: string, body: Record<string, unknown>): Promise<{ response: Response; data: T }> {
  const response = await stub.fetch(`https://do.internal${path}`, { method: "POST", body: JSON.stringify(body) });
  const data = await response.json() as T;
  return { response, data };
}

async function releaseQuietly(
  stub: DurableObjectStub,
  path: string,
  body: Record<string, unknown>,
  log: { message: string; requestId: string; tenantId?: string | undefined; monitorId?: string | undefined; extra: Record<string, unknown> }
): Promise<void> {
  try {
    await doCall(stub, path, body);
  } catch (error) {
    structuredLog("warn", log.message, {
      requestId: log.requestId,
      tenantId: log.tenantId,
      monitorId: log.monitorId
    }, {
      ...log.extra,
      error: error instanceof Error ? error.message : "unknown"
    });
  }
}

async function urlHashForPayload(rawUrl: string): Promise<string | null> {
  try {
    return await sha256Hex(normalizeUrl(assertPublicHttpUrl(rawUrl).toString()));
  } catch {
    return null;
  }
}

async function postDomain<T>(env: Env, domain: string, path: string, body: Record<string, unknown>): Promise<T | null> {
  const stub = env.DOMAIN_DO.get(env.DOMAIN_DO.idFromName(domain));
  const response = await stub.fetch(`https://do.internal${path}`, { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) return null;
  return await response.json() as T;
}

async function parkBrowserDomain(
  env: Env,
  input: {
    domain: string;
    urlKey: string;
    body: JobEnvelope<CrawlPayload>;
    delaySeconds: number;
    hops: number;
    tenantId: string | undefined;
    monitorId: string | undefined;
  }
): Promise<DomainParkResult | null> {
  try {
    return await postDomain<DomainParkResult>(env, input.domain, "/internal/park", {
      lane: "browser",
      urlKey: input.urlKey || domainBusyParkKey(input.body.tenantId, input.body.payload.url, input.body.monitorId || input.body.jobId),
      bodyJson: JSON.stringify(input.body),
      delaySeconds: input.delaySeconds,
      hops: input.hops,
      tenantId: input.tenantId ?? input.body.tenantId ?? "",
      monitorId: input.monitorId ?? input.body.monitorId ?? ""
    });
  } catch {
    return null;
  }
}

async function noteBrowserWake(env: Env, domain: string, delaySeconds: number, hops: number): Promise<void> {
  await postDomain(env, domain, "/internal/note-wake", { lane: "browser", delaySeconds, hops });
}

async function completeBrowserParked(env: Env, domain: string, urlKey: string): Promise<void> {
  const done = await postDomain<{ ok?: boolean }>(env, domain, "/internal/complete", { lane: "browser", urlKey });
  if (!done) throw new Error("domain_park_unavailable");
}

async function noteBrowserParked(env: Env, domain: string, urlKey: string, body: JobEnvelope<CrawlPayload>): Promise<void> {
  const done = await postDomain<{ ok?: boolean }>(env, domain, "/internal/revise-park", {
    lane: "browser",
    urlKey,
    bodyJson: JSON.stringify(body)
  });
  if (!done?.ok) throw new Error("domain_park_unavailable");
}

async function deadLetterBrowser(env: Env, body: JobEnvelope<CrawlPayload>, reason: string, domain: string): Promise<void> {
  const queue = env.CRAWL_DLQ;
  if (!queue) throw new Error("crawl_dlq_unbound");
  await queue.send({
    ...body,
    parkExpiredReason: reason,
    parkExpiredDomain: domain,
    parkExpiredAt: new Date().toISOString()
  });
}

async function sweepBrowserDomain(
  env: Env,
  domain: string,
  options?: { continueSweep?: boolean }
): Promise<DomainSweepResult<JobEnvelope<CrawlPayload>>> {
  const swept = await postDomain<{ jobs?: Array<{ bodyJson?: unknown; urlKey?: unknown }>; remaining?: unknown; unvisited?: unknown }>(
    env, domain, "/internal/sweep", { lane: "browser", limit: SWEEP_CHUNK, continue: options?.continueSweep === true }
  );
  if (!swept) throw new Error("domain_park_unavailable");
  const jobs: Array<{ body: JobEnvelope<CrawlPayload>; urlKey: string }> = [];
  for (const job of swept.jobs ?? []) {
    if (typeof job.bodyJson !== "string" || typeof job.urlKey !== "string") continue;
    try {
      jobs.push({ body: JSON.parse(job.bodyJson) as JobEnvelope<CrawlPayload>, urlKey: job.urlKey });
    } catch {
      logCrawlQueue("warn", "crawl_domain_park_bad_body", { requestId: "", domain, urlKey: job.urlKey });
      try {
        await completeBrowserParked(env, domain, job.urlKey);
      } catch {
        /* the next sweep retries this row */
      }
    }
  }
  const remaining = Number(swept.remaining ?? 0);
  return {
    jobs,
    remaining,
    unvisited: typeof swept.unvisited === "number" ? swept.unvisited : remaining
  };
}

function replayBrowser(env: Env, body: JobEnvelope<CrawlPayload>): { message: Message<JobEnvelope<CrawlPayload>>; pending: Array<Promise<unknown>> } {
  const pending: Array<Promise<unknown>> = [];
  const message = {
    attempts: 1,
    body,
    ack() {},
    retry(options?: { delaySeconds?: number }) {
      const delaySeconds = options?.delaySeconds;
      pending.push(delaySeconds ? env.CRAWL_BROWSER.send(body, { delaySeconds }) : env.CRAWL_BROWSER.send(body));
    }
  } as Message<JobEnvelope<CrawlPayload>>;
  return { message, pending };
}

async function drainBrowserWake(env: Env, domain: string, token: string): Promise<void> {
  await drainDomainWake({
    async take() {
      const taken = await postDomain<{
        stale?: boolean;
        jobs?: Array<{ bodyJson?: unknown; urlKey?: unknown }>;
        waiting?: number;
        retryAfterMs?: number;
      }>(env, domain, "/internal/take", { lane: "browser", limit: 1, token });
      if (!taken) throw new Error("domain_park_unavailable");
      if (taken.stale) return { jobs: [], waiting: Number(taken.waiting ?? 0), retryAfterMs: 0, stale: true };
      const jobs: Array<{ body: JobEnvelope<CrawlPayload>; urlKey: string }> = [];
      for (const job of taken.jobs ?? []) {
        if (typeof job.bodyJson !== "string" || typeof job.urlKey !== "string") continue;
        try {
          jobs.push({ body: JSON.parse(job.bodyJson) as JobEnvelope<CrawlPayload>, urlKey: job.urlKey });
        } catch {
          logCrawlQueue("warn", "crawl_domain_park_bad_body", { requestId: "", domain });
          await postDomain(env, domain, "/internal/complete", { lane: "browser", urlKey: job.urlKey });
        }
      }
      return { jobs, waiting: Number(taken.waiting ?? 0), retryAfterMs: Number(taken.retryAfterMs ?? 0) };
    },
    async run(body) {
      const replay = replayBrowser(env, body);
      try {
        await crawlMessage(replay.message, env);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown";
        if (message.startsWith("domain_busy:")) throw error;
        await handleCrawlQueueBatch([replay.message], {
          ...queueDeps(env),
          process: async () => { throw error; }
        });
        await Promise.all(replay.pending);
      }
    },
    async complete(urlKey) {
      const done = await postDomain(env, domain, "/internal/complete", { lane: "browser", urlKey });
      if (!done) throw new Error("domain_park_unavailable");
    },
    async releaseClaim(urlKey) {
      await postDomain(env, domain, "/internal/release-claim", { lane: "browser", urlKey });
    },
    async releaseWake() {
      const left = await postDomain<{ waiting?: number; retryAfterMs?: number }>(env, domain, "/internal/release-wake", { lane: "browser" });
      if (!left) throw new Error("domain_park_unavailable");
      return { waiting: Number(left.waiting ?? 0), retryAfterMs: Number(left.retryAfterMs ?? 0) };
    }
  });
}

async function processMessage(message: Message<JobEnvelope<CrawlPayload>>, env: Env): Promise<void> {
  const wake = message.body.congestionWake;
  if (typeof wake === "string" && wake.length > 0) {
    const token = message.body.congestionWakeToken;
    await drainBrowserWake(env, wake, typeof token === "string" ? token : "");
    return;
  }
  await crawlMessage(message, env);
}

async function crawlMessage(message: Message<JobEnvelope<CrawlPayload>>, env: Env): Promise<void> {
  const job = message.body;
  const target = assertPublicHttpUrl(job.payload.url);
  const canonicalUrl = normalizeUrl(target.toString());
  const domain = target.hostname.toLowerCase();
  if (isHardPaywalledHost(domain, parseHardPaywallHosts(env.HARD_PAYWALL_HOSTS))) throw new Error("hard_paywall_host");
  const urlHash = await sha256Hex(canonicalUrl);
  const cached = await env.CRAWL_CACHE.get(`crawl:${urlHash}`);
  if (cached) {
    const record = JSON.parse(cached) as CrawlCacheRecord;
    const skip = crawlCacheSkipReason(record);
    if (skip) {
      structuredLog("info", "crawl_browser_skipped", {
        requestId: job.traceId,
        tenantId: job.tenantId,
        monitorId: job.monitorId
      }, { jobId: job.jobId, url: job.payload.url, reason: skip });
      return;
    }
    const hit = crawlCacheHit(record);
    if (hit) {
      await env.PROCESS_CONTENT.send(createJob<ProcessPayload>({
        source: job.payload.source,
        canonicalUrl: hit.canonicalUrl,
        contentId: hit.contentId,
        rawR2Key: hit.rawR2Key,
        fetchedAt: hit.fetchedAt,
        discoveryTitle: job.payload.title,
        discoverySnippet: job.payload.snippet,
        publishedAt: job.payload.publishedAt,
        acquisition: "cache"
      }, {
        traceId: job.traceId,
        tenantId: job.tenantId,
        monitorId: job.monitorId,
        priority: job.priority
      }));
      structuredLog("info", "crawl_browser_cache_hit", {
        requestId: job.traceId,
        tenantId: job.tenantId,
        monitorId: job.monitorId
      }, { jobId: job.jobId, url: job.payload.url, contentId: hit.contentId });
      return;
    }
  }
  if (shouldApplyUrlRetryCap(message.attempts)) {
    const recordedFailures = Number(await env.CRAWL_CACHE.get(crawlAttemptKey(job.tenantId, urlHash)) ?? "0");
    if (urlRetryCapReached(Number.isFinite(recordedFailures) ? recordedFailures : 0)) throw new Error("url_retry_cap");
  }

  const domainStub = env.DOMAIN_DO.get(env.DOMAIN_DO.idFromName(domain));
  const poolStub = env.BROWSER_POOL_DO.get(env.BROWSER_POOL_DO.idFromName("global"));

  const poolLease = await doCall<{ granted: boolean; retryAfterMs?: number; leaseId?: string }>(
    poolStub,
    "/internal/acquire",
    { maxActive: BROWSER_RUN_ACCOUNT_CONCURRENCY, priority: job.priority }
  );
  if (!poolLease.response.ok || !poolLease.data.granted || !poolLease.data.leaseId) {
    throw new Error(`browser_pool_busy:${poolLease.data.retryAfterMs ?? 1000}`);
  }
  const leaseId = poolLease.data.leaseId;
  let domainAcquired = false;
  let domainLeaseId = "";
  let domainStatus = 500;
  let domainRetryAfterMs = 2000;
  const started = Date.now();
  try {
    const domainLease = await doCall<{ granted: boolean; retryAfterMs?: number; leaseId?: string }>(domainStub, "/internal/acquire", {
      domain,
      maxConcurrency: 2,
      minDelayMs: 750
    });
    if (!domainLease.response.ok || !domainLease.data.granted) throw new Error(`domain_busy:${domainLease.data.retryAfterMs ?? 1000}`);
    domainAcquired = true;
    domainLeaseId = domainLease.data.leaseId ?? "";

    const browserResponse = await env.BROWSER.quickAction("content", {
      url: canonicalUrl,
      gotoOptions: { waitUntil: "networkidle2", timeout: 15_000 },
      rejectResourceTypes: ["image", "media", "font"],
      userAgent: "PulseWatchBot/0.1 (+public reputation monitoring; contact configured by operator)"
    });
    if (!browserResponse.ok) {
      const bodyText = await browserResponse.text().catch(() => "");
      throw new Error(browserRunFailureMessage(browserResponse.status, browserResponse.headers.get("retry-after"), bodyText));
    }
    const rawBody = await browserResponse.text();
    if (rawBody.length > 8 * 1024 * 1024) throw new Error("browser_body_too_large");
    const unwrapped = unwrapBrowserRunPayload(rawBody);
    const html = unwrapped.body;
    const extracted = htmlToPlainText(html);
    const pageTitle = unwrapped.title ?? extracted.title ?? job.payload.title ?? null;
    if (extracted.text.length < 100) throw new Error("browser_extraction_too_small");

    const bodyHash = await sha256Hex(html);
    const contentId = await sha256Hex(`${job.payload.source}\u001f${canonicalUrl}\u001f${bodyHash}`);
    const fetchedAt = new Date().toISOString();
    const rawR2Key = `content/${urlHash}/${bodyHash}/browser.json`;
    const browserMs = Number(browserResponse.headers.get("x-browser-ms-used") ?? String(Date.now() - started));
    await env.RAW_CONTENT.put(rawR2Key, JSON.stringify({
      schemaVersion: 1,
      source: job.payload.source,
      requestedUrl: job.payload.url,
      canonicalUrl,
      fetchedAt,
      title: pageTitle,
      extractedText: extracted.text,
      rawBody: html,
      acquisition: "browser-run-content",
      browserMs
    }));
    await env.CRAWL_CACHE.put(`crawl:${urlHash}`, JSON.stringify({ contentId, rawR2Key, fetchedAt, canonicalUrl }), { expirationTtl: 600 });
    await env.PROCESS_CONTENT.send(createJob<ProcessPayload>({
      source: job.payload.source,
      canonicalUrl,
      contentId,
      rawR2Key,
      fetchedAt,
      discoveryTitle: job.payload.title ?? pageTitle ?? undefined,
      discoverySnippet: job.payload.snippet,
      publishedAt: job.payload.publishedAt,
      acquisition: "browser"
    }, {
      traceId: job.traceId,
      tenantId: job.tenantId,
      monitorId: job.monitorId,
      priority: job.priority
    }));
    env.ANALYTICS?.writeDataPoint({ indexes: [urlHash], blobs: ["browser_success", job.payload.source], doubles: [browserMs, html.length] });
    domainStatus = 200;
    domainRetryAfterMs = 0;
  } finally {
    // Domain release errors must not skip the pool release. Pool release errors must not
    // replace a successful crawl (the lease expires via the DO alarm if this call fails).
    if (domainAcquired) {
      await releaseQuietly(domainStub, "/internal/release", {
        domain,
        status: domainStatus,
        retryAfterMs: domainRetryAfterMs,
        ...(domainLeaseId ? { leaseId: domainLeaseId } : {})
      }, {
        message: "domain_release_failed",
        requestId: job.traceId,
        tenantId: job.tenantId,
        monitorId: job.monitorId,
        extra: { domain }
      });
    }
    await releaseQuietly(poolStub, "/internal/release", { leaseId }, {
      message: "browser_pool_release_failed",
      requestId: job.traceId,
      tenantId: job.tenantId,
      monitorId: job.monitorId,
      extra: { leaseId }
    });
  }
}

function logCrawlQueue(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
  structuredLog(level, event, {
    requestId: typeof fields.requestId === "string" ? fields.requestId : "",
    tenantId: typeof fields.tenantId === "string" ? fields.tenantId : undefined,
    monitorId: typeof fields.monitorId === "string" ? fields.monitorId : undefined
  }, fields);
}

function queueDeps(env: Env) {
  return {
    worker: "browser" as const,
    process: (message: Message<JobEnvelope<CrawlPayload>>) => processMessage(message, env),
    failureAction: (errorMessage: string, attempts: number, urlFailures: number) => browserFailureAction(errorMessage, { attempts, urlFailures, random: Math.random }),
    noteUrlFailure: (body: JobEnvelope<CrawlPayload>, errorMessage: string) => noteQueuedUrlFailure(env.CRAWL_CACHE, body, errorMessage, urlHashForPayload, "browser"),
    rememberSkip: (body: JobEnvelope<CrawlPayload>, errorMessage: string, ttlSeconds: number) => rememberQueuedSkip(env.CRAWL_CACHE, body, errorMessage, ttlSeconds, urlHashForPayload),
    requeue: async (body: JobEnvelope<CrawlPayload>, delaySeconds: number, hops: number) => {
      await env.CRAWL_BROWSER.send({ ...body, congestionHops: hops }, { delaySeconds });
    },
    parkDomain: (input: {
      domain: string;
      urlKey: string;
      body: JobEnvelope<CrawlPayload>;
      delaySeconds: number;
      hops: number;
      tenantId: string | undefined;
      monitorId: string | undefined;
    }) => parkBrowserDomain(env, input),
    noteWake: (domain: string, delaySeconds: number, hops: number) => noteBrowserWake(env, domain, delaySeconds, hops),
    sweepDomain: (domain: string, options?: { continueSweep?: boolean }) => sweepBrowserDomain(env, domain, options),
    completeParked: (domain: string, urlKey: string) => completeBrowserParked(env, domain, urlKey),
    noteParked: (domain: string, urlKey: string, body: JobEnvelope<CrawlPayload>) => noteBrowserParked(env, domain, urlKey, body),
    deadLetter: (body: JobEnvelope<CrawlPayload>, reason: string, domain: string) => deadLetterBrowser(env, body, reason, domain),
    count(event: string, domain?: string) {
      const blobs = domain ? [event, "browser", domain] : [event, "browser"];
      env.ANALYTICS?.writeDataPoint({ indexes: [event], blobs, doubles: [1] });
    },
    random: Math.random,
    log: logCrawlQueue
  };
}

export default {
  async fetch(): Promise<Response> {
    return workerHealthResponse("crawler-browser");
  },

  async queue(batch: MessageBatch<JobEnvelope<CrawlPayload>>, env: Env): Promise<void> {
    await handleCrawlQueueBatch(batch.messages, queueDeps(env));
  }
};
