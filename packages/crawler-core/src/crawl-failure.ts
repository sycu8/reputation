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
/** One wake invocation claims at most this many parked jobs, one at a time. */
export const WAKE_DRAIN_LIMIT = 32;

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
 * Browser Run account limits. Word boundaries are required: "generate limited" and
 * "Corporate Limited" contain "rate limited" but are not a rate limit.
 * "Too many requests" is the published Quick Actions 429 text. A response with status 429
 * is already re-sent. The same sentence thrown with no status line is the same limit,
 * so it is re-sent too. message.retry() would dead-letter it after three attempts.
 * rate_limited, ratelimited, and "rate limiting" are the same limit.
 * Permanent 4xx and fetch/upstream errors are not session congestion.
 */
const BROWSER_SESSION_CONGESTION = /\b(?:too many sessions|too many browsers|browser instance limit|unable to create new browser|too many requests|rate limit exceeded|rate_limited|ratelimited|rate limiting|rate[\s-]+limited)\b/i;

export function isBrowserSessionCongestion(message: string): boolean {
  if (isTerminalCrawlFailure(message)) return false;
  if (message.startsWith("upstream_")) return false;
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

/**
 * Domain, pool, and Browser Run session limits are our own congestion. They must not burn the per-URL failure cap.
 * A fetch error keeps the cap even when its text contains a rate-limit phrase.
 */
export function countsTowardUrlCap(message: string, worker?: "fetch" | "browser"): boolean {
  if (isTerminalCrawlFailure(message)) return false;
  if (message.startsWith("domain_busy:") || message.startsWith("browser_pool_busy:")) return false;
  if (worker === "fetch") return true;
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

function unitRandom(random: () => number): number {
  const roll = random();
  return Number.isFinite(roll) ? Math.min(1, Math.max(0, roll)) : 0;
}

/**
 * Delay before the same wake is sent again when the domain lease is still busy and nothing ran.
 * Bounded at 30s so the wake does not climb to 900s. Hops still increase, so twelve busy wakes
 * reach the hop cap. A wake that crawled something resets hops instead of using this delay.
 */
export function domainBusyWakeDelaySeconds(waitMs: number, hop: number, random: () => number = Math.random): number {
  const safeHop = Number.isFinite(hop) && hop > 0 ? Math.min(3, Math.floor(hop)) : 0;
  const step = Math.min(30, 5 * (2 ** safeHop));
  const hinted = Number.isFinite(waitMs) && waitMs > 0 ? Math.min(30, Math.ceil(waitMs / 1000)) : 0;
  const jitter = Math.floor(unitRandom(random) * 3);
  return Math.min(30, Math.max(1, Math.max(step, hinted) + jitter));
}

/**
 * Delay before the next batch when a wake already ran some jobs and more are parked.
 * This does not climb the hop backoff. The domain has a free slot.
 */
export function domainContinueDelaySeconds(waitMs: number, random: () => number = Math.random): number {
  const hinted = Number.isFinite(waitMs) && waitMs > 0 ? Math.ceil(waitMs / 1000) : 1;
  const jitter = Math.floor(unitRandom(random) * 3);
  return Math.min(30, Math.max(1, hinted + jitter));
}

export function crawlHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** One parked row per tenant, monitor (or job), and URL. The lane is applied by the domain coordinator. */
export function domainBusyParkKey(tenantId: string | undefined, url: string, identity?: string): string {
  const tenant = tenantId?.trim() ? tenantId.trim() : "_";
  const who = identity?.trim() ? identity.trim() : "_";
  return `${tenant}\u001f${who}\u001f${url}`;
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
  if (message === "hard_paywall_host") return { level: "info", event: "crawl_paywall_skipped" };
  if (message === "url_retry_cap") return { level: "info", event: "crawl_retry_capped" };
  const failed = worker === "fetch" ? "crawl_fetch_failed" : "crawl_browser_failed";
  const skipped = worker === "fetch" ? "crawl_fetch_skipped" : "crawl_browser_skipped";
  // Permanent acks win over the session phrase. A 4xx body that quotes "rate limited" is not session_busy.
  if (decision.action === "ack" || isTerminalCrawlFailure(message)) return { level: "warn", event: skipped };
  if (decision.action === "retry" && decision.delaySeconds != null && message.startsWith("upstream_backoff_429:")) {
    return { level: "warn", event: skipped };
  }
  if (worker === "browser" && isBrowserSessionCongestion(message)) return { level: "info", event: "crawl_browser_session_busy" };
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
  congestionWake: string | undefined;
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
    congestionWake: text("congestionWake"),
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
  hashUrl: (url: string) => Promise<string | null>,
  worker?: "fetch" | "browser"
): Promise<number> {
  if (!countsTowardUrlCap(errorMessage, worker)) return 0;
  const parsed = readCrawlQueueBody(body);
  if (!parsed || parsed.congestionWake) return 0;
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

export interface DomainParkResult {
  scheduleWake: boolean;
  delaySeconds: number;
  waiting: number;
  overflow: boolean;
  duplicate: boolean;
  fallback: boolean;
  token: string;
}

export interface ParkedDrainJob<Body> {
  body: Body;
  urlKey: string;
}

export interface CrawlQueueDeps<Body, MessageType extends CrawlQueueMessage<Body>> {
  worker: "fetch" | "browser";
  process(message: MessageType): Promise<void>;
  failureAction(errorMessage: string, attempts: number, urlFailures: number): CrawlFailureDecision;
  noteUrlFailure(body: Body, errorMessage: string): Promise<number>;
  rememberSkip(body: Body, errorMessage: string, ttlSeconds: number): Promise<void>;
  requeue(body: Body, delaySeconds: number, hops: number): Promise<void>;
  /**
   * Park a domain_busy job. Null, or fallback:true, keeps the per-message re-send.
   * The domain coordinator is the source of truth for whether a wake should be sent.
   */
  parkDomain?(input: {
    domain: string;
    urlKey: string;
    body: Body;
    delaySeconds: number;
    hops: number;
    tenantId: string | undefined;
    monitorId: string | undefined;
  }): Promise<DomainParkResult | null>;
  /** Move or clear the domain wake so a second queue send is not scheduled. delaySeconds 0 clears it. */
  noteWake?(domain: string, delaySeconds: number, hops: number): Promise<void>;
  /** Return parked jobs and delete them. Used when a wake hits the hop cap. */
  sweepDomain?(domain: string): Promise<Body[]>;
  /** Analytics Engine counter. A throw must not skip the ack. */
  count?(event: string): void;
  random?: () => number;
  log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void;
}

function recordCrawlCount<Body extends object, MessageType extends CrawlQueueMessage<Body>>(
  deps: CrawlQueueDeps<Body, MessageType>,
  event: string
): void {
  try {
    deps.count?.(event);
  } catch {
    /* a metric failure must not skip the ack */
  }
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
 * Run parked jobs for one domain wake, up to WAKE_DRAIN_LIMIT, one claim at a time.
 * A stale token returns without draining so a duplicate chain is acked.
 * Throws domain_busy when the lease is busy and nothing ran, or domain_wake when some jobs
 * ran and more are still parked. The queue handler turns those into one delayed wake.
 * The caller deletes a job only after run() resolves.
 */
export async function drainDomainWake<Body>(input: {
  take(): Promise<{ jobs: Array<ParkedDrainJob<Body>>; waiting: number; retryAfterMs: number; stale?: boolean }>;
  run(body: Body): Promise<void>;
  complete(urlKey: string): Promise<void>;
  releaseClaim(urlKey: string): Promise<void>;
  releaseWake(): Promise<{ waiting: number; retryAfterMs: number }>;
}): Promise<void> {
  let ran = 0;
  for (let slot = 0; slot < WAKE_DRAIN_LIMIT; slot += 1) {
    const taken = await input.take();
    if (taken.stale) return;
    if (taken.jobs.length === 0) {
      if (taken.waiting > 0 || taken.retryAfterMs > 0) {
        const wait = taken.retryAfterMs > 0 ? Math.ceil(taken.retryAfterMs) : 1000;
        throw new Error(ran > 0 ? `domain_wake:${wait}` : `domain_busy:${wait}`);
      }
      break;
    }
    for (const job of taken.jobs) {
      if (ran >= WAKE_DRAIN_LIMIT) break;
      try {
        await input.run(job.body);
        await input.complete(job.urlKey);
        ran += 1;
      } catch (error) {
        try {
          await input.releaseClaim(job.urlKey);
        } catch {
          /* the crawl error is the one the wake should reschedule on */
        }
        const message = error instanceof Error ? error.message : "unknown";
        if (ran > 0 && message.startsWith("domain_busy:")) {
          const wait = prefixedWaitMs(message, "domain_busy:");
          throw new Error(`domain_wake:${wait > 0 ? wait : 1000}`);
        }
        throw error;
      }
    }
  }
  const left = await input.releaseWake();
  if (left.waiting > 0) {
    const wait = left.retryAfterMs > 0 ? Math.ceil(left.retryAfterMs) : 1000;
    throw new Error(`domain_wake:${wait}`);
  }
}

function prefixedWaitMs(message: string, prefix: string): number {
  if (!message.startsWith(prefix)) return 0;
  const wait = Number(message.slice(prefix.length));
  return Number.isFinite(wait) && wait > 0 ? wait : 0;
}

function withoutCongestionWake<Body extends object>(body: Body): Body {
  if (!Object.prototype.hasOwnProperty.call(body, "congestionWake") && !Object.prototype.hasOwnProperty.call(body, "congestionWakeToken")) return body;
  const copy = { ...body } as Body & { congestionWake?: unknown; congestionWakeToken?: unknown };
  delete copy.congestionWake;
  delete copy.congestionWakeToken;
  return copy;
}

/** A wake carries the domain and token only. The carrier job's tenant is not charged or logged. */
function congestionWakeMessage<Body extends object>(domain: string, token: string, hops: number): Body {
  return {
    schemaVersion: 1,
    jobId: `wake:${domain}`,
    traceId: `wake:${domain}`,
    priority: "normal",
    createdAt: new Date().toISOString(),
    attempt: 0,
    congestionHops: hops,
    congestionWake: domain,
    congestionWakeToken: token,
    payload: { source: "web", url: `https://${domain}/`, discoveryKey: "wake" }
  } as Body;
}

/**
 * Ack successes. Park domain_busy into one wake per domain. Re-send other congestion per message.
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

async function rememberWake<Body extends object, MessageType extends CrawlQueueMessage<Body>>(
  deps: CrawlQueueDeps<Body, MessageType>,
  parsed: ParsedCrawlBody,
  attempts: number,
  domain: string,
  delaySeconds: number,
  hops: number
): Promise<void> {
  if (!deps.noteWake) return;
  try {
    await deps.noteWake(domain, delaySeconds, hops);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    deps.log("warn", "crawl_domain_wake_failed", failureFields(parsed, attempts, { domain, detail, hops }));
  }
}

async function sendRequeue<Body extends object, MessageType extends CrawlQueueMessage<Body>>(
  message: MessageType,
  deps: CrawlQueueDeps<Body, MessageType>,
  parsed: ParsedCrawlBody,
  errorMessage: string,
  body: Body,
  delaySeconds: number,
  hops: number
): Promise<boolean> {
  try {
    await deps.requeue(body, delaySeconds, hops);
    return true;
  } catch (requeueError) {
    const detail = requeueError instanceof Error ? requeueError.message : "unknown";
    deps.log("warn", "crawl_congestion_requeue_failed", failureFields(parsed, message.attempts, { error: errorMessage, detail, hops }));
    message.retry({ delaySeconds });
    return false;
  }
}

async function parkDomainBusy<Body extends object, MessageType extends CrawlQueueMessage<Body>>(
  message: MessageType,
  deps: CrawlQueueDeps<Body, MessageType>,
  parsed: ParsedCrawlBody,
  errorMessage: string,
  domain: string,
  delaySeconds: number,
  nextHops: number,
  urlFailures: number
): Promise<boolean> {
  if (!deps.parkDomain) return false;
  let parked: DomainParkResult | null;
  try {
    parked = await deps.parkDomain({
      domain,
      urlKey: domainBusyParkKey(parsed.tenantId, parsed.url, parsed.monitorId || parsed.jobId),
      body: withoutCongestionWake(message.body),
      delaySeconds,
      hops: nextHops,
      tenantId: parsed.tenantId,
      monitorId: parsed.monitorId
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    deps.log("warn", "crawl_domain_park_failed", failureFields(parsed, message.attempts, { error: errorMessage, detail, domain }));
    return false;
  }
  if (!parked) return false;
  if (parked.duplicate) {
    deps.log("info", "crawl_domain_park_duplicate", failureFields(parsed, message.attempts, {
      error: errorMessage,
      domain,
      waiting: parked.waiting
    }));
  } else if (parked.overflow) {
    deps.log("warn", "crawl_domain_park_full", failureFields(parsed, message.attempts, {
      error: errorMessage,
      domain,
      waiting: parked.waiting
    }));
  } else if (!parked.fallback) {
    deps.log("info", "crawl_domain_busy", failureFields(parsed, message.attempts, {
      error: errorMessage,
      domain,
      urlFailures,
      waiting: parked.waiting,
      scheduled: parked.scheduleWake,
      hops: nextHops,
      delaySeconds: parked.delaySeconds
    }));
  }
  if (parked.scheduleWake && parked.token) {
    const sent = await sendRequeue(
      message,
      deps,
      parsed,
      errorMessage,
      congestionWakeMessage(domain, parked.token, nextHops),
      parked.delaySeconds,
      nextHops
    );
    if (!sent) await rememberWake(deps, parsed, message.attempts, domain, 0, nextHops);
  }
  if (parked.fallback || parked.overflow) return false;
  message.ack();
  return true;
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

  if (errorMessage.startsWith("domain_wake:")) {
    const domain = parsed.congestionWake;
    if (!domain) {
      deps.log("warn", "crawl_domain_wake_ignored", failureFields(parsed, message.attempts, { error: errorMessage }));
      message.ack();
      return;
    }
    const random = deps.random ?? Math.random;
    const delaySeconds = domainContinueDelaySeconds(prefixedWaitMs(errorMessage, "domain_wake:"), random);
    await rememberWake(deps, parsed, message.attempts, domain, delaySeconds, 0);
    deps.log("info", "crawl_domain_wake", failureFields(parsed, message.attempts, { domain, hops: 0, delaySeconds }));
    const sent = await sendRequeue(message, deps, parsed, errorMessage, message.body, delaySeconds, 0);
    if (sent) message.ack();
    return;
  }

  let urlFailures = 0;
  if (!parsed.congestionWake && countsTowardUrlCap(errorMessage, deps.worker)) {
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
      deps.log("warn", "crawl_congestion_cap", failureFields(parsed, message.attempts, {
        error: errorMessage,
        hops: parsed.hops,
        domain: parsed.congestionWake
      }));
      recordCrawlCount(deps, "crawl_congestion_cap");
      if (parsed.congestionWake) {
        let swept: Body[] = [];
        if (deps.sweepDomain) {
          try {
            swept = await deps.sweepDomain(parsed.congestionWake);
          } catch (error) {
            const detail = error instanceof Error ? error.message : "unknown";
            deps.log("warn", "crawl_domain_park_sweep_failed", failureFields(parsed, message.attempts, {
              domain: parsed.congestionWake,
              detail
            }));
          }
        } else {
          await rememberWake(deps, parsed, message.attempts, parsed.congestionWake, 0, parsed.hops);
        }
        for (const job of swept) {
          const jobParsed = readCrawlQueueBody(job);
          deps.log("warn", "crawl_domain_park_expired", failureFields(jobParsed, message.attempts, {
            domain: parsed.congestionWake,
            error: errorMessage
          }));
          if (!jobParsed) continue;
          await sendRequeue(message, deps, jobParsed, errorMessage, withoutCongestionWake(job), BUSY_REQUEUE_CAP_SECONDS, 0);
        }
      }
      message.ack();
      return;
    }
    const random = deps.random ?? Math.random;
    if (parsed.congestionWake && errorMessage.startsWith("domain_busy:")) {
      const delaySeconds = domainBusyWakeDelaySeconds(decision.waitMs, parsed.hops, random);
      await rememberWake(deps, parsed, message.attempts, parsed.congestionWake, delaySeconds, nextHops);
      deps.log("info", "crawl_domain_wake", failureFields(parsed, message.attempts, {
        domain: parsed.congestionWake,
        error: errorMessage,
        hops: nextHops,
        delaySeconds
      }));
      const sent = await sendRequeue(message, deps, parsed, errorMessage, message.body, delaySeconds, nextHops);
      if (sent) message.ack();
      return;
    }
    const delaySeconds = congestionBackoffDelaySeconds(decision.waitMs, parsed.hops);
    if (errorMessage.startsWith("domain_busy:") && deps.parkDomain) {
      const domain = crawlHostname(parsed.url);
      if (domain) {
        const parked = await parkDomainBusy(message, deps, parsed, errorMessage, domain, delaySeconds, nextHops, urlFailures);
        if (parked) return;
      }
    }
    const logged = crawlFailureLog(deps.worker, errorMessage, decision);
    deps.log(logged.level, logged.event, failureFields(parsed, message.attempts, { error: errorMessage, urlFailures, hops: nextHops, delaySeconds }));
    const sent = await sendRequeue(message, deps, parsed, errorMessage, message.body, delaySeconds, nextHops);
    if (sent) message.ack();
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
