import {
  BUSY_REQUEUE_CAP_SECONDS,
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

export type CrawlFailureDecision =
  | { action: "ack" }
  | { action: "retry"; delaySeconds?: number }
  | { action: "requeue"; waitMs: number };

/**
 * Twelve re-sends. Hop 0 waits 30s, then the delay doubles until 900s:
 * 30, 60, 120, 240, 480, then 900. That sequence is 7,230 seconds, about 2 hours.
 */
export const CONGESTION_HOP_CAP = 12;
export const CONGESTION_BACKOFF_BASE_SECONDS = 30;

/** Crawler consumers set max_retries to this. message.retry() spends it; attempt 4 is the last delivery. */
export const CRAWL_QUEUE_MAX_RETRIES = 3;

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
  const browser = message.match(/^browser_http_(\d+)(?:$|:)/);
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
  const browser = message.match(/^browser_http_(\d+)(?:$|:)/);
  if (browser?.[1] && permanentHttpStatus(Number(browser[1]))) return PERMANENT_SKIP_TTL_SECONDS;
  const upstream = message.match(/^upstream_http_(\d+)$/);
  if (upstream?.[1] && classifyUpstreamStatus(Number(upstream[1])) === "permanent") return PERMANENT_SKIP_TTL_SECONDS;
  return null;
}

/**
 * Browser Run signals that the account is out of sessions or over its request rate.
 * quickAction returns HTTP 429. The binding can also throw these phrases before a status line.
 */
const BROWSER_SESSION_CONGESTION = /too many sessions|too many browsers|browser instance limit|unable to create new browser/i;

export function isBrowserSessionCongestion(message: string): boolean {
  if (/^browser_http_429(?:$|:)/.test(message)) return true;
  return BROWSER_SESSION_CONGESTION.test(message);
}

/** Retry-After hint carried on `browser_http_<status>:<waitMs>` or `browser_http_<status>:<waitMs>:<detail>`. */
export function browserSessionWaitMs(message: string): number {
  const hinted = message.match(/^browser_http_\d+:(\d+)(?:$|:)/);
  if (!hinted?.[1]) return 0;
  const wait = Number(hinted[1]);
  return Number.isFinite(wait) && wait > 0 ? wait : 0;
}

function retryAfterHeaderMs(header: string | null, now: number): number {
  if (!header) return 0;
  const trimmed = header.trim();
  if (!trimmed) return 0;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.max(0, Math.round(Number(trimmed) * 1000));
  const date = Date.parse(trimmed);
  if (!Number.isFinite(date)) return 0;
  return Math.max(0, date - now);
}

function browserRunErrorDetail(bodyText: string): string {
  const sliced = bodyText.slice(0, 800);
  try {
    const parsed = JSON.parse(sliced) as { errors?: Array<{ message?: unknown }> };
    const messages = (parsed.errors ?? [])
      .map((item) => typeof item?.message === "string" ? item.message.trim() : "")
      .filter((item) => item.length > 0);
    if (messages.length > 0) return messages.join("; ").replace(/\s+/g, " ").slice(0, 240);
  } catch {
    /* use the raw body below */
  }
  return sliced.replace(/\s+/g, " ").trim().slice(0, 240);
}

/** Status plus Retry-After and the Browser Run error text, so session limits can be classified. */
export function browserRunFailureMessage(status: number, retryAfterHeader: string | null, bodyText: string, now = Date.now()): string {
  const waitMs = retryAfterHeaderMs(retryAfterHeader, now);
  const detail = browserRunErrorDetail(bodyText);
  const prefix = `browser_http_${status}:${waitMs}`;
  return detail ? `${prefix}:${detail}` : prefix;
}

/** Domain, pool, and Browser Run session limits are our own congestion. They must not burn the per-URL failure cap. */
export function countsTowardUrlCap(message: string): boolean {
  if (isTerminalCrawlFailure(message)) return false;
  if (message.startsWith("domain_busy:") || message.startsWith("browser_pool_busy:")) return false;
  if (isBrowserSessionCongestion(message)) return false;
  return true;
}

function congestionDelay(waitMs: number, input: CrawlFailureContext): number {
  return busyRequeueDelaySeconds(waitMs, input.random ?? Math.random);
}

/**
 * Delay for one congestion re-send. `hop` is how many re-sends have already happened.
 * max(coordinator hint, 30s × 2^hop), capped at 900s.
 */
