import { parseBooleanQuery } from "../../../packages/boolean-query/src/index.ts";
import { createJob, idempotencyKey, prepareDiscoveredUrl, type JobEnvelope } from "../../../packages/crawler-core/src/index.ts";
import {
  createFederatedDiscoveryProviders,
  createSocialDiscoveryProviders,
  sourceHealthSnapshot,
  type DiscoveryProvider,
  type DiscoveryResult,
  type SourceType
} from "../../../packages/source-adapters/src/index.ts";
import { monitorProfileUrls, type MonitorProfile } from "../../../packages/types/src/index.ts";
import { structuredLog, workerHealthResponse } from "../../../packages/observability/src/index.ts";
import { batchCrawlJobs, crawlMessageBytes, fitCrawlJob } from "./messages.ts";

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

async function getMonitorProfile(env: Env, tenantId: string, monitorId: string): Promise<MonitorProfile> {
  try {
    const response = await monitorStub(env, tenantId, monitorId).fetch("https://do.internal/internal/monitor");
    if (!response.ok) return {};
    const data = await response.json() as { monitor?: { profile?: MonitorProfile } };
    return data.monitor?.profile ?? {};
  } catch {
    return {};
  }
}

function profileSourceFor(key: string): SourceType {
  if (key === "facebook" || key === "tiktok" || key === "linkedin" || key === "youtube" || key === "reddit" || key === "x") return key;
  return "web";
}

function profileCandidates(profile: MonitorProfile): DiscoveryResult[] {
  return monitorProfileUrls(profile).map(({ key, url }) => ({
    source: profileSourceFor(key),
    url,
    title: `Official ${key}`,
    snippet: `Configured monitor profile page (${key})`,
    metadata: { provider: "monitor-profile", profileKey: key }
  }));
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
    const prepared = prepareDiscoveredUrl(candidate.url);
    if (prepared == null) continue;
    const key = prepared.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(prepared === candidate.url ? candidate : { ...candidate, url: prepared });
  }
  return out;
}

async function discoverAll(query: string, providers: DiscoveryProvider[]): Promise<DiscoveryResult[]> {
  const ast = parseBooleanQuery(query);
  const batches = await Promise.all(providers.map(async (provider) => {
    try {
      return await provider.discover({ query, ast, limit: 80 });
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

const DISCOVERY_JOB_BUDGET_MS = 90_000;

interface DiscoveryRun {
  enqueued: number;
  skipped: number;
  queriesRun: number;
  queriesDeferred: number;
}

async function enqueueCrawls(
  env: Env,
  jobs: Array<JobEnvelope<CrawlPayload>>,
  context: { requestId: string; tenantId?: string | undefined; monitorId?: string | undefined }
): Promise<{ enqueued: number; skipped: number }> {
  let enqueued = 0;
  let skipped = 0;
  for (const batch of batchCrawlJobs(jobs)) {
    try {
      await env.CRAWL_STATIC.sendBatch(batch.map((body) => ({ body })));
      enqueued += batch.length;
    } catch {
      for (const body of batch) {
        try {
          await env.CRAWL_STATIC.send(body);
          enqueued += 1;
        } catch (error) {
          skipped += 1;
          structuredLog("warn", "discovery_candidate_skipped", context, {
            url: body.payload.url,
            bytes: crawlMessageBytes(body),
            error: error instanceof Error ? error.message : "unknown"
          });
        }
      }
    }
  }
  return { enqueued, skipped };
}

async function processMessage(message: Message<JobEnvelope<DiscoveryPayload>>, env: Env): Promise<DiscoveryRun> {
  const job = message.body;
  if (!job.tenantId || !job.monitorId) throw new Error("missing_tenant_or_monitor");
  const started = Date.now();
  const queries = await getQueries(env, job.tenantId, job.monitorId);
  const providers = buildProviders(env);
  const health = sourceHealthSnapshot(providers);
  const profile = await getMonitorProfile(env, job.tenantId, job.monitorId);
  const profileSeeds = profileCandidates(profile);
  const context = { requestId: job.traceId, tenantId: job.tenantId, monitorId: job.monitorId };
  // Rotate the start query so a budget cutoff does not starve the same tail forever.
  const offset = queries.length > 0 ? Math.floor(started / 60_000) % queries.length : 0;
  const ordered = queries.slice(offset).concat(queries.slice(0, offset));
  let candidateCount = 0;
  let enqueued = 0;
  let skipped = 0;
  let queriesRun = 0;
  let queriesDeferred = 0;
  for (const query of ordered) {
    if (Date.now() - started > DISCOVERY_JOB_BUDGET_MS) {
      queriesDeferred += 1;
      continue;
    }
    queriesRun += 1;
    let candidates: DiscoveryResult[] = [];
    try {
      candidates = dedupeByUrl([...profileSeeds, ...await discoverAll(query.rawQuery, providers)]);
    } catch (error) {
      structuredLog("warn", "discovery_query_failed", context, {
        queryId: query.id,
        error: error instanceof Error ? error.message : "unknown"
      });
      continue;
    }
    candidateCount += candidates.length;
    const jobs: Array<JobEnvelope<CrawlPayload>> = [];
    for (const candidate of candidates.slice(0, 80)) {
      try {
        const discoveryKey = await idempotencyKey([job.monitorId, candidate.source, candidate.url]);
        jobs.push(fitCrawlJob(createJob<CrawlPayload>({
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
        })));
      } catch (error) {
        skipped += 1;
        structuredLog("warn", "discovery_candidate_skipped", context, {
          url: candidate.url,
          error: error instanceof Error ? error.message : "unknown"
        });
      }
    }
    const sent = await enqueueCrawls(env, jobs, context);
    enqueued += sent.enqueued;
    skipped += sent.skipped;
  }
  if (queriesDeferred > 0) {
    structuredLog("warn", "discovery_budget_exhausted", context, {
      queriesRun,
      queriesDeferred,
      elapsedMs: Date.now() - started
    });
  }
  env.ANALYTICS?.writeDataPoint({
    indexes: [job.monitorId],
    blobs: ["discovery", job.priority, JSON.stringify(health)],
    doubles: [queries.length, candidateCount, providers.length]
  });
  if (skipped > 0 && enqueued === 0 && candidateCount > 0) throw new Error("discovery_enqueue_failed");
  return { enqueued, skipped, queriesRun, queriesDeferred };
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
        // Retry only when nothing was enqueued (processMessage throws before or instead of a partial send).
        message.retry();
      }
    }
  }
};
