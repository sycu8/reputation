/** Minimal HTTP health response for queue/cron Workers that otherwise lack fetch(). */
export function workerHealthResponse(service: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ service, status: "ok", ...extra }), {
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
