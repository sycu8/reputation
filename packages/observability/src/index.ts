export interface LogContext {
  requestId: string;
  userId?: string | undefined;
  tenantId?: string | undefined;
  monitorId?: string | undefined;
  route?: string | undefined;
}

export function structuredLog(level: "info" | "warn" | "error", message: string, context: LogContext, extra: Record<string, unknown> = {}): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...context,
    ...extra
  };
  if (level === "error") console.error(JSON.stringify(payload));
  else if (level === "warn") console.warn(JSON.stringify(payload));
  else console.log(JSON.stringify(payload));
}

export { workerHealthResponse } from "./health.ts";
