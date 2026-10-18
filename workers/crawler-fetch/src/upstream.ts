export {
  browserFailureAction,
  classifyUpstreamStatus,
  countsTowardUrlCap,
  crawlFailureLog,
  crawlSkipTtlSeconds,
  createPlatformRetryBatch,
  fetchFailureAction,
  flushPlatformRetries,
  isTerminalCrawlFailure,
  notePlatformRetry,
  noteUrlFailure,
  type CrawlFailureContext,
  type CrawlFailureDecision,
  type PlatformRetryFlush,
  type UpstreamAction
} from "../../../packages/crawler-core/src/crawl-failure.ts";

const BACKOFF_CAP_MS = 15 * 60_000;
const BACKOFF_BASE_MS = 30_000;

export function parseRetryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.max(0, Math.round(Number(trimmed) * 1000));
  const date = Date.parse(trimmed);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - now);
}

export function domainBackoffDelayMs(recent429: number, retryAfterMs: number | null): number {
  const steps = Math.min(8, Math.max(0, Math.floor(recent429)));
  const exponential = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * (2 ** steps));
  const honored = retryAfterMs != null && retryAfterMs > 0 ? retryAfterMs : 0;
  return Math.min(BACKOFF_CAP_MS, Math.max(BACKOFF_BASE_MS, exponential, honored));
}

/** Grow backoff while the domain is still hot; a quiet 15 minutes starts again at the base delay. */
export function nextDomainBackoffMs(input: {
  now: number;
  backoffUntil: number;
  recent429: number;
  retryAfterMs: number | null;
}): number {
  const stillHot = input.backoffUntil > input.now - BACKOFF_CAP_MS;
  const recent = stillHot ? input.recent429 : 0;
  return domainBackoffDelayMs(recent, input.retryAfterMs);
}
