import type { JobEnvelope } from "../../../packages/crawler-core/src/index.ts";
import { structuredLog } from "../../../packages/observability/src/index.ts";

export interface ReportJobPayload {
  reportId: string;
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  kind: "daily" | "weekly" | "adhoc";
}

interface Env {
  ENVIRONMENT: string;
  RAW_CONTENT?: R2Bucket;
  REPORTS?: R2Bucket;
}

function storage(env: Env): R2Bucket | undefined {
  return env.REPORTS ?? env.RAW_CONTENT;
}

function reportKey(payload: ReportJobPayload): string {
  return `reports/${payload.tenantId}/${payload.kind}/${payload.periodStart}_${payload.reportId}.json`;
}

async function writeReportStub(env: Env, job: JobEnvelope<ReportJobPayload>): Promise<{ key: string; skipped: boolean }> {
  const bucket = storage(env);
  if (!bucket) throw new Error("reports_storage_unavailable");
  const key = reportKey(job.payload);
  const existing = await bucket.get(key);
  if (existing) return { key, skipped: true };

  const stub = {
    schemaVersion: 1,
    reportId: job.payload.reportId,
    jobId: job.jobId,
    tenantId: job.payload.tenantId,
    kind: job.payload.kind,
    periodStart: job.payload.periodStart,
    periodEnd: job.payload.periodEnd,
    generatedAt: new Date().toISOString(),
    status: "stub",
    summary: {
      mentions: 0,
      alerts: 0,
      negativeMentions: 0
    },
    note: "Phase 12 skeleton report — populate from MonitorDO aggregates in a later phase."
  };
  await bucket.put(key, JSON.stringify(stub, null, 2));
  return { key, skipped: false };
}

async function processMessage(message: Message<JobEnvelope<ReportJobPayload>>, env: Env): Promise<void> {
  const job = message.body;
  if (!job.payload?.tenantId || !job.payload.reportId) throw new Error("invalid_report_job");
  const result = await writeReportStub(env, job);
  structuredLog("info", result.skipped ? "report_job_idempotent_skip" : "report_stub_written", {
    requestId: job.traceId,
    tenantId: job.payload.tenantId
  }, { key: result.key, reportId: job.payload.reportId, kind: job.payload.kind });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(JSON.stringify({
        service: "reports",
        status: "ok",
        environment: env.ENVIRONMENT,
        storage: Boolean(storage(env))
      }), { headers: { "content-type": "application/json; charset=utf-8" } });
    }
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  },

  async queue(batch: MessageBatch<JobEnvelope<ReportJobPayload>>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processMessage(message, env);
        message.ack();
      } catch (error) {
        structuredLog("error", "report_job_failed", {
          requestId: message.body.traceId,
          tenantId: message.body.tenantId
        }, { error: error instanceof Error ? error.message : "unknown" });
        message.retry({ delaySeconds: 120 });
      }
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const day = new Date(controller.scheduledTime).toISOString().slice(0, 10);
    structuredLog("info", "reports_cron_tick", { requestId: `cron-${day}` }, {
      cron: controller.cron,
      note: "Enqueue tenant report jobs from registry in a later phase.",
      storageReady: Boolean(storage(env))
    });
  }
};
