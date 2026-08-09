import { assertPublicHttpUrl, createJob, normalizeUrl, sha256Hex, type JobEnvelope } from "../../../packages/crawler-core/src/index.ts";
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

function stripHtml(html: string): { title: string | null; text: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? null;
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
  return { title, text };
}

async function processMessage(message: Message<JobEnvelope<CrawlPayload>>, env: Env): Promise<void> {
  const job = message.body;
  const target = assertPublicHttpUrl(job.payload.url);
  const canonicalUrl = normalizeUrl(target.toString());
  const domain = target.hostname.toLowerCase();
  const domainStub = env.DOMAIN_DO.get(env.DOMAIN_DO.idFromName(domain));
  const poolStub = env.BROWSER_POOL_DO.get(env.BROWSER_POOL_DO.idFromName("global"));

  const poolLease = await doCall<{ granted: boolean; retryAfterMs?: number }>(poolStub, "/internal/acquire", { maxActive: 100, priority: job.priority });
  if (!poolLease.response.ok || !poolLease.data.granted) throw new Error(`browser_pool_busy:${poolLease.data.retryAfterMs ?? 1000}`);
  let domainAcquired = false;
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
    const html = await browserResponse.text();
    if (html.length > 8 * 1024 * 1024) throw new Error("browser_body_too_large");
    const extracted = stripHtml(html);
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
      title: extracted.title ?? job.payload.title ?? null,
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
      discoveryTitle: job.payload.title,
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
    if (domainAcquired) await doCall(domainStub, "/internal/release", { status: 200, retryAfterMs: 0 });
    domainAcquired = false;
  } finally {
    if (domainAcquired) await doCall(domainStub, "/internal/release", { status: 500, retryAfterMs: 2000 });
    await doCall(poolStub, "/internal/release", {});
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
