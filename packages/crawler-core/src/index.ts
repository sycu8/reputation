export type JobPriority = "emergency" | "priority" | "normal" | "refresh" | "background";

export interface JobEnvelope<T> {
  schemaVersion: 1;
  jobId: string;
  traceId: string;
  tenantId?: string | undefined;
  monitorId?: string | undefined;
  priority: JobPriority;
  createdAt: string;
  attempt: number;
  payload: T;
}

export function createJob<T>(payload: T, input: Omit<JobEnvelope<T>, "schemaVersion" | "jobId" | "createdAt" | "attempt" | "payload"> & { jobId?: string }): JobEnvelope<T> {
  return {
    schemaVersion: 1,
    jobId: input.jobId ?? crypto.randomUUID(),
    traceId: input.traceId,
    tenantId: input.tenantId,
    monitorId: input.monitorId,
    priority: input.priority,
    createdAt: new Date().toISOString(),
    attempt: 0,
    payload
  };
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function idempotencyKey(parts: Array<string | number | undefined>): Promise<string> {
  return sha256Hex(parts.map((part) => String(part ?? "")).join("\u001f"));
}

const EXACT_TRACKING_PARAMS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid"]);

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.startsWith("utm_") || lower.startsWith("syn-") || EXACT_TRACKING_PARAMS.has(lower);
}

export function normalizeUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (isTrackingParam(key)) url.searchParams.delete(key);
  }
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  if (url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
  const sorted = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [key, value] of sorted) url.searchParams.append(key, value);
  return url.toString();
}

/** Dedupe key for discovery. Invalid URLs fall back to a trimmed lowercase string. */
export function discoveryDedupeKey(url: string): string {
  try {
    return normalizeUrl(url);
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Hosts whose article pages are hard paywalls. Subdomains match. Override with HARD_PAYWALL_HOSTS. */
export const DEFAULT_HARD_PAYWALL_HOSTS = ["ft.com", "nytimes.com"] as const;

export function parseHardPaywallHosts(raw: string | undefined | null): string[] {
  if (raw == null || raw.trim() === "") return [...DEFAULT_HARD_PAYWALL_HOSTS];
  const hosts = raw.split(",").map((item) => item.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "")).filter((item) => item.length > 0);
  return hosts.length > 0 ? hosts : [...DEFAULT_HARD_PAYWALL_HOSTS];
}

export function isHardPaywalledHost(hostname: string, hosts: readonly string[] = DEFAULT_HARD_PAYWALL_HOSTS): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  return hosts.some((blocked) => {
    const rule = blocked.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
    return rule.length > 0 && (host === rule || host.endsWith(`.${rule}`));
  });
}

/** Jittered queue delay for domain/pool congestion. Short hints (for example 250ms) become 30–60s. */
export const BUSY_REQUEUE_MIN_SECONDS = 30;
export const BUSY_REQUEUE_MAX_SECONDS = 60;
export const BUSY_REQUEUE_CAP_SECONDS = 900;

export function busyRequeueDelaySeconds(waitMs: number, random: () => number = Math.random): number {
  const roll = random();
  const unit = Number.isFinite(roll) ? Math.min(1, Math.max(0, roll)) : 0;
  const span = BUSY_REQUEUE_MAX_SECONDS - BUSY_REQUEUE_MIN_SECONDS;
  const jittered = BUSY_REQUEUE_MIN_SECONDS + Math.floor(unit * (span + 1));
  const windowed = Math.min(BUSY_REQUEUE_MAX_SECONDS, Math.max(BUSY_REQUEUE_MIN_SECONDS, jittered));
  const hinted = Number.isFinite(waitMs) && waitMs > 0 ? Math.ceil(waitMs / 1000) : 0;
  return Math.min(BUSY_REQUEUE_CAP_SECONDS, Math.max(windowed, hinted));
}

