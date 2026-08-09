import { parseBooleanQuery } from "../../../packages/boolean-query/src/index.ts";
import { createJob, idempotencyKey, type JobEnvelope } from "../../../packages/crawler-core/src/index.ts";
import {
  createFederatedDiscoveryProviders,
  createSocialDiscoveryProviders,
  sourceHealthSnapshot,
  type DiscoveryProvider,
  type DiscoveryResult,
  type SourceType
} from "../../../packages/source-adapters/src/index.ts";
import { structuredLog, workerHealthResponse } from "../../../packages/observability/src/index.ts";

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
  /** Optional Brave Search API key (secret). */
  BRAVE_SEARCH_API_KEY?: string;
  /** Optional YouTube Data API key (secret). */
  YOUTUBE_API_KEY?: string;
  /** Optional X API bearer token (secret). */
  X_BEARER_TOKEN?: string;
  /** Optional Reddit OAuth access token (secret). */
  REDDIT_ACCESS_TOKEN?: string;
  /** Optional Reddit app client id (secret). */
  REDDIT_CLIENT_ID?: string;
  /** Optional Reddit app client secret (secret). */
  REDDIT_CLIENT_SECRET?: string;
  /** Optional comma-separated RSS/Atom feed URLs. */
  RSS_FEED_URLS?: string;
  /** Optional comma-separated sitemap URLs. */
  SITEMAP_URLS?: string;
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

function buildProviders(env: Env): DiscoveryProvider[] {
  return [
    ...createFederatedDiscoveryProviders({
      BRAVE_SEARCH_API_KEY: env.BRAVE_SEARCH_API_KEY,
      RSS_FEED_URLS: env.RSS_FEED_URLS,
      SITEMAP_URLS: env.SITEMAP_URLS
    }),
    ...createSocialDiscoveryProviders({
      YOUTUBE_API_KEY: env.YOUTUBE_API_KEY,
      X_BEARER_TOKEN: env.X_BEARER_TOKEN,
      REDDIT_ACCESS_TOKEN: env.REDDIT_ACCESS_TOKEN,
      REDDIT_CLIENT_ID: env.REDDIT_CLIENT_ID,
      REDDIT_CLIENT_SECRET: env.REDDIT_CLIENT_SECRET
    })
  ];
}

function dedupeByUrl(candidates: DiscoveryResult[]): DiscoveryResult[] {
  const seen = new Set<string>();
  const out: DiscoveryResult[] = [];
  for (const candidate of candidates) {
    const key = candidate.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

async function discoverAll(query: string, providers: DiscoveryProvider[]): Promise<DiscoveryResult[]> {
  const ast = parseBooleanQuery(query);
  const batches = await Promise.all(providers.map(async (provider) => {
    try {
      return await provider.discover({ query, ast, limit: 20 });
    } catch (error) {
      structuredLog("warn", "discovery_provider_failed", { requestId: "discovery-fanout" }, {
        providerId: provider.id,
        source: provider.source,
        error: error instanceof Error ? error.message : "unknown"
      });
      return [] as DiscoveryResult[];
    }
  }));
  return dedupeByUrl(batches.flat());
}

async function processMessage(message: Message<JobEnvelope<DiscoveryPayload>>, env: Env): Promise<void> {
  const job = message.body;
  if (!job.tenantId || !job.monitorId) throw new Error("missing_tenant_or_monitor");
  const queries = await getQueries(env, job.tenantId, job.monitorId);
  const providers = buildProviders(env);
  const health = sourceHealthSnapshot(providers);
  let candidateCount = 0;
  for (const query of queries) {
    const candidates = await discoverAll(query.rawQuery, providers);
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
  env.ANALYTICS?.writeDataPoint({
    indexes: [job.monitorId],
    blobs: ["discovery", job.priority, JSON.stringify(health)],
    doubles: [queries.length, candidateCount, providers.length]
  });
}

export default {
  async fetch(): Promise<Response> {
    return workerHealthResponse("discovery");
  },

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
