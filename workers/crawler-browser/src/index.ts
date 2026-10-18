import { assertPublicHttpUrl, BROWSER_RUN_ACCOUNT_CONCURRENCY, createJob, htmlToPlainText, normalizeUrl, sha256Hex, unwrapBrowserRunPayload, type JobEnvelope } from "../../../packages/crawler-core/src/index.ts";
import type { SourceType } from "../../../packages/source-adapters/src/index.ts";
import { structuredLog, workerHealthResponse } from "../../../packages/observability/src/index.ts";

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
  acquisition: "browser";
}

interface Env {
  BROWSER: BrowserRun;
  RAW_CONTENT: R2Bucket;
  CRAWL_CACHE: KVNamespace;
  DOMAIN_DO: DurableObjectNamespace;
  BROWSER_POOL_DO: DurableObjectNamespace;
  PROCESS_CONTENT: Queue<JobEnvelope<ProcessPayload>>;
  ANALYTICS?: AnalyticsEngineDataset;
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

async function processMessage(message: Message<JobEnvelope<CrawlPayload>>, env: Env): Promise<void> {
  const job = message.body;
  const target = assertPublicHttpUrl(job.payload.url);
  const canonicalUrl = normalizeUrl(target.toString());
  const domain = target.hostname.toLowerCase();
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
  let domainStatus = 500;
  let domainRetryAfterMs = 2000;
  const started = Date.now();
  try {
    const domainLease = await doCall<{ granted: boolean; retryAfterMs?: number }>(domainStub, "/internal/acquire", {
      domain,
      maxConcurrency: 2,
      minDelayMs: 750
    });
    if (!domainLease.response.ok || !domainLease.data.granted) throw new Error(`domain_busy:${domainLease.data.retryAfterMs ?? 1000}`);
    domainAcquired = true;

    const browserResponse = await env.BROWSER.quickAction("content", {
      url: canonicalUrl,
      gotoOptions: { waitUntil: "networkidle2", timeout: 15_000 },
      rejectResourceTypes: ["image", "media", "font"],
      userAgent: "PulseWatchBot/0.1 (+public reputation monitoring; contact configured by operator)"
    });
    if (!browserResponse.ok) throw new Error(`browser_http_${browserResponse.status}`);
    const rawBody = await browserResponse.text();
    if (rawBody.length > 8 * 1024 * 1024) throw new Error("browser_body_too_large");
    const unwrapped = unwrapBrowserRunPayload(rawBody);
    const html = unwrapped.body;
    const extracted = htmlToPlainText(html);
    const pageTitle = unwrapped.title ?? extracted.title ?? job.payload.title ?? null;
    if (extracted.text.length < 100) throw new Error("browser_extraction_too_small");

    const urlHash = await sha256Hex(canonicalUrl);
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
      await releaseQuietly(domainStub, "/internal/release", { status: domainStatus, retryAfterMs: domainRetryAfterMs }, {
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

function retryDelayFromError(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : "";
  const match = message.match(/(?:browser_pool_busy|domain_busy):(\d+)/);
  return match ? Math.max(1, Math.ceil(Number(match[1]) / 1000)) : undefined;
}

export default {
  async fetch(): Promise<Response> {
    return workerHealthResponse("crawler-browser");
  },

  async queue(batch: MessageBatch<JobEnvelope<CrawlPayload>>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processMessage(message, env);
        message.ack();
      } catch (error) {
        structuredLog("error", "crawl_browser_failed", {
          requestId: message.body.traceId,
          tenantId: message.body.tenantId,
          monitorId: message.body.monitorId
        }, {
          jobId: message.body.jobId,
          url: message.body.payload.url,
          error: error instanceof Error ? error.message : "unknown"
        });
        const delaySeconds = retryDelayFromError(error);
        if (delaySeconds) message.retry({ delaySeconds });
        else message.retry();
      }
    }
  }
};
