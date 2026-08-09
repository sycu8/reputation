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

export function normalizeUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";
  const removable = new Set(["fbclid", "gclid", "mc_cid", "mc_eid"]);
  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith("utm_") || removable.has(lower)) url.searchParams.delete(key);
  }
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  if (url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
  const sorted = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [key, value] of sorted) url.searchParams.append(key, value);
  return url.toString();
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
