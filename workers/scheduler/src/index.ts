import { createJob, type JobEnvelope } from "../../../packages/crawler-core/src/index.ts";
import { structuredLog } from "../../../packages/observability/src/index.ts";

interface DueMonitor {
  tenantId: string;
  monitorId: string;
  priority: "emergency" | "priority" | "normal" | "refresh" | "background";
}

interface DiscoveryPayload {
  reason: "scheduled";
  scheduledAt: string;
}

interface Env {
  DISCOVERY_NORMAL: Queue<JobEnvelope<DiscoveryPayload>>;
  DISCOVERY_PRIORITY: Queue<JobEnvelope<DiscoveryPayload>>;
  CONFIG_KV: KVNamespace;
  ENVIRONMENT: string;
}

async function loadDueMonitors(env: Env): Promise<DueMonitor[]> {
  // Phase 3 keeps scheduler discovery source abstract. In production this list is
  // populated from a scheduler index fed by MonitorDO state, not a global DO scan.
  const raw = await env.CONFIG_KV.get("scheduler:dev:due-monitors");
  if (!raw) return [];
  const parsed = JSON.parse(raw) as DueMonitor[];
  return parsed.filter((item) => item.tenantId && item.monitorId);
}

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const requestId = crypto.randomUUID();
    const due = await loadDueMonitors(env);
    for (const item of due) {
      const job = createJob<DiscoveryPayload>(
        { reason: "scheduled", scheduledAt: new Date(controller.scheduledTime).toISOString() },
        { traceId: requestId, tenantId: item.tenantId, monitorId: item.monitorId, priority: item.priority }
      );
      const target = item.priority === "emergency" || item.priority === "priority" ? env.DISCOVERY_PRIORITY : env.DISCOVERY_NORMAL;
      ctx.waitUntil(target.send(job));
    }
    structuredLog("info", "scheduler_tick", { requestId }, { dueCount: due.length, environment: env.ENVIRONMENT });
  },

  fetch(): Response {
    return new Response(JSON.stringify({ service: "scheduler", status: "ok" }), { headers: { "content-type": "application/json" } });
  }
};
