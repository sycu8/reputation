import { evaluateBooleanAst, type BooleanAst } from "../../../packages/boolean-query/src/index.ts";
import { createJob, type JobEnvelope } from "../../../packages/crawler-core/src/index.ts";
import {
  assignStoryCluster,
  contentFingerprint,
  embeddingReady,
  type VectorizeDedupeAdapter
} from "../../../packages/dedupe/src/index.ts";
import type { SourceType } from "../../../packages/source-adapters/src/index.ts";
import { structuredLog } from "../../../packages/observability/src/index.ts";

interface ProcessPayload {
  source: SourceType;
  canonicalUrl: string;
  contentId: string;
  rawR2Key: string;
  fetchedAt: string;
  discoveryTitle?: string | undefined;
  discoverySnippet?: string | undefined;
  publishedAt?: string | undefined;
  acquisition: "fetch" | "cache" | "browser";
}

export interface AiCandidatePayload {
  source: SourceType;
  canonicalUrl: string;
  contentId: string;
  rawR2Key: string;
  fetchedAt: string;
  title: string;
  text: string;
  publishedAt?: string | undefined;
  monitorName: string;
  relevanceScore: number;
  relevanceReason: string;
  simHash: string;
  storyClusterId: string;
  contentHash?: string | undefined;
}

interface Env {
  RAW_CONTENT: R2Bucket;
  MONITOR_DO: DurableObjectNamespace;
  AI_NORMAL: Queue<JobEnvelope<AiCandidatePayload>>;
  AI_PRIORITY: Queue<JobEnvelope<AiCandidatePayload>>;
  ANALYTICS?: AnalyticsEngineDataset;
  /** Optional Vectorize binding; when absent, semantic upsert/query is skipped. */
  VECTORIZE?: VectorizeDedupeAdapter;
}

function monitorStub(env: Env, tenantId: string, monitorId: string): DurableObjectStub {
  return env.MONITOR_DO.get(env.MONITOR_DO.idFromName(`${tenantId}:${monitorId}`));
}

async function readR2Json(env: Env, key: string): Promise<Record<string, unknown>> {
  const object = await env.RAW_CONTENT.get(key);
  if (!object) throw new Error("raw_content_not_found");
  const text = await object.text();
  return JSON.parse(text) as Record<string, unknown>;
}

function negativeHint(text: string): boolean {
  const value = text.toLocaleLowerCase();
  const terms = [
    "scam", "fraud", "lừa đảo", "lua dao", "không hoàn tiền", "chưa hoàn tiền", "refund",
    "tố cáo", "bóc phốt", "boc phot", "khiếu nại", "khieu nai", "data leak", "rò rỉ dữ liệu",
    "breach", "boycott", "tẩy chay", "lawsuit", "khởi kiện", "sập", "outage"
  ];
  return terms.some((term) => value.includes(term));
}

