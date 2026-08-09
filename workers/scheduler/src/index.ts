import {
  createJob,
  DEFAULT_SCHEDULER_SHARD_COUNT,
  type JobEnvelope,
  type JobPriority
} from "../../../packages/crawler-core/src/index.ts";
import { structuredLog } from "../../../packages/observability/src/index.ts";

interface ClaimedMonitor {
  tenantId: string;
  monitorId: string;
  priority: string;
  nextScanAt: string;
  scanIntervalSec: number;
  claimedUntil: string;
}

interface DiscoveryPayload {
  reason: "scheduled";
  scheduledAt: string;
}

interface Env {
  DISCOVERY_NORMAL: Queue<JobEnvelope<DiscoveryPayload>>;
  DISCOVERY_PRIORITY: Queue<JobEnvelope<DiscoveryPayload>>;
  SCHEDULER_SHARD: DurableObjectNamespace;
  CONFIG_KV?: KVNamespace;
  ENVIRONMENT: string;
}

const SHARD_COUNT = DEFAULT_SCHEDULER_SHARD_COUNT;
const CLAIM_LIMIT = 50;
const CLAIM_LEASE_SEC = 120;

function asJobPriority(value: string): JobPriority {
  if (value === "emergency" || value === "priority" || value === "normal" || value === "refresh" || value === "background") {
    return value;
  }
  return "normal";
}

function shardStub(env: Env, shardIndex: number): DurableObjectStub {
  return env.SCHEDULER_SHARD.get(env.SCHEDULER_SHARD.idFromName(`scheduler-shard:${shardIndex}`));
}

async function claimShard(env: Env, shardIndex: number, now: string): Promise<ClaimedMonitor[]> {
  const response = await shardStub(env, shardIndex).fetch("https://scheduler-shard.internal/internal/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ limit: CLAIM_LIMIT, leaseSec: CLAIM_LEASE_SEC, now })
  });
  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`shard_claim_failed:${shardIndex}:${response.status}:${bodyText}`);
  }
  const body = await response.json() as { claimed?: ClaimedMonitor[] };
  return Array.isArray(body.claimed) ? body.claimed : [];
}

/** Optional KV fallback for empty-shard local testing only. */
async function loadKvFallback(env: Env): Promise<ClaimedMonitor[]> {
  if (!env.CONFIG_KV) return [];
  const raw = await env.CONFIG_KV.get("scheduler:dev:due-monitors");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{ tenantId: string; monitorId: string; priority?: string }>;
    const now = new Date().toISOString();
    return parsed
      .filter((item) => item.tenantId && item.monitorId)
      .map((item) => ({
        tenantId: item.tenantId,
        monitorId: item.monitorId,
        priority: item.priority ?? "normal",
        nextScanAt: now,
        scanIntervalSec: 900,
        claimedUntil: now
      }));
  } catch {
    return [];
  }
}

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const requestId = crypto.randomUUID();
    const scheduledAt = new Date(controller.scheduledTime).toISOString();
    let dueCount = 0;
    let shardErrors = 0;

    for (let shard = 0; shard < SHARD_COUNT; shard += 1) {
      try {
        const claimed = await claimShard(env, shard, scheduledAt);
        for (const item of claimed) {
          const priority = asJobPriority(item.priority);
          const job = createJob<DiscoveryPayload>(
            { reason: "scheduled", scheduledAt },
            { traceId: requestId, tenantId: item.tenantId, monitorId: item.monitorId, priority }
          );
          const target = priority === "emergency" || priority === "priority" ? env.DISCOVERY_PRIORITY : env.DISCOVERY_NORMAL;
          ctx.waitUntil(target.send(job));
          dueCount += 1;
        }
      } catch (error) {
        shardErrors += 1;
        structuredLog("error", "scheduler_shard_claim_failed", { requestId }, {
          shard,
          error: error instanceof Error ? error.message : "unknown"
        });
      }
    }

    if (dueCount === 0) {
      const fallback = await loadKvFallback(env);
      for (const item of fallback) {
        const priority = asJobPriority(item.priority);
        const job = createJob<DiscoveryPayload>(
          { reason: "scheduled", scheduledAt },
          { traceId: requestId, tenantId: item.tenantId, monitorId: item.monitorId, priority }
        );
        const target = priority === "emergency" || priority === "priority" ? env.DISCOVERY_PRIORITY : env.DISCOVERY_NORMAL;
        ctx.waitUntil(target.send(job));
        dueCount += 1;
      }
    }

    structuredLog("info", "scheduler_tick", { requestId }, {
      dueCount,
      shardCount: SHARD_COUNT,
      shardErrors,
      environment: env.ENVIRONMENT
    });
  },

  fetch(): Response {
    return new Response(
      JSON.stringify({
        service: "scheduler",
        status: "ok",
        shardCount: SHARD_COUNT
      }),
      { headers: { "content-type": "application/json" } }
    );
  }
};
