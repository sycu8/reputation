import {
  busyRequeueDelaySeconds,
  crawlAttemptKey,
  nextUrlFailureCount,
  URL_RETRY_WINDOW_SECONDS
} from "./index.ts";

export type UpstreamAction = "permanent" | "browser" | "backoff" | "retry";

export const PERMANENT_SKIP_TTL_SECONDS = 24 * 60 * 60;
export const EXTRACTION_SKIP_TTL_SECONDS = 6 * 60 * 60;

export interface CrawlFailureContext {
  /** Queue delivery count for this message. Starts at 1. Does not stop a transient retry. */
  attempts?: number;
  /** Real failures for this tenant and URL. Does not stop a transient retry. */
  urlFailures?: number;
  random?: () => number;
}

export type CrawlFailureDecision = { action: "ack" } | { action: "retry"; delaySeconds?: number };

/**
 * Cloudflare applies `max_retries` when a delivery fails or `retryAll()` runs.
 * Per-message `message.retry()`, including `retry({ delaySeconds })`, does not
 * spend that budget, so the same message stays on the queue until retention
 * (4 days by default) deletes it. Crawl transients must be flushed with `retryAll()`.
 */
export interface PlatformRetryBatch {
  /** null: nothing to retry. 0: retry with no delay. Positive: longest delay in the batch. */
  delaySeconds: number | null;
}

export function createPlatformRetryBatch(): PlatformRetryBatch {
  return { delaySeconds: null };
}

export function notePlatformRetry(batch: PlatformRetryBatch, decision: CrawlFailureDecision): void {
  if (decision.action !== "retry") return;
  const delay = decision.delaySeconds ?? 0;
  batch.delaySeconds = batch.delaySeconds == null ? delay : Math.max(batch.delaySeconds, delay);
}

export type PlatformRetryFlush =
  | { action: "none" }
  | { action: "retryAll"; delaySeconds?: number };

export function flushPlatformRetries(batch: PlatformRetryBatch): PlatformRetryFlush {
  if (batch.delaySeconds == null) return { action: "none" };
  if (batch.delaySeconds > 0) return { action: "retryAll", delaySeconds: batch.delaySeconds };
  return { action: "retryAll" };
}

export interface CrawlAttemptCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<unknown>;
}

/**
 * Permanent client errors are acked.
 * 403/419 are bot or CSRF blocks and go to the browser crawler.
 * 429 backs off per domain. 408/425 and 5xx (including 520) stay retryable.
 */
export function classifyUpstreamStatus(status: number): UpstreamAction {
  if (status === 403 || status === 419) return "browser";
  if (status === 429) return "backoff";
  if (status === 408 || status === 425) return "retry";
  if (status >= 400 && status < 500) return "permanent";
  return "retry";
}

function permanentHttpStatus(status: number): boolean {
  if (status === 408 || status === 425 || status === 429) return false;
  return status >= 400 && status < 500;
}

export function isTerminalCrawlFailure(message: string): boolean {
  if (
    message === "ssrf_blocked_host"
    || message === "unsupported_protocol"
    || message === "unsupported_content_type"
    || message === "body_too_large"
    || message === "too_many_redirects"
    || message === "redirect_without_location"
    || message === "hard_paywall_host"
    || message === "url_retry_cap"
    || message === "browser_extraction_too_small"
    || message === "browser_body_too_large"
    || message.startsWith("upstream_http_permanent:")
  ) {
    return true;
  }
  const upstream = message.match(/^upstream_http_(\d+)$/);
  if (upstream?.[1] && classifyUpstreamStatus(Number(upstream[1])) === "permanent") return true;
  const browser = message.match(/^browser_http_(\d+)$/);
  if (browser?.[1] && permanentHttpStatus(Number(browser[1]))) return true;
  return false;
}

