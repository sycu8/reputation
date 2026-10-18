export interface LogContext {
  requestId: string;
  userId?: string | undefined;
  tenantId?: string | undefined;
  monitorId?: string | undefined;
  route?: string | undefined;
}

function isSensitiveLogKey(key: string): boolean {
  return /auth|key|secret|token|jwt|cookie|header/i.test(key);
}

/** Drop header maps and any field whose name looks like a credential before it is printed. */
export function redactLogFields(value: unknown, depth = 0): unknown {
  if (depth > 6) return "redacted";
  if (Array.isArray(value)) return value.map((item) => redactLogFields(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    redacted[key] = isSensitiveLogKey(key) ? "redacted" : redactLogFields(inner, depth + 1);
  }
  return redacted;
}

export function structuredLog(level: "info" | "warn" | "error", message: string, context: LogContext, extra: Record<string, unknown> = {}): void {
  const safeContext = redactLogFields(context) as LogContext;
  const safeExtra = redactLogFields(extra) as Record<string, unknown>;
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...safeContext,
    ...safeExtra
  };
  if (level === "error") console.error(JSON.stringify(payload));
  else if (level === "warn") console.warn(JSON.stringify(payload));
  else console.log(JSON.stringify(payload));
}

export { workerHealthResponse } from "./health.ts";
