import { assertPublicHttpUrl, crawlAttemptKey, crawlCacheHit, crawlCacheSkipReason, createJob, isHardPaywalledHost, normalizeUrl, parseHardPaywallHosts, sha256Hex, shouldApplyUrlRetryCap, urlRetryCapReached, type CrawlCacheRecord, type JobEnvelope } from "../../../packages/crawler-core/src/index.ts";
import type { SourceType } from "../../../packages/source-adapters/src/index.ts";
import { structuredLog, workerHealthResponse } from "../../../packages/observability/src/index.ts";
import { classifyUpstreamStatus, fetchFailureAction, handleCrawlQueueBatch, nextDomainBackoffMs, noteQueuedUrlFailure, parseRetryAfterMs, rememberQueuedSkip } from "./upstream.ts";
import { domainBusyParkKey, drainDomainWake, type DomainParkResult } from "../../../packages/crawler-core/src/crawl-failure.ts";

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
  acquisition: "fetch" | "cache";
}

interface Env {
  RAW_CONTENT: R2Bucket;
  CRAWL_CACHE: KVNamespace;
  CRAWL_BROWSER: Queue<JobEnvelope<CrawlPayload>>;
  CRAWL_STATIC: Queue<JobEnvelope<CrawlPayload>>;
  PROCESS_CONTENT: Queue<JobEnvelope<ProcessPayload>>;
  DOMAIN_DO?: DurableObjectNamespace;
  ANALYTICS?: AnalyticsEngineDataset;
  /** Comma-separated registrable domains. Defaults to ft.com,nytimes.com when unset. */
  HARD_PAYWALL_HOSTS?: string;
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const CACHE_TTL_SECONDS = 600;

function isTextual(contentType: string | null): boolean {
  if (!contentType) return true;
  const value = contentType.toLowerCase();
  return value.includes("text/") || value.includes("application/json") || value.includes("application/xml") || value.includes("application/rss+xml") || value.includes("application/atom+xml") || value.includes("application/xhtml+xml");
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel("body_too_large");
      throw new Error("body_too_large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

async function safeFetch(input: string, paywallHosts: readonly string[]): Promise<{ response: Response; finalUrl: string }> {
  let current = assertPublicHttpUrl(input).toString();
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    if (isHardPaywalledHost(new URL(current).hostname, paywallHosts)) throw new Error("hard_paywall_host");
    const response = await fetch(current, {
      redirect: "manual",
      headers: {
        "user-agent": "PulseWatchBot/0.1 (+public reputation monitoring; contact configured by operator)",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.2"
      },
      signal: AbortSignal.timeout(10_000)
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("redirect_without_location");
      current = assertPublicHttpUrl(new URL(location, current).toString()).toString();
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new Error("too_many_redirects");
}

function stripHtml(html: string): { title: string | null; text: string; scriptRatio: number } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? null;
  const scriptBytes = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)].reduce((sum, match) => sum + match[0].length, 0);
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return { title, text, scriptRatio: html.length ? scriptBytes / html.length : 0 };
}

function fetchQuality(contentType: string | null, body: string): { score: number; needsBrowser: boolean; title: string | null; text: string } {
  if (!contentType?.toLowerCase().includes("html")) {
    return { score: body.length >= 100 ? 100 : 50, needsBrowser: false, title: null, text: body.trim() };
  }
  const parsed = stripHtml(body);
  let score = 0;
  if (parsed.title) score += 20;
  if (parsed.text.length >= 300) score += 40;
  if (parsed.text.length >= 1_000) score += 20;
  if (parsed.scriptRatio < 0.35) score += 20;
  return { score, needsBrowser: score < 55, title: parsed.title, text: parsed.text };
}

function domainStub(env: Env, domain: string): DurableObjectStub | null {
  if (!env.DOMAIN_DO) return null;
  return env.DOMAIN_DO.get(env.DOMAIN_DO.idFromName(domain));
}

async function domainBlockMs(env: Env, domain: string): Promise<{ waitMs: number; recent429: number; backoffUntil: number }> {
  const stub = domainStub(env, domain);
  if (!stub) return { waitMs: 0, recent429: 0, backoffUntil: 0 };
  const response = await stub.fetch("https://do.internal/internal/state");
  if (!response.ok) return { waitMs: 0, recent429: 0, backoffUntil: 0 };
  const data = await response.json() as { state?: { backoff_until?: number; recent_429?: number } | null };
  const backoffUntil = Number(data.state?.backoff_until ?? 0);
  const recent429 = Number(data.state?.recent_429 ?? 0);
  const waitMs = backoffUntil - Date.now();
  return { waitMs: waitMs > 0 ? waitMs : 0, recent429, backoffUntil };
}

async function recordDomainBackoff(env: Env, domain: string, retryAfterMs: number): Promise<void> {
  const stub = domainStub(env, domain);
  if (!stub) return;
  await stub.fetch("https://do.internal/internal/release", {
    method: "POST",
    body: JSON.stringify({ domain, status: 429, retryAfterMs })
  });
}

async function postDomain<T>(env: Env, domain: string, path: string, body: Record<string, unknown>): Promise<T | null> {
  const stub = domainStub(env, domain);
  if (!stub) return null;
  const response = await stub.fetch(`https://do.internal${path}`, { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) return null;
  return await response.json() as T;
}

async function parkFetchDomain(
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
      lane: "fetch",
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

async function noteFetchWake(env: Env, domain: string, delaySeconds: number, hops: number): Promise<void> {
  await postDomain(env, domain, "/internal/note-wake", { lane: "fetch", delaySeconds, hops });
}

async function sweepFetchDomain(env: Env, domain: string): Promise<Array<JobEnvelope<CrawlPayload>>> {
  const swept = await postDomain<{ jobs?: Array<{ bodyJson?: unknown }> }>(env, domain, "/internal/sweep", { lane: "fetch" });
  if (!swept) throw new Error("domain_park_unavailable");
  const jobs: Array<JobEnvelope<CrawlPayload>> = [];
  for (const job of swept.jobs ?? []) {
    if (typeof job.bodyJson !== "string") continue;
    try {
      jobs.push(JSON.parse(job.bodyJson) as JobEnvelope<CrawlPayload>);
    } catch {
      logCrawlQueue("warn", "crawl_domain_park_bad_body", { requestId: "", domain });
    }
  }
  return jobs;
}

function replayFetch(env: Env, body: JobEnvelope<CrawlPayload>): { message: Message<JobEnvelope<CrawlPayload>>; pending: Array<Promise<unknown>> } {
  const pending: Array<Promise<unknown>> = [];
  const message = {
    attempts: 1,
    body,
    ack() {},
    retry(options?: { delaySeconds?: number }) {
      const delaySeconds = options?.delaySeconds;
      pending.push(delaySeconds ? env.CRAWL_STATIC.send(body, { delaySeconds }) : env.CRAWL_STATIC.send(body));
    }
  } as Message<JobEnvelope<CrawlPayload>>;
  return { message, pending };
}

async function drainFetchWake(env: Env, domain: string, token: string): Promise<void> {
  await drainDomainWake({
    async take() {
      const taken = await postDomain<{
        stale?: boolean;
        jobs?: Array<{ bodyJson?: unknown; urlKey?: unknown }>;
        waiting?: number;
        retryAfterMs?: number;
      }>(env, domain, "/internal/take", { lane: "fetch", limit: 1, token });
      if (!taken) throw new Error("domain_park_unavailable");
      if (taken.stale) return { jobs: [], waiting: Number(taken.waiting ?? 0), retryAfterMs: 0, stale: true };
      const jobs: Array<{ body: JobEnvelope<CrawlPayload>; urlKey: string }> = [];
      for (const job of taken.jobs ?? []) {
        if (typeof job.bodyJson !== "string" || typeof job.urlKey !== "string") continue;
        try {
          jobs.push({ body: JSON.parse(job.bodyJson) as JobEnvelope<CrawlPayload>, urlKey: job.urlKey });
        } catch {
          logCrawlQueue("warn", "crawl_domain_park_bad_body", { requestId: "", domain });
          await postDomain(env, domain, "/internal/complete", { lane: "fetch", urlKey: job.urlKey });
        }
      }
      return { jobs, waiting: Number(taken.waiting ?? 0), retryAfterMs: Number(taken.retryAfterMs ?? 0) };
    },
    async run(body) {
      const replay = replayFetch(env, body);
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
      const done = await postDomain(env, domain, "/internal/complete", { lane: "fetch", urlKey });
      if (!done) throw new Error("domain_park_unavailable");
    },
    async releaseClaim(urlKey) {
      await postDomain(env, domain, "/internal/release-claim", { lane: "fetch", urlKey });
    },
    async releaseWake() {
      const left = await postDomain<{ waiting?: number; retryAfterMs?: number }>(env, domain, "/internal/release-wake", { lane: "fetch" });
      if (!left) throw new Error("domain_park_unavailable");
      return { waiting: Number(left.waiting ?? 0), retryAfterMs: Number(left.retryAfterMs ?? 0) };
    }
  });
}

async function processMessage(message: Message<JobEnvelope<CrawlPayload>>, env: Env): Promise<void> {
  const wake = message.body.congestionWake;
  if (typeof wake === "string" && wake.length > 0) {
    const token = message.body.congestionWakeToken;
    await drainFetchWake(env, wake, typeof token === "string" ? token : "");
    return;
  }
  await crawlMessage(message, env);
}

async function crawlMessage(message: Message<JobEnvelope<CrawlPayload>>, env: Env): Promise<void> {
  const job = message.body;
  const payload = job.payload;
  const normalized = normalizeUrl(assertPublicHttpUrl(payload.url).toString());
  const urlHash = await sha256Hex(normalized);
  const cacheKey = `crawl:${urlHash}`;
  const paywallHosts = parseHardPaywallHosts(env.HARD_PAYWALL_HOSTS);
  const domain = new URL(normalized).hostname.toLowerCase();
  if (isHardPaywalledHost(domain, paywallHosts)) throw new Error("hard_paywall_host");
  const cached = await env.CRAWL_CACHE.get(cacheKey);
  if (cached) {
    const record = JSON.parse(cached) as CrawlCacheRecord;
    const skip = crawlCacheSkipReason(record);
    if (skip) {
      structuredLog("info", "crawl_fetch_skipped", {
        requestId: job.traceId,
        tenantId: job.tenantId,
        monitorId: job.monitorId
      }, { jobId: job.jobId, url: payload.url, reason: skip });
      return;
    }
    const hit = crawlCacheHit(record);
    if (hit) {
      await env.PROCESS_CONTENT.send(createJob<ProcessPayload>({
        ...hit,
        source: payload.source,
        discoveryTitle: payload.title,
        discoverySnippet: payload.snippet,
        publishedAt: payload.publishedAt,
        acquisition: "cache"
      }, {
        traceId: job.traceId,
        tenantId: job.tenantId,
        monitorId: job.monitorId,
        priority: job.priority
      }));
      env.ANALYTICS?.writeDataPoint({ indexes: [urlHash], blobs: ["crawl_cache_hit", payload.source], doubles: [1] });
      return;
    }
  }

  if (shouldApplyUrlRetryCap(message.attempts)) {
    const recordedFailures = Number(await env.CRAWL_CACHE.get(crawlAttemptKey(job.tenantId, urlHash)) ?? "0");
    if (urlRetryCapReached(Number.isFinite(recordedFailures) ? recordedFailures : 0)) throw new Error("url_retry_cap");
  }

  const blocked = await domainBlockMs(env, domain);
  if (blocked.waitMs > 0) throw new Error(`domain_busy:${Math.ceil(blocked.waitMs)}`);

  const { response, finalUrl } = await safeFetch(normalized, paywallHosts);
  if (!response.ok) {
    const action = classifyUpstreamStatus(response.status);
    try { await response.body?.cancel(); } catch { /* already consumed */ }
    if (action === "browser") {
      await env.CRAWL_BROWSER.send(job);
      env.ANALYTICS?.writeDataPoint({ indexes: [urlHash], blobs: ["browser_escalation_blocked", payload.source], doubles: [response.status] });
      structuredLog("info", "crawl_fetch_browser", {
        requestId: job.traceId,
        tenantId: job.tenantId,
        monitorId: job.monitorId
      }, { jobId: job.jobId, url: payload.url, status: response.status });
      return;
    }
    if (action === "permanent") {
      throw new Error(`upstream_http_permanent:${response.status}`);
    }
    if (action === "backoff") {
      const headerMs = parseRetryAfterMs(response.headers.get("retry-after"));
      const retryAfterMs = nextDomainBackoffMs({
        now: Date.now(),
        backoffUntil: blocked.backoffUntil,
        recent429: blocked.recent429,
        retryAfterMs: headerMs
      });
      await recordDomainBackoff(env, domain, retryAfterMs);
      throw new Error(`upstream_backoff_429:${retryAfterMs}`);
    }
    throw new Error(`upstream_http_${response.status}`);
  }
  const contentType = response.headers.get("content-type");
  if (!isTextual(contentType)) throw new Error("unsupported_content_type");
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) throw new Error("body_too_large");
  const body = await readLimitedText(response, MAX_BODY_BYTES);
  const quality = fetchQuality(contentType, body);
  if (quality.needsBrowser) {
    await env.CRAWL_BROWSER.send(job);
    env.ANALYTICS?.writeDataPoint({ indexes: [urlHash], blobs: ["browser_escalation", payload.source], doubles: [quality.score] });
    return;
  }

  const canonicalUrl = normalizeUrl(finalUrl);
  const bodyHash = await sha256Hex(body);
  const contentId = await sha256Hex(`${payload.source}\u001f${canonicalUrl}\u001f${bodyHash}`);
  const fetchedAt = new Date().toISOString();
  const rawR2Key = `content/${urlHash}/${bodyHash}/raw.json`;
  const record = {
    schemaVersion: 1,
    source: payload.source,
    requestedUrl: payload.url,
    canonicalUrl,
    status: response.status,
    contentType,
    fetchedAt,
    title: quality.title ?? payload.title ?? null,
    extractedText: quality.text,
    rawBody: body,
    headers: {
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified")
    }
  };
  await env.RAW_CONTENT.put(rawR2Key, JSON.stringify(record));
  await env.CRAWL_CACHE.put(cacheKey, JSON.stringify({ contentId, rawR2Key, fetchedAt, canonicalUrl }), { expirationTtl: CACHE_TTL_SECONDS });
  await env.PROCESS_CONTENT.send(createJob<ProcessPayload>({
    source: payload.source,
    canonicalUrl,
    contentId,
    rawR2Key,
    fetchedAt,
    discoveryTitle: payload.title,
    discoverySnippet: payload.snippet,
    publishedAt: payload.publishedAt,
    acquisition: "fetch"
  }, {
    traceId: job.traceId,
    tenantId: job.tenantId,
    monitorId: job.monitorId,
    priority: job.priority
  }));
  env.ANALYTICS?.writeDataPoint({ indexes: [urlHash], blobs: ["crawl_fetch", payload.source], doubles: [body.length, quality.score] });
}

async function urlHashForPayload(rawUrl: string): Promise<string | null> {
  try {
    return await sha256Hex(normalizeUrl(assertPublicHttpUrl(rawUrl).toString()));
  } catch {
    return null;
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
    worker: "fetch" as const,
    process: (message: Message<JobEnvelope<CrawlPayload>>) => processMessage(message, env),
    failureAction: (errorMessage: string, attempts: number, urlFailures: number) => fetchFailureAction(errorMessage, { attempts, urlFailures, random: Math.random }),
    noteUrlFailure: (body: JobEnvelope<CrawlPayload>, errorMessage: string) => noteQueuedUrlFailure(env.CRAWL_CACHE, body, errorMessage, urlHashForPayload, "fetch"),
    rememberSkip: (body: JobEnvelope<CrawlPayload>, errorMessage: string, ttlSeconds: number) => rememberQueuedSkip(env.CRAWL_CACHE, body, errorMessage, ttlSeconds, urlHashForPayload),
    requeue: async (body: JobEnvelope<CrawlPayload>, delaySeconds: number, hops: number) => {
      await env.CRAWL_STATIC.send({ ...body, congestionHops: hops }, { delaySeconds });
    },
    parkDomain: (input: {
      domain: string;
      urlKey: string;
      body: JobEnvelope<CrawlPayload>;
      delaySeconds: number;
      hops: number;
      tenantId: string | undefined;
      monitorId: string | undefined;
    }) => parkFetchDomain(env, input),
    noteWake: (domain: string, delaySeconds: number, hops: number) => noteFetchWake(env, domain, delaySeconds, hops),
    sweepDomain: (domain: string) => sweepFetchDomain(env, domain),
    count(event: string) {
      env.ANALYTICS?.writeDataPoint({ indexes: [event], blobs: [event, "fetch"], doubles: [1] });
    },
    random: Math.random,
    log: logCrawlQueue
  };
}

export default {
  async fetch(): Promise<Response> {
    return workerHealthResponse("crawler-fetch");
  },

  async queue(batch: MessageBatch<JobEnvelope<CrawlPayload>>, env: Env): Promise<void> {
    await handleCrawlQueueBatch(batch.messages, queueDeps(env));
  }
};
