import { idempotencyKey, type JobEnvelope } from "../../../packages/crawler-core/src/index.ts";
import { calculateSeverity, severityBand, type Sentiment } from "../../../packages/severity/src/index.ts";
import type { SourceType } from "../../../packages/source-adapters/src/index.ts";
import { structuredLog } from "../../../packages/observability/src/index.ts";

interface AiCandidatePayload {
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
}

interface AlertPayload {
  alertId: string;
  mentionId: string;
  tenantId: string;
  monitorId: string;
  monitorName: string;
  canonicalUrl: string;
  title: string;
  excerpt: string;
  severityScore: number;
  severity: string;
  reason: string;
}

interface Env {
  AI: Ai;
  MONITOR_DO: DurableObjectNamespace;
  ALERTS: Queue<JobEnvelope<AlertPayload>>;
  ANALYTICS?: AnalyticsEngineDataset;
  SENTIMENT_MODEL?: string;
}

interface Classification {
  sentiment: Sentiment;
  confidence: number;
  topic: string;
  reason: string;
  riskCategories: string[];
  language: string;
}

const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

function monitorStub(env: Env, tenantId: string, monitorId: string): DurableObjectStub {
  return env.MONITOR_DO.get(env.MONITOR_DO.idFromName(`${tenantId}:${monitorId}`));
}

function fallbackClassification(text: string): Classification {
  const lower = text.toLocaleLowerCase();
  const negativeTerms = ["scam", "fraud", "lừa đảo", "không hoàn tiền", "chưa hoàn tiền", "tố cáo", "khiếu nại", "data leak", "breach", "tẩy chay", "outage"];
  const positiveTerms = ["tốt", "tuyệt vời", "excellent", "great", "recommend", "hài lòng", "cam on", "cảm ơn"];
  const negative = negativeTerms.filter((term) => lower.includes(term));
  const positive = positiveTerms.filter((term) => lower.includes(term));
  const sentiment: Sentiment = negative.length > positive.length ? "negative" : positive.length > negative.length ? "positive" : "neutral";
  const risks: string[] = [];
  if (lower.includes("scam") || lower.includes("lừa đảo") || lower.includes("fraud")) risks.push("fraud");
  if (lower.includes("data leak") || lower.includes("breach") || lower.includes("rò rỉ dữ liệu")) risks.push("data_leak");
  if (lower.includes("hoàn tiền") || lower.includes("refund")) risks.push("refund");
  if (lower.includes("outage") || lower.includes("sập")) risks.push("outage");
  return { sentiment, confidence: sentiment === "neutral" ? 0.45 : 0.62, topic: "unclassified", reason: "Deterministic fallback classifier", riskCategories: risks, language: "unknown" };
}

function normalizeClassification(value: unknown): Classification | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (data.sentiment !== "positive" && data.sentiment !== "neutral" && data.sentiment !== "negative") return null;
  const confidence = typeof data.confidence === "number" ? Math.max(0, Math.min(1, data.confidence)) : 0.5;
  return {
    sentiment: data.sentiment,
    confidence,
    topic: typeof data.topic === "string" ? data.topic.slice(0, 120) : "unclassified",
    reason: typeof data.reason === "string" ? data.reason.slice(0, 1000) : "No explanation",
    riskCategories: Array.isArray(data.riskCategories) ? data.riskCategories.filter((item): item is string => typeof item === "string").slice(0, 10) : [],
    language: typeof data.language === "string" ? data.language.slice(0, 32) : "unknown"
  };
}

async function classify(env: Env, payload: AiCandidatePayload): Promise<{ classification: Classification; model: string; fallback: boolean }> {
  const model = env.SENTIMENT_MODEL ?? DEFAULT_MODEL;
  try {
    const result = await env.AI.run(model, {
      messages: [
        {
          role: "system",
          content: "Classify sentiment specifically toward the monitored entity. Return strict JSON only. Do not infer allegations not present in the text. Risk categories may include fraud, scam, legal, security_incident, data_leak, physical_safety, executive_misconduct, outage, boycott, media_investigation, refund, customer_service."
        },
        {
          role: "user",
          content: `Monitored entity: ${payload.monitorName}\nTitle: ${payload.title}\nContent: ${payload.text}`
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "mention_classification",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              topic: { type: "string" },
              reason: { type: "string" },
              riskCategories: { type: "array", items: { type: "string" } },
              language: { type: "string" }
            },
            required: ["sentiment", "confidence", "topic", "reason", "riskCategories", "language"]
          }
        }
      },
      max_tokens: 450,
      temperature: 0
    });
    const raw = result as Record<string, unknown>;
    const candidate = typeof raw.response === "string" ? JSON.parse(raw.response) : raw.response ?? raw;
    const normalized = normalizeClassification(candidate);
    if (!normalized) throw new Error("invalid_ai_shape");
    return { classification: normalized, model, fallback: false };
  } catch {
    return { classification: fallbackClassification(`${payload.title}\n${payload.text}`), model: "deterministic-fallback-v1", fallback: true };
  }
}