export function congestionBackoffDelaySeconds(waitMs: number, hop: number): number {
  const safeHop = Number.isFinite(hop) && hop > 0 ? Math.min(20, Math.floor(hop)) : 0;
  const exponential = CONGESTION_BACKOFF_BASE_SECONDS * (2 ** safeHop);
  const hinted = Number.isFinite(waitMs) && waitMs > 0 ? Math.ceil(waitMs / 1000) : 0;
  const raw = Math.max(exponential, hinted);
  if (!Number.isFinite(raw)) return BUSY_REQUEUE_CAP_SECONDS;
  return Math.min(BUSY_REQUEUE_CAP_SECONDS, Math.max(1, raw));
}

/** Domain and pool congestion is re-sent as a new message. It must not use the queue DLQ budget. */
function congestionDecision(waitMs: number): CrawlFailureDecision {
  const hint = Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 0;
  return { action: "requeue", waitMs: hint };
}

export function fetchFailureAction(message: string, input: CrawlFailureContext = {}): CrawlFailureDecision {
  if (isTerminalCrawlFailure(message)) return { action: "ack" };
  const backoff = message.match(/^(?:upstream_backoff_429|domain_busy):(\d+(?:\.\d+)?)$/);
  if (backoff?.[1]) {
    if (message.startsWith("domain_busy:")) return congestionDecision(Number(backoff[1]));
    const seconds = Math.max(1, Math.min(900, Math.ceil(Number(backoff[1]) / 1000)));
    return { action: "retry", delaySeconds: seconds };
  }
  return { action: "retry" };
}

export function browserFailureAction(message: string, input: CrawlFailureContext = {}): CrawlFailureDecision {
  if (isTerminalCrawlFailure(message)) return { action: "ack" };
  const busy = message.match(/^(?:browser_pool_busy|domain_busy):(\d+(?:\.\d+)?)$/);
  if (busy?.[1]) return congestionDecision(Number(busy[1]));
  if (isBrowserSessionCongestion(message)) return congestionDecision(browserSessionWaitMs(message));
  return { action: "retry", delaySeconds: congestionDelay(0, input) };
}

export function crawlFailureLog(worker: "fetch" | "browser", message: string, decision: CrawlFailureDecision): { level: "info" | "warn" | "error"; event: string } {
  if (message.startsWith("domain_busy:")) return { level: "info", event: "crawl_domain_busy" };
  if (message.startsWith("browser_pool_busy:")) return { level: "info", event: "crawl_browser_pool_busy" };
  if (isBrowserSessionCongestion(message)) return { level: "info", event: "crawl_browser_session_busy" };
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

export interface ParsedCrawlBody {
  url: string;
  hops: number;
  jobId: string | undefined;
  traceId: string | undefined;
  tenantId: string | undefined;
  monitorId: string | undefined;
}

export function readCrawlQueueBody(body: unknown): ParsedCrawlBody | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const payload = record.payload;
  if (!payload || typeof payload !== "object") return null;
  const url = (payload as Record<string, unknown>).url;
  if (typeof url !== "string" || url.length === 0) return null;
  const hopsRaw = record.congestionHops;
  const hops = typeof hopsRaw === "number" && Number.isFinite(hopsRaw) && hopsRaw > 0 ? Math.floor(hopsRaw) : 0;
  const text = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  return {
    url,
    hops,
    jobId: text("jobId"),
    traceId: text("traceId"),
    tenantId: text("tenantId"),
    monitorId: text("monitorId")
  };
}

export async function noteQueuedUrlFailure(
  cache: CrawlAttemptCache,
  body: unknown,
  errorMessage: string,
  hashUrl: (url: string) => Promise<string | null>
): Promise<number> {
  if (!countsTowardUrlCap(errorMessage)) return 0;
  const parsed = readCrawlQueueBody(body);
  if (!parsed) return 0;
  const urlHash = await hashUrl(parsed.url);
  if (!urlHash) return 0;
  return noteUrlFailure(cache, parsed.tenantId, urlHash);
}

export async function rememberQueuedSkip(
  cache: CrawlAttemptCache,
  body: unknown,
  errorMessage: string,
  ttlSeconds: number,
  hashUrl: (url: string) => Promise<string | null>
): Promise<void> {
  const parsed = readCrawlQueueBody(body);
  if (!parsed) return;
  const urlHash = await hashUrl(parsed.url);
  if (!urlHash) return;
  await cache.put(`crawl:${urlHash}`, JSON.stringify({ skip: errorMessage }), { expirationTtl: ttlSeconds });
}

export function clampQueueDelaySeconds(delaySeconds: number): number {
  const rounded = Math.ceil(delaySeconds);
  if (!Number.isFinite(rounded) || rounded < 1) return 1;
  return Math.min(BUSY_REQUEUE_CAP_SECONDS, rounded);
}

