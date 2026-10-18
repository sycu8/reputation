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

export function fetchFailureAction(message: string): { action: "ack" } | { action: "retry"; delaySeconds?: number } {
  if (
    message === "ssrf_blocked_host"
    || message === "unsupported_protocol"
    || message === "unsupported_content_type"
    || message === "body_too_large"
    || message === "too_many_redirects"
    || message === "redirect_without_location"
    || message.startsWith("upstream_http_permanent:")
  ) {
    return { action: "ack" };
  }
  const backoff = message.match(/^(?:upstream_backoff_429|domain_busy):(\d+(?:\.\d+)?)$/);
  if (backoff?.[1]) {
    const seconds = Math.max(1, Math.min(900, Math.ceil(Number(backoff[1]) / 1000)));
    return { action: "retry", delaySeconds: seconds };
  }
  return { action: "retry" };
}
