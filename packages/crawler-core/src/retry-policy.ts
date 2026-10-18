/**
 * Queue retry policy for crawl failures.
 * Domain-coordinator hints stay in milliseconds; this module decides the queue delay.
 * Attempt state lives in KV (`crawl-guard:*`), not in Durable Object storage.
 */

export const DOMAIN_BUSY_COOLDOWN_MIN_SECONDS = 30;
/** Inclusive span above the minimum, so the cooldown is 30–60 seconds before jitter. */
export const DOMAIN_BUSY_COOLDOWN_SPAN_SECONDS = 30;
/** Extra seconds added on top of the 30–60s cooldown when the coordinator hint is shorter. */
export const DOMAIN_BUSY_JITTER_SECONDS = 15;
export const QUEUE_DELAY_MAX_SECONDS = 900;

/** Stop retrying one canonical URL after this many failed deliveries in the attempt window. */
export const MAX_URL_CRAWL_ATTEMPTS = 6;
export const URL_ATTEMPT_TTL_SECONDS = 60 * 60;
export const URL_TERMINAL_TTL_SECONDS = 6 * 60 * 60;

/** Anonymous clients will not get a body back. Do not retry these. */
export const PERMANENT_HTTP_STATUSES = [401, 402, 403, 404, 410, 422] as const;

const PERMANENT_HTTP = new Set<number>(PERMANENT_HTTP_STATUSES);

const DETERMINISTIC_ACK = new Set([
  "ssrf_blocked_host",
  "unsupported_protocol",
  "unsupported_content_type",
  "body_too_large",
  "too_many_redirects",
  "redirect_without_location",
  "browser_body_too_large",
  "browser_extraction_too_small"
]);

export interface CrawlQueueDecision {
  action: "ack" | "retry";
  delaySeconds?: number;
  level: "info" | "warn" | "error";
  event: string;
  /** Remembered on the canonical URL so rediscovery does not fetch it again until the TTL. */
  terminal: string | null;
  /** Count this delivery against {@link MAX_URL_CRAWL_ATTEMPTS}. */
  countAttempt: boolean;
}

export interface UrlCrawlGuard {
  attempts: number;
  terminal: string | null;
}

export interface UrlGuardStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export function urlGuardKey(urlHash: string): string {
  return `crawl-guard:${urlHash}`;
}

/**
 * Short coordinator hints (such as `domain_busy:250`) become a 30–60s cooldown plus jitter.
 * Hints that are already at least 30s are honored, capped at 15 minutes.
 */
export function domainBusyDelaySeconds(waitMs: number, random: () => number = Math.random): number {
  const safeMs = Number.isFinite(waitMs) ? Math.max(0, waitMs) : 0;
  const hinted = Math.ceil(safeMs / 1000);
  const cappedHint = Math.max(1, Math.min(QUEUE_DELAY_MAX_SECONDS, hinted || 1));
  if (cappedHint >= DOMAIN_BUSY_COOLDOWN_MIN_SECONDS) return cappedHint;
  const cooldown = DOMAIN_BUSY_COOLDOWN_MIN_SECONDS + Math.floor(unitRandom(random) * (DOMAIN_BUSY_COOLDOWN_SPAN_SECONDS + 1));
  const jitter = Math.floor(unitRandom(random) * (DOMAIN_BUSY_JITTER_SECONDS + 1));
  return Math.min(QUEUE_DELAY_MAX_SECONDS, cooldown + jitter);
}

function unitRandom(random: () => number): number {
  const roll = random();
  if (!Number.isFinite(roll)) return 0;
  return Math.min(0.999999, Math.max(0, roll));
}

export function parseUrlCrawlGuard(raw: string | null): UrlCrawlGuard {
  if (!raw) return { attempts: 0, terminal: null };
  try {
    const parsed = JSON.parse(raw) as { attempts?: unknown; terminal?: unknown };
    const attempts = typeof parsed.attempts === "number" && Number.isFinite(parsed.attempts)
      ? Math.max(0, Math.floor(parsed.attempts))
      : 0;
    const terminal = typeof parsed.terminal === "string" && parsed.terminal.trim() ? parsed.terminal : null;
    return { attempts, terminal };
  } catch {
    return { attempts: 0, terminal: null };
  }
}

export async function readUrlCrawlGuard(store: UrlGuardStore, urlHash: string): Promise<UrlCrawlGuard> {
  return parseUrlCrawlGuard(await store.get(urlGuardKey(urlHash)));
}

export async function writeUrlCrawlGuard(store: UrlGuardStore, urlHash: string, guard: UrlCrawlGuard): Promise<void> {
  const expirationTtl = guard.terminal ? URL_TERMINAL_TTL_SECONDS : URL_ATTEMPT_TTL_SECONDS;
  await store.put(
    urlGuardKey(urlHash),
    JSON.stringify({ attempts: guard.attempts, terminal: guard.terminal }),
    { expirationTtl }
  );
}

