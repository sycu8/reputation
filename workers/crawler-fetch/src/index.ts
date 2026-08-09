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
  acquisition: "fetch" | "cache";
}

interface Env {
  RAW_CONTENT: R2Bucket;
  CRAWL_CACHE: KVNamespace;
  CRAWL_BROWSER: Queue<JobEnvelope<CrawlPayload>>;
  PROCESS_CONTENT: Queue<JobEnvelope<ProcessPayload>>;
  ANALYTICS?: AnalyticsEngineDataset;
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

async function safeFetch(input: string): Promise<{ response: Response; finalUrl: string }> {
  let current = assertPublicHttpUrl(input).toString();
  for (let redirect = 0; redirect <= 5; redirect += 1) {
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

async function processMessage(message: Message<JobEnvelope<CrawlPayload>>, env: Env): Promise<void> {
  const job = message.body;
  const payload = job.payload;
  const normalized = normalizeUrl(assertPublicHttpUrl(payload.url).toString());
  const urlHash = await sha256Hex(normalized);
  const cacheKey = `crawl:${urlHash}`;
  const cached = await env.CRAWL_CACHE.get(cacheKey);
  if (cached) {
    const record = JSON.parse(cached) as { contentId: string; rawR2Key: string; fetchedAt: string; canonicalUrl: string };
    await env.PROCESS_CONTENT.send(createJob<ProcessPayload>({
      ...record,
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

  const { response, finalUrl } = await safeFetch(normalized);
  if (!response.ok) throw new Error(`upstream_http_${response.status}`);
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

export default {
  async fetch(): Promise<Response> {
    return workerHealthResponse("crawler-fetch");
  },

  async queue(batch: MessageBatch<JobEnvelope<CrawlPayload>>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processMessage(message, env);
        message.ack();
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "unknown";
        structuredLog("error", "crawl_fetch_failed", {
          requestId: message.body.traceId,
          tenantId: message.body.tenantId,
          monitorId: message.body.monitorId
        }, { jobId: message.body.jobId, url: message.body.payload.url, error: messageText });
        if (messageText === "ssrf_blocked_host" || messageText === "unsupported_protocol" || messageText === "unsupported_content_type") message.ack();
        else message.retry();
      }
    }
  }
};