async function processMessage(message: Message<JobEnvelope<ProcessPayload>>, env: Env): Promise<void> {
  const job = message.body;
  if (!job.tenantId || !job.monitorId) throw new Error("missing_tenant_or_monitor");
  const stub = monitorStub(env, job.tenantId, job.monitorId);
  const existsResponse = await stub.fetch(`https://do.internal/internal/mentions/exists/${encodeURIComponent(job.payload.contentId)}`);
  if (existsResponse.ok && ((await existsResponse.json()) as { exists: boolean }).exists) return;

  const [monitorResponse, queriesResponse, raw] = await Promise.all([
    stub.fetch("https://do.internal/internal/monitor"),
    stub.fetch("https://do.internal/internal/queries"),
    readR2Json(env, job.payload.rawR2Key)
  ]);
  if (!monitorResponse.ok || !queriesResponse.ok) throw new Error("monitor_state_unavailable");
  const monitorData = await monitorResponse.json() as { monitor: { name: string } };
  const queryData = await queriesResponse.json() as { queries: Array<{ astJson: string; enabled: boolean; normalizedQuery: string }> };
  const title = typeof raw.title === "string" ? raw.title : job.payload.discoveryTitle ?? "";
  const text = typeof raw.extractedText === "string" ? raw.extractedText : typeof raw.rawBody === "string" ? raw.rawBody : "";
  const combined = `${title}\n${text}`;
  const fingerprint = contentFingerprint(combined);

  const nearDupesResponse = await stub.fetch(
    `https://do.internal/internal/mentions/near-dupes?simhash=${encodeURIComponent(fingerprint.simHash)}&threshold=3&limit=20`
  );
  if (nearDupesResponse.ok) {
    const near = await nearDupesResponse.json() as { matches?: Array<{ id: string; hamming: number }> };
    if (Array.isArray(near.matches) && near.matches.length > 0) {
      env.ANALYTICS?.writeDataPoint({ indexes: [job.monitorId], blobs: ["near_dupe_skip", job.payload.source], doubles: [near.matches[0]?.hamming ?? 0] });
      return;
    }
  }

  const matchingQueries: string[] = [];
  for (const query of queryData.queries) {
    if (!query.enabled) continue;
    try {
      const ast = JSON.parse(query.astJson) as BooleanAst;
      if (evaluateBooleanAst(ast, combined)) matchingQueries.push(query.normalizedQuery);
    } catch {
      continue;
    }
  }
  if (!matchingQueries.length) {
    env.ANALYTICS?.writeDataPoint({ indexes: [job.monitorId], blobs: ["relevance_rejected", job.payload.source], doubles: [0] });
    return;
  }

  let existingForCluster: Array<{ clusterId: string; simHash: string; title: string }> = [];
  const recentMentionsResponse = await stub.fetch("https://do.internal/internal/mentions?limit=50");
  if (recentMentionsResponse.ok) {
    const recent = await recentMentionsResponse.json() as {
      mentions?: Array<{ content_id?: string; simhash?: string | null; story_cluster_id?: string | null; title?: string | null }>;
    };
    existingForCluster = (recent.mentions ?? [])
      .filter((item) => typeof item.simhash === "string" && item.simhash)
      .map((item) => ({
        clusterId: (typeof item.story_cluster_id === "string" && item.story_cluster_id)
          ? item.story_cluster_id
          : (typeof item.content_id === "string" ? item.content_id : job.payload.contentId),
        simHash: item.simhash as string,
        title: typeof item.title === "string" ? item.title : ""
      }));
  }
  const storyClusterId = assignStoryCluster({
    contentId: job.payload.contentId,
    simHash: fingerprint.simHash,
    title,
    existing: existingForCluster
  });

  if (env.VECTORIZE) {
    try {
      await env.VECTORIZE.upsert(job.payload.contentId, embeddingReady(combined), {
        monitorId: job.monitorId,
        simHash: fingerprint.simHash,
        storyClusterId
      });
    } catch {
      // Optional binding — failures must not block the pipeline.
    }
  }

  let relevanceScore = 85;
  if (combined.toLocaleLowerCase().includes(monitorData.monitor.name.toLocaleLowerCase())) relevanceScore += 10;
  if (matchingQueries.length > 1) relevanceScore += 5;
  relevanceScore = Math.min(100, relevanceScore);
  const candidate = createJob<AiCandidatePayload>({
    source: job.payload.source,
    canonicalUrl: job.payload.canonicalUrl,
    contentId: job.payload.contentId,
    rawR2Key: job.payload.rawR2Key,
    fetchedAt: job.payload.fetchedAt,
    title,
    text: text.slice(0, 16_000),
    publishedAt: job.payload.publishedAt,
    monitorName: monitorData.monitor.name,
    relevanceScore,
    relevanceReason: `Matched ${matchingQueries.length} Boolean quer${matchingQueries.length === 1 ? "y" : "ies"}`,
    simHash: fingerprint.simHash,
    storyClusterId,
    contentHash: fingerprint.contentHash
  }, {
    traceId: job.traceId,
    tenantId: job.tenantId,
    monitorId: job.monitorId,
    priority: negativeHint(combined) ? "priority" : job.priority
  });
  const target = negativeHint(combined) ? env.AI_PRIORITY : env.AI_NORMAL;
  await target.send(candidate);
  env.ANALYTICS?.writeDataPoint({ indexes: [job.monitorId], blobs: ["relevance_accepted", job.payload.source], doubles: [relevanceScore] });
}

export default {
  async queue(batch: MessageBatch<JobEnvelope<ProcessPayload>>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processMessage(message, env);
        message.ack();
      } catch (error) {
        structuredLog("error", "processor_failed", { requestId: message.body.traceId, tenantId: message.body.tenantId, monitorId: message.body.monitorId }, {
          jobId: message.body.jobId,
          error: error instanceof Error ? error.message : "unknown"
        });
        message.retry();
      }
    }
  }
};
