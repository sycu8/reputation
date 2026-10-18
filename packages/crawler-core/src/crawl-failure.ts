import {
  busyRequeueDelaySeconds,
  crawlAttemptKey,
  messageRetryCapReached,
  nextUrlFailureCount,
  URL_RETRY_CAP,
  URL_RETRY_WINDOW_SECONDS,
  urlRetryCapReached
} from "./index.ts";

export type UpstreamAction = "permanent" | "browser" | "backoff" | "retry";

/** Static crawl: 3 retries after the first delivery (QUEUE_CONTRACTS). */
export const STATIC_CRAWL_MAX_RETRIES = 3;
/** Browser crawl: 2 retries after the first delivery. */
export const BROWSER_CRAWL_MAX_RETRIES = 2;
export const PERMANENT_SKIP_TTL_SECONDS = 24 * 60 * 60;
export const EXTRACTION_SKIP_TTL_SECONDS = 6 * 60 * 60;

export interface CrawlFailureContext {
  /** Queue delivery count for this message. Starts at 1. */
  attempts?: number;
  /** Failures already recorded for this normalized URL, including this one when already incremented. */
  urlFailures?: number;
  random?: () => number;
}

export type CrawlFailureDecision = { action: "ack" } | { action: "retry"; delaySeconds?: number };

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

function congestionDecision(waitMs: number, input: CrawlFailureContext, maxRetries: number): CrawlFailureDecision {
  const attempts = input.attempts ?? 1;
  const urlFailures = input.urlFailures ?? 0;
  // Ack at the queue retry budget so congestion is not dead-lettered, and stop a misconfigured max_retries from looping.
  if (messageRetryCapReached(attempts, maxRetries) || attempts >= URL_RETRY_CAP || urlRetryCapReached(urlFailures)) return { action: "ack" };
  return { action: "retry", delaySeconds: busyRequeueDelaySeconds(waitMs, input.random ?? Math.random) };
}

export function fetchFailureAction(message: string, input: CrawlFailureContext = {}): CrawlFailureDecision {
  if (isTerminalCrawlFailure(message)) return { action: "ack" };
  const attempts = input.attempts ?? 1;
  const urlFailures = input.urlFailures ?? 0;
  const backoff = message.match(/^(?:upstream_backoff_429|domain_busy):(\d+(?:\.\d+)?)$/);
  if (backoff?.[1]) {
    if (message.startsWith("domain_busy:")) return congestionDecision(Number(backoff[1]), input, STATIC_CRAWL_MAX_RETRIES);
    if (messageRetryCapReached(attempts, STATIC_CRAWL_MAX_RETRIES) || urlRetryCapReached(urlFailures)) return { action: "ack" };
    const seconds = Math.max(1, Math.min(900, Math.ceil(Number(backoff[1]) / 1000)));
    return { action: "retry", delaySeconds: seconds };
  }
  if (messageRetryCapReached(attempts, STATIC_CRAWL_MAX_RETRIES) || urlRetryCapReached(urlFailures)) return { action: "ack" };
  return { action: "retry" };
}

export function browserFailureAction(message: string, input: CrawlFailureContext = {}): CrawlFailureDecision {
  if (isTerminalCrawlFailure(message)) return { action: "ack" };
  const attempts = input.attempts ?? 1;
  const urlFailures = input.urlFailures ?? 0;
  const busy = message.match(/^(?:browser_pool_busy|domain_busy):(\d+(?:\.\d+)?)$/);
  if (busy?.[1]) return congestionDecision(Number(busy[1]), input, BROWSER_CRAWL_MAX_RETRIES);
  const http = message.match(/^browser_http_(\d+)$/);
  if (http?.[1] && Number(http[1]) === 429) return congestionDecision(30_000, input, BROWSER_CRAWL_MAX_RETRIES);
  if (messageRetryCapReached(attempts, BROWSER_CRAWL_MAX_RETRIES) || urlRetryCapReached(urlFailures)) return { action: "ack" };
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

export async function noteUrlFailure(cache: CrawlAttemptCache, urlHash: string): Promise<number> {
  const raw = await cache.get(crawlAttemptKey(urlHash));
  const current = Number(raw ?? "0");
  const next = nextUrlFailureCount(Number.isFinite(current) ? current : 0);
  await cache.put(crawlAttemptKey(urlHash), String(next), { expirationTtl: URL_RETRY_WINDOW_SECONDS });
  return next;
}
