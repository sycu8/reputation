import { parseBooleanQuery } from "../../../packages/boolean-query/src/index.ts";
import { createJob, idempotencyKey, type JobEnvelope } from "../../../packages/crawler-core/src/index.ts";
import type { DiscoveryResult, SourceType } from "../../../packages/source-adapters/src/index.ts";
import { structuredLog } from "../../../packages/observability/src/index.ts";

interface DiscoveryPayload {
  reason: "scheduled";
  scheduledAt: string;
}

export interface CrawlPayload {
  source: SourceType;
  url: string;
  discoveryKey: string;
  title?: string | undefined;
  snippet?: string | undefined;
  publishedAt?: string | undefined;
}

interface Env {
  MONITOR_DO: DurableObjectNamespace;
  CRAWL_STATIC: Queue<JobEnvelope<CrawlPayload>>;
  CRAWL_BROWSER: Queue<JobEnvelope<CrawlPayload>>;
  ANALYTICS?: AnalyticsEngineDataset;
  BRAVE_SEARCH_API_KEY?: string;
}

function monitorStub(env: Env, tenantId: string, monitorId: string): DurableObjectStub {
  return env.MONITOR_DO.get(env.MONITOR_DO.idFromName(`${tenantId}:${monitorId}`));
}

async function getQueries(env: Env, tenantId: string, monitorId: string): Promise<Array<{ id: string; rawQuery: string; enabled: boolean }>> {
  const response = await monitorStub(env, tenantId, monitorId).fetch("https://do.internal/internal/queries");
  if (!response.ok) throw new Error("monitor_queries_unavailable");
  const data = await response.json() as { queries: Array<{ id: string; rawQuery: string; enabled: boolean }> };
  return data.queries.filter((query) => query.enabled);
}

async function discoverWebSearch(query: string, env: Env): Promise<DiscoveryResult[]> {
  parseBooleanQuery(query);
  if (!env.BRAVE_SEARCH_API_KEY) return [];
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "20");
  url.searchParams.set("safesearch", "moderate");
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "x-subscription-token": env.BRAVE_SEARCH_API_KEY
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`brave_search_http_${response.status}`);
  const data = await response.json() as { web?: { results?: Array<Record<string, unknown>> } };
  return (data.web?.results ?? []).flatMap((item): DiscoveryResult[] => {
    if (typeof item.url !== "string") return [];
    return [{
      source: "web",
      url: item.url,
      title: typeof item.title === "string" ? item.title : undefined,
      snippet: typeof item.description === "string" ? item.description : undefined,
      publishedAt: typeof item.page_age === "string" ? item.page_age : undefined,
      metadata: { provider: "brave-search" }
    }];
  });
}

async function processMessage(message: Message<JobEnvelope<DiscoveryPayload>>, env: Env): Promise<void> {
  const job = message.body;
  if (!job.tenantId || !job.monitorId) throw new Error("missing_tenant_or_monitor");
  const queries = await getQueries(env, job.tenantId, job.monitorId);
  let candidateCount = 0;
  for (const query of queries) {
    const candidates = await discoverWebSearch(query.rawQuery, env);
    candidateCount += candidates.length;
    for (const candidate of candidates) {
      const discoveryKey = await idempotencyKey([job.monitorId, candidate.source, candidate.url]);
      const crawl = createJob<CrawlPayload>({
        source: candidate.source,
        url: candidate.url,
        discoveryKey,
        title: candidate.title,
        snippet: candidate.snippet,
        publishedAt: candidate.publishedAt
      }, {
        traceId: job.traceId,
        tenantId: job.tenantId,
        monitorId: job.monitorId,
        priority: job.priority
      });
      await env.CRAWL_STATIC.send(crawl);
    }
  }
  env.ANALYTICS?.writeDataPoint({ indexes: [job.monitorId], blobs: ["discovery", job.priority], doubles: [queries.length, candidateCount] });
}

export default {
  async queue(batch: MessageBatch<JobEnvelope<DiscoveryPayload>>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processMessage(message, env);
        message.ack();
      } catch (error) {
        structuredLog("error", "discovery_job_failed", { requestId: message.body.traceId, tenantId: message.body.tenantId, monitorId: message.body.monitorId }, {
          jobId: message.body.jobId,
          error: error instanceof Error ? error.message : "unknown"
        });
        message.retry();
      }
    }
  }
};