export interface CrawlQueueMessage<Body> {
  readonly attempts: number;
  readonly body: Body;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface CrawlQueueDeps<Body, MessageType extends CrawlQueueMessage<Body>> {
  worker: "fetch" | "browser";
  process(message: MessageType): Promise<void>;
  failureAction(errorMessage: string, attempts: number, urlFailures: number): CrawlFailureDecision;
  noteUrlFailure(body: Body, errorMessage: string): Promise<number>;
  rememberSkip(body: Body, errorMessage: string, ttlSeconds: number): Promise<void>;
  requeue(body: Body, delaySeconds: number, hops: number): Promise<void>;
  log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void;
}

function failureFields(parsed: ParsedCrawlBody | null, attempts: number, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    requestId: parsed?.traceId ?? "",
    tenantId: parsed?.tenantId,
    monitorId: parsed?.monitorId,
    jobId: parsed?.jobId,
    url: parsed?.url,
    attempts,
    ...extra
  };
}

/**
 * Ack successes. Re-send domain/pool congestion with a hop counter, then ack the original.
 * Real transients call message.retry() so the queue max_retries can dead-letter them.
 * A malformed body is acked. This function does not throw.
 */
export async function handleCrawlQueueBatch<Body extends object, MessageType extends CrawlQueueMessage<Body>>(
  messages: readonly MessageType[],
  deps: CrawlQueueDeps<Body, MessageType>
): Promise<void> {
  for (const message of messages) {
    try {
      await deps.process(message);
      message.ack();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "unknown";
      try {
        await settleCrawlFailure(message, errorMessage, deps);
      } catch (settleError) {
        const detail = settleError instanceof Error ? settleError.message : "unknown";
        deps.log("warn", "crawl_malformed_message", failureFields(null, message.attempts, { error: errorMessage, detail }));
        message.ack();
      }
    }
  }
}

async function settleCrawlFailure<Body extends object, MessageType extends CrawlQueueMessage<Body>>(
  message: MessageType,
  errorMessage: string,
  deps: CrawlQueueDeps<Body, MessageType>
): Promise<void> {
  const parsed = readCrawlQueueBody(message.body);
  if (!parsed) {
    deps.log("warn", "crawl_malformed_message", failureFields(null, message.attempts, { error: errorMessage }));
    message.ack();
    return;
  }

  let urlFailures = 0;
  if (countsTowardUrlCap(errorMessage)) {
    try {
      urlFailures = await deps.noteUrlFailure(message.body, errorMessage);
    } catch {
      urlFailures = 0;
    }
  }

  const decision = deps.failureAction(errorMessage, message.attempts, urlFailures);
  if (decision.action === "requeue") {
    const nextHops = parsed.hops + 1;
    if (nextHops > CONGESTION_HOP_CAP) {
      deps.log("info", "crawl_congestion_cap", failureFields(parsed, message.attempts, {
        error: errorMessage,
        hops: parsed.hops
      }));
      message.ack();
      return;
    }
    const delaySeconds = congestionBackoffDelaySeconds(decision.waitMs, parsed.hops);
    const logged = crawlFailureLog(deps.worker, errorMessage, decision);
    deps.log(logged.level, logged.event, failureFields(parsed, message.attempts, { error: errorMessage, urlFailures, hops: nextHops, delaySeconds }));
    try {
      await deps.requeue(message.body, delaySeconds, nextHops);
    } catch (requeueError) {
      const detail = requeueError instanceof Error ? requeueError.message : "unknown";
      deps.log("warn", "crawl_congestion_requeue_failed", failureFields(parsed, message.attempts, { error: errorMessage, detail, hops: nextHops }));
      message.retry({ delaySeconds });
      return;
    }
    message.ack();
    return;
  }

  const logged = crawlFailureLog(deps.worker, errorMessage, decision);
  deps.log(logged.level, logged.event, failureFields(parsed, message.attempts, { error: errorMessage, urlFailures }));
  if (decision.action === "ack") {
    const ttl = crawlSkipTtlSeconds(errorMessage);
    if (ttl) {
      try {
        await deps.rememberSkip(message.body, errorMessage, ttl);
      } catch {
        /* ack even if the skip marker cannot be stored */
      }
    }
    message.ack();
    return;
  }
  if (decision.delaySeconds != null && decision.delaySeconds > 0) message.retry({ delaySeconds: clampQueueDelaySeconds(decision.delaySeconds) });
  else message.retry();
}