/**
 * Real fetch failures remembered per tenant and normalized URL.
 * Congestion delays are not counted. A fresh message is skipped once the cap is reached.
 * An in-flight transient retry is not skipped here; the queue dead-letters it after max_retries.
 */
export const URL_RETRY_CAP = 8;
export const URL_RETRY_WINDOW_SECONDS = 15 * 60;

export function crawlAttemptKey(tenantId: string | undefined, urlHash: string): string {
  const tenant = tenantId?.trim() ? tenantId.trim() : "_";
  return `crawl-attempts:${tenant}:${urlHash}`;
}

/** The per-URL cap applies to a new delivery. Redeliveries keep retrying until the queue DLQ. */
export function shouldApplyUrlRetryCap(attempts: number | undefined): boolean {
  return (attempts ?? 1) <= 1;
}

export interface CrawlCacheRecord {
  skip?: string;
  contentId?: string;
  rawR2Key?: string;
  fetchedAt?: string;
  canonicalUrl?: string;
}

export function crawlCacheSkipReason(record: CrawlCacheRecord): string | null {
  if (typeof record.skip === "string" && record.skip.length > 0) return record.skip;
  return null;
}

/** Content already stored for this URL. Callers forward it to the current tenant's monitor. */
export function crawlCacheHit(record: CrawlCacheRecord): { contentId: string; rawR2Key: string; fetchedAt: string; canonicalUrl: string } | null {
  if (crawlCacheSkipReason(record)) return null;
  if (record.contentId && record.rawR2Key && record.fetchedAt && record.canonicalUrl) {
    return {
      contentId: record.contentId,
      rawR2Key: record.rawR2Key,
      fetchedAt: record.fetchedAt,
      canonicalUrl: record.canonicalUrl
    };
  }
  return null;
}

export function urlRetryCapReached(recordedFailures: number, cap = URL_RETRY_CAP): boolean {
  if (!Number.isFinite(recordedFailures)) return false;
  return recordedFailures >= cap;
}

export function nextUrlFailureCount(recordedFailures: number): number {
  if (!Number.isFinite(recordedFailures) || recordedFailures < 0) return 1;
  return Math.floor(recordedFailures) + 1;
}

export function assertPublicHttpUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported_protocol");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("ssrf_blocked_host");
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) throw new Error("ssrf_blocked_host");
  const match172 = host.match(/^172\.(\d+)\./);
  if (match172) {
    const second = Number(match172[1]);
    if (second >= 16 && second <= 31) throw new Error("ssrf_blocked_host");
  }
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) throw new Error("ssrf_blocked_host");
  return url;
}

export function boundedRetryDelayMs(attempt: number, baseMs = 500, capMs = 30_000): number {
  const exponential = Math.min(capMs, baseMs * (2 ** Math.max(0, attempt)));
  const jitter = Math.floor(exponential * 0.2 * Math.random());
  return exponential + jitter;
}

/**
 * Workers Paid Browser Run concurrent browsers per account.
 * Published default since 2026-08-20 (limits page current 2026-10-14).
 * Quick Actions are also rate-limited (30 requests/second on Workers Paid).
 * The state worker var `BROWSER_POOL_MAX` overrides this when the account limit differs.
 */
export const BROWSER_RUN_ACCOUNT_CONCURRENCY = 200;

/** Hard ceiling for `BROWSER_POOL_MAX` so a bad var cannot open an unbounded pool. */
export const BROWSER_POOL_MAX_CEILING = 1_000;

/** Lease lifetime. Longer than a Browser Run content action (15s) so a live crawl is not expired mid-flight. */
export const BROWSER_POOL_LEASE_TTL_MS = 90_000;

/** Resolve the pool cap from the optional worker var, otherwise the published account concurrency. */
export function browserPoolCap(raw: string | number | undefined): number {
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return BROWSER_RUN_ACCOUNT_CONCURRENCY;
  return Math.max(1, Math.min(BROWSER_POOL_MAX_CEILING, Math.floor(parsed)));
}

export const DEFAULT_SCHEDULER_SHARD_COUNT = 64;