/** KV failures degrade open so a cache outage does not stop crawling. */
export async function loadUrlCrawlGuard(store: UrlGuardStore, urlHash: string): Promise<UrlCrawlGuard> {
  try {
    return await readUrlCrawlGuard(store, urlHash);
  } catch {
    return { attempts: 0, terminal: null };
  }
}

/** Terminal skips and the retry cap throw. Callers should serve a content-cache hit before enforcing the cap. */
export async function assertUrlCrawlAllowed(store: UrlGuardStore, urlHash: string): Promise<void> {
  const guard = await loadUrlCrawlGuard(store, urlHash);
  if (guard.terminal) throw new Error(`crawl_terminal:${guard.terminal}`);
  if (guard.attempts >= MAX_URL_CRAWL_ATTEMPTS) throw new Error("crawl_retry_capped");
}

export async function recordUrlCrawlOutcome(
  store: UrlGuardStore,
  urlHash: string,
  decision: Pick<CrawlQueueDecision, "countAttempt" | "terminal">
): Promise<void> {
  if (!decision.countAttempt && decision.terminal == null) return;
  const current = await readUrlCrawlGuard(store, urlHash);
  const next: UrlCrawlGuard = decision.terminal
    ? { attempts: current.attempts, terminal: decision.terminal }
    : { attempts: current.attempts + 1, terminal: null };
  await writeUrlCrawlGuard(store, urlHash, next);
}

export async function clearUrlCrawlGuard(store: UrlGuardStore, urlHash: string): Promise<void> {
  try {
    await writeUrlCrawlGuard(store, urlHash, { attempts: 0, terminal: null });
  } catch {
    // A leftover cap expires on its own; a successful fetch should not fail because KV blinked.
  }
}

function ack(event: string, level: "info" | "warn", terminal: string | null = null): CrawlQueueDecision {
  return { action: "ack", level, event, terminal, countAttempt: false };
}

function retry(event: string, level: "info" | "warn" | "error", delaySeconds?: number): CrawlQueueDecision {
  const decision: CrawlQueueDecision = {
    action: "retry",
    level,
    event,
    terminal: null,
    countAttempt: true
  };
  if (delaySeconds != null) decision.delaySeconds = delaySeconds;
  return decision;
}

function permanentStatus(message: string): number | null {
  if (message.startsWith("upstream_http_permanent:")) {
    const status = Number(message.slice("upstream_http_permanent:".length));
    return Number.isFinite(status) ? status : 0;
  }
  const match = message.match(/^(?:browser_http|upstream_http)_(\d+)$/);
  if (!match?.[1]) return null;
  const status = Number(match[1]);
  return PERMANENT_HTTP.has(status) ? status : null;
}

function delayMs(message: string, pattern: RegExp): number | null {
  const match = message.match(pattern);
  const raw = match?.[match.length - 1];
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Classify a crawl queue failure.
 * `attempts` is the number of failures already recorded for the canonical URL (not including this one).
 */
export function classifyCrawlQueueFailure(input: {
  message: string;
  attempts: number;
  failureEvent: string;
  random?: () => number;
}): CrawlQueueDecision {
  const message = input.message;
  const attempts = Number.isFinite(input.attempts) ? Math.max(0, Math.floor(input.attempts)) : 0;
  const random = input.random ?? Math.random;

  if (message === "hard_paywall_host") return ack("crawl_paywall_skipped", "info", "hard_paywall_host");
  if (message.startsWith("crawl_terminal:")) return ack("crawl_terminal_skip", "info");
  if (message === "crawl_retry_capped") return ack("crawl_retry_capped", "warn");

  if (permanentStatus(message) != null) return ack("crawl_permanent_skip", "warn", message);

  if (DETERMINISTIC_ACK.has(message)) {
    const event = message === "browser_extraction_too_small" ? "crawl_extraction_skipped" : "crawl_fetch_skipped";
    return ack(event, "warn", message);
  }

  if (attempts >= MAX_URL_CRAWL_ATTEMPTS) return ack("crawl_retry_capped", "warn");

  const busy = delayMs(message, /^(domain_busy|browser_pool_busy):(\d+(?:\.\d+)?)$/);
  if (busy != null) {
    const kind = message.startsWith("browser_pool_busy:") ? "crawl_pool_throttled" : "crawl_domain_throttled";
    return retry(kind, "info", domainBusyDelaySeconds(busy, random));
  }

  const backoff = delayMs(message, /^upstream_backoff_429:(\d+(?:\.\d+)?)$/);
  if (backoff != null) return retry("crawl_upstream_backoff", "warn", domainBusyDelaySeconds(backoff, random));

  return retry(input.failureEvent, "error");
}