/** Remember permanent outcomes so the next discovery message does not fetch again. */
export function crawlSkipTtlSeconds(message: string): number | null {
  if (message === "browser_extraction_too_small") return EXTRACTION_SKIP_TTL_SECONDS;
  if (
    message === "browser_body_too_large"
    || message === "body_too_large"
    || message === "unsupported_content_type"
    || message.startsWith("upstream_http_permanent:")
  ) {
    return PERMANENT_SKIP_TTL_SECONDS;
  }
  const browser = message.match(/^browser_http_(\d+)$/);
  if (browser?.[1] && permanentHttpStatus(Number(browser[1]))) return PERMANENT_SKIP_TTL_SECONDS;
  const upstream = message.match(/^upstream_http_(\d+)$/);
  if (upstream?.[1] && classifyUpstreamStatus(Number(upstream[1])) === "permanent") return PERMANENT_SKIP_TTL_SECONDS;
  return null;
}

/** Domain and pool delays are our own congestion. They must not burn the per-URL failure cap. */
export function countsTowardUrlCap(message: string): boolean {
  if (isTerminalCrawlFailure(message)) return false;
  if (message.startsWith("domain_busy:") || message.startsWith("browser_pool_busy:")) return false;
  return true;
}

function congestionDecision(waitMs: number, input: CrawlFailureContext): CrawlFailureDecision {
  return { action: "retry", delaySeconds: busyRequeueDelaySeconds(waitMs, input.random ?? Math.random) };
}

export function fetchFailureAction(message: string, input: CrawlFailureContext = {}): CrawlFailureDecision {
  if (isTerminalCrawlFailure(message)) return { action: "ack" };
  const backoff = message.match(/^(?:upstream_backoff_429|domain_busy):(\d+(?:\.\d+)?)$/);
  if (backoff?.[1]) {
    if (message.startsWith("domain_busy:")) return congestionDecision(Number(backoff[1]), input);
    const seconds = Math.max(1, Math.min(900, Math.ceil(Number(backoff[1]) / 1000)));
    return { action: "retry", delaySeconds: seconds };
  }
  return { action: "retry" };
}

export function browserFailureAction(message: string, input: CrawlFailureContext = {}): CrawlFailureDecision {
  if (isTerminalCrawlFailure(message)) return { action: "ack" };
  const busy = message.match(/^(?:browser_pool_busy|domain_busy):(\d+(?:\.\d+)?)$/);
  if (busy?.[1]) return congestionDecision(Number(busy[1]), input);
  const http = message.match(/^browser_http_(\d+)$/);
  if (http?.[1] && Number(http[1]) === 429) return congestionDecision(30_000, input);
  return { action: "retry", delaySeconds: busyRequeueDelaySeconds(0, input.random ?? Math.random) };
}

export function crawlFailureLog(worker: "fetch" | "browser", message: string, decision: CrawlFailureDecision): { level: "info" | "warn" | "error"; event: string } {
  if (message.startsWith("domain_busy:")) return { level: "info", event: "crawl_domain_busy" };
  if (message.startsWith("browser_pool_busy:")) return { level: "info", event: "crawl_browser_pool_busy" };
  if (message === "hard_paywall_host") return { level: "info", event: "crawl_paywall_skipped" };
  if (message === "url_retry_cap") return { level: "info", event: "crawl_retry_capped" };
  const failed = worker === "fetch" ? "crawl_fetch_failed" : "crawl_browser_failed";
  const skipped = worker === "fetch" ? "crawl_fetch_skipped" : "crawl_browser_skipped";
  if (decision.action === "ack") return { level: "warn", event: skipped };
  if (decision.action === "retry" && decision.delaySeconds != null && message.startsWith("upstream_backoff_429:")) {
    return { level: "warn", event: skipped };
  }
  return { level: "error", event: failed };
}

export async function noteUrlFailure(cache: CrawlAttemptCache, tenantId: string | undefined, urlHash: string): Promise<number> {
  const key = crawlAttemptKey(tenantId, urlHash);
  const raw = await cache.get(key);
  const current = Number(raw ?? "0");
  const next = nextUrlFailureCount(Number.isFinite(current) ? current : 0);
  await cache.put(key, String(next), { expirationTtl: URL_RETRY_WINDOW_SECONDS });
  return next;
}