/** Stable shard index for a tenant: SHA-256(tenantId) as big-endian uint32 mod shardCount. */
export async function schedulerShardIndex(tenantId: string, shardCount = DEFAULT_SCHEDULER_SHARD_COUNT): Promise<number> {
  if (!Number.isInteger(shardCount) || shardCount <= 0) throw new Error("invalid_shard_count");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tenantId));
  const bytes = new Uint8Array(digest);
  const value = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  return value % shardCount;
}

export interface ClaimableMonitorRow {
  status: string;
  nextScanAt: string;
  claimedUntil: string | null;
}

/** True when status=active, next_scan_at <= now, and lease is absent or expired (claimed_until < now). */
export function isClaimable(row: ClaimableMonitorRow, nowIso: string): boolean {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) return false;
  if (row.status !== "active") return false;
  const nextMs = Date.parse(row.nextScanAt);
  if (!Number.isFinite(nextMs) || nextMs > nowMs) return false;
  if (row.claimedUntil == null) return true;
  const claimedMs = Date.parse(row.claimedUntil);
  if (!Number.isFinite(claimedMs)) return true;
  return claimedMs < nowMs;
}

/** Advance schedule from max(nextScanAt, now) by scanIntervalSec. */
export function advanceNextScanAt(nextScanAt: string, scanIntervalSec: number, nowIso: string): string {
  const intervalMs = Math.max(1, Math.floor(scanIntervalSec)) * 1000;
  const base = Math.max(Date.parse(nextScanAt) || 0, Date.parse(nowIso) || Date.now());
  return new Date(base + intervalMs).toISOString();
}

export function claimLeaseUntil(nowIso: string, leaseSec: number): string {
  const leaseMs = Math.max(1, Math.floor(leaseSec)) * 1000;
  return new Date((Date.parse(nowIso) || Date.now()) + leaseMs).toISOString();
}

/**
 * Browser Run `content` / `markdown` responses are JSON envelopes.
 * Older crawlers accidentally stored the raw envelope as extracted text.
 */
export function unwrapBrowserRunPayload(raw: string): { body: string; title: string | null } {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return { body: "", title: null };
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as {
        success?: unknown;
        result?: unknown;
        meta?: { title?: unknown };
      };
      if (parsed && parsed.success === true && typeof parsed.result === "string") {
        const title = typeof parsed.meta?.title === "string" && parsed.meta.title.trim()
          ? parsed.meta.title.trim()
          : null;
        return { body: parsed.result, title };
      }
    } catch {
      // Fall through to regex for truncated / partially escaped blobs.
    }
    const match = trimmed.match(/"result"\s*:\s*"((?:\\.|[^"\\])*)(?:"|$)/);
    if (match?.[1] != null) {
      try {
        return { body: JSON.parse(`"${match[1]}"`) as string, title: null };
      } catch {
        return {
          body: match[1]
            .replace(/\\n/g, "\n")
            .replace(/\\t/g, "\t")
            .replace(/\\r/g, "\r")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\"),
          title: null
        };
      }
    }
  }
  return { body: trimmed, title: null };
}

/** Convert HTML (or plain text) into readable plain text with paragraph breaks. */
export function htmlToPlainText(html: string): { title: string | null; text: string } {
  const source = String(html ?? "");
  const title = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? null;
  const text = source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { title, text };
}

/** Normalize crawl/AI payloads into human-readable content (fixes Browser Run JSON leftovers). */
export function readableContentText(raw: string): string {
  const unwrapped = unwrapBrowserRunPayload(raw);
  const looksHtml = /<\/?[a-z][\s\S]*>/i.test(unwrapped.body);
  const text = looksHtml ? htmlToPlainText(unwrapped.body).text : unwrapped.body
    .replace(/\r\n?/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return text;
}

export function excerptForStorage(raw: string, maxLen = 600): string {
  const text = readableContentText(raw).replace(/\s+/g, " ").trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}
