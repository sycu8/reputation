import { classifyCrawlQueueFailure } from "../../../packages/crawler-core/src/retry-policy.ts";

export type UpstreamAction = "permanent" | "browser" | "backoff" | "retry";

const BACKOFF_CAP_MS = 15 * 60_000;
const BACKOFF_BASE_MS = 30_000;

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

export function fetchFailureAction(
  message: string,
  options?: { attempts?: number; random?: () => number }
): { action: "ack" } | { action: "retry"; delaySeconds?: number } {
  const decision = classifyCrawlQueueFailure({
    message,
    attempts: options?.attempts ?? 0,
    failureEvent: "crawl_fetch_failed",
    ...(options?.random ? { random: options.random } : {})
  });
  if (decision.action === "ack") return { action: "ack" };
  if (decision.delaySeconds != null) return { action: "retry", delaySeconds: decision.delaySeconds };
  return { action: "retry" };
}