async function processMessage(message: Message<JobEnvelope<AiCandidatePayload>>, env: Env): Promise<void> {
  const job = message.body;
  if (!job.tenantId || !job.monitorId) throw new Error("missing_tenant_or_monitor");
  const stub = monitorStub(env, job.tenantId, job.monitorId);
  const existing = await stub.fetch(`https://do.internal/internal/mentions/exists/${encodeURIComponent(job.payload.contentId)}`);
  if (existing.ok && ((await existing.json()) as { exists: boolean }).exists) return;

  const { classification, model, fallback } = await classify(env, job.payload);
  const severityScore = calculateSeverity({
    sentiment: classification.sentiment,
    sentimentConfidence: classification.confidence,
    relevanceScore: job.payload.relevanceScore,
    riskCategories: classification.riskCategories
  });
  const excerpt = job.payload.text.replace(/\s+/g, " ").slice(0, 600);
  const write = await stub.fetch("https://do.internal/internal/mentions/upsert", {
    method: "POST",
    body: JSON.stringify({
      contentId: job.payload.contentId,
      canonicalUrl: job.payload.canonicalUrl,
      source: job.payload.source,
      title: job.payload.title,
      excerpt,
      publishedAt: job.payload.publishedAt,
      discoveredAt: job.payload.fetchedAt,
      relevanceScore: job.payload.relevanceScore,
      sentiment: classification.sentiment,
      sentimentConfidence: classification.confidence,
      severityScore,
      topic: classification.topic,
      language: classification.language,
      rawR2Key: job.payload.rawR2Key,
      relevanceReason: job.payload.relevanceReason,
      sentimentReason: classification.reason,
      severityReason: `Severity ${severityScore}/100 from target-aware sentiment and ${classification.riskCategories.length} risk categories`,
      riskCategories: classification.riskCategories,
      aiModel: model,
      aiVersion: "v1"
    })
  });
  if (!write.ok) throw new Error("mention_write_failed");
  const result = await write.json() as { mentionId: string; created: boolean };
  if (!result.created) return;

  if (classification.sentiment === "negative" && severityScore >= 60) {
    const band = severityBand(severityScore);
    const dedupeKey = await idempotencyKey([job.monitorId, job.payload.contentId, "negative-v1"]);
    const alertWrite = await stub.fetch("https://do.internal/internal/alerts/upsert", {
      method: "POST",
      body: JSON.stringify({ mentionId: result.mentionId, type: "negative_mention", severity: band, dedupeKey, reason: classification.reason })
    });
    if (alertWrite.ok) {
      const alertResult = await alertWrite.json() as { alertId: string; created: boolean };
      if (alertResult.created) {
        await env.ALERTS.send({
          schemaVersion: 1,
          jobId: crypto.randomUUID(),
          traceId: job.traceId,
          tenantId: job.tenantId,
          monitorId: job.monitorId,
          priority: severityScore >= 76 ? "emergency" : "priority",
          createdAt: new Date().toISOString(),
          attempt: 0,
          payload: {
            alertId: alertResult.alertId,
            mentionId: result.mentionId,
            tenantId: job.tenantId,
            monitorId: job.monitorId,
            monitorName: job.payload.monitorName,
            canonicalUrl: job.payload.canonicalUrl,
            title: job.payload.title,
            excerpt,
            severityScore,
            severity: band,
            reason: classification.reason
          }
        });
      }
    }
  }
  env.ANALYTICS?.writeDataPoint({ indexes: [job.monitorId], blobs: [classification.sentiment, model, fallback ? "fallback" : "ai"], doubles: [classification.confidence, severityScore] });
}

export default {
  async queue(batch: MessageBatch<JobEnvelope<AiCandidatePayload>>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processMessage(message, env);
        message.ack();
      } catch (error) {
        structuredLog("error", "ai_classifier_failed", { requestId: message.body.traceId, tenantId: message.body.tenantId, monitorId: message.body.monitorId }, {
          jobId: message.body.jobId,
          error: error instanceof Error ? error.message : "unknown"
        });
        message.retry();
      }
    }
  }
};
