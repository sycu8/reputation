import type { JobEnvelope } from "../../../packages/crawler-core/src/index.ts";
import { structuredLog } from "../../../packages/observability/src/index.ts";
import {
  decideChannelActions,
  summarizeDeliveryOutcomes,
  type DeliveryChannel,
  type DeliveryStatus
} from "./delivery.ts";

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

interface NotificationConfig {
  email?: string | undefined;
  telegramChatId?: string | undefined;
}

interface Env {
  MONITOR_DO: DurableObjectNamespace;
  NOTIFY_CONFIG: KVNamespace;
  EMAIL?: SendEmail;
  ALERT_FROM_EMAIL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  ANALYTICS?: AnalyticsEngineDataset;
}

function monitorStub(env: Env, tenantId: string, monitorId: string): DurableObjectStub {
  return env.MONITOR_DO.get(env.MONITOR_DO.idFromName(`${tenantId}:${monitorId}`));
}

async function updateAlert(env: Env, payload: AlertPayload, state: string): Promise<void> {
  await monitorStub(env, payload.tenantId, payload.monitorId).fetch(`https://do.internal/internal/alerts/${payload.alertId}`, {
    method: "PATCH",
    body: JSON.stringify({ state })
  });
}

async function loadConfig(env: Env, tenantId: string): Promise<NotificationConfig> {
  const raw = await env.NOTIFY_CONFIG.get(`notify:${tenantId}`);
  if (!raw) return {};
  try { return JSON.parse(raw) as NotificationConfig; } catch { return {}; }
}

async function listDeliveries(env: Env, payload: AlertPayload): Promise<Array<{ channel: string; status: string; attempt?: number }>> {
  const response = await monitorStub(env, payload.tenantId, payload.monitorId).fetch(
    `https://do.internal/internal/alerts/${encodeURIComponent(payload.alertId)}/deliveries`
  );
  if (!response.ok) return [];
  const data = await response.json() as { deliveries?: Array<{ channel: string; status: string; attempt?: number }> };
  return data.deliveries ?? [];
}

async function upsertDelivery(
  env: Env,
  payload: AlertPayload,
  input: { channel: DeliveryChannel; status: DeliveryStatus; providerRef?: string; attempt?: number; error?: string }
): Promise<void> {
  await monitorStub(env, payload.tenantId, payload.monitorId).fetch("https://do.internal/internal/alerts/deliveries/upsert", {
    method: "POST",
    body: JSON.stringify({
      alertId: payload.alertId,
      channel: input.channel,
      status: input.status,
      providerRef: input.providerRef,
      attempt: input.attempt,
      error: input.error
    })
  });
}

function emailHtml(payload: AlertPayload): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
  return `<h2>Negative mention detected</h2><p><strong>${escape(payload.monitorName)}</strong> · ${escape(payload.severity.toUpperCase())} · ${payload.severityScore}/100</p><p>${escape(payload.reason)}</p><blockquote>${escape(payload.excerpt)}</blockquote><p><a href="${escape(payload.canonicalUrl)}">View source</a></p>`;
}

async function sendEmail(env: Env, config: NotificationConfig, payload: AlertPayload): Promise<{ ok: boolean; providerRef?: string }> {
  if (!env.EMAIL || !env.ALERT_FROM_EMAIL || !config.email) return { ok: false };
  await env.EMAIL.send({
    from: env.ALERT_FROM_EMAIL,
    to: config.email,
    subject: `[${payload.severity.toUpperCase()}] Negative mention: ${payload.monitorName}`,
    text: `Negative mention detected for ${payload.monitorName}\nSeverity: ${payload.severityScore}/100\n${payload.reason}\n${payload.excerpt}\n${payload.canonicalUrl}`,
    html: emailHtml(payload)
  });
  return { ok: true, providerRef: `email:${config.email}` };
}

async function sendTelegram(env: Env, config: NotificationConfig, payload: AlertPayload): Promise<{ ok: boolean; providerRef?: string }> {
  if (!env.TELEGRAM_BOT_TOKEN || !config.telegramChatId) return { ok: false };
  const text = `🔴 ${payload.severity.toUpperCase()} negative mention\n${payload.monitorName} · ${payload.severityScore}/100\n\n${payload.reason}\n\n${payload.excerpt.slice(0, 700)}\n\n${payload.canonicalUrl}`;
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: config.telegramChatId, text, disable_web_page_preview: false }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`telegram_http_${response.status}`);
  return { ok: true, providerRef: `telegram:${config.telegramChatId}` };
}

async function processMessage(message: Message<JobEnvelope<AlertPayload>>, env: Env): Promise<void> {
  const payload = message.body.payload;
  const config = await loadConfig(env, payload.tenantId);
  const existing = await listDeliveries(env, payload);
  const emailConfigured = Boolean(env.EMAIL && env.ALERT_FROM_EMAIL && config.email);
  const telegramConfigured = Boolean(env.TELEGRAM_BOT_TOKEN && config.telegramChatId);
  const decisions = decideChannelActions(
    [
      { channel: "email", configured: emailConfigured },
      { channel: "telegram", configured: telegramConfigured }
    ],
    existing
  );

  const results: Array<{ channel: DeliveryChannel; status: DeliveryStatus }> = [];
  for (const decision of decisions) {
    if (decision.action === "skip") {
      if (decision.reason === "already_sent") {
        results.push({ channel: decision.channel, status: "sent" });
        continue;
      }
      if (decision.reason === "not_configured") {
        await upsertDelivery(env, payload, {
          channel: decision.channel,
          status: "skipped",
          error: "not_configured"
        });
        results.push({ channel: decision.channel, status: "skipped" });
      }
      continue;
    }

    try {
      const outcome = decision.channel === "email"
        ? await sendEmail(env, config, payload)
        : await sendTelegram(env, config, payload);
      if (!outcome.ok) {
        await upsertDelivery(env, payload, {
          channel: decision.channel,
          status: "failed",
          error: "send_returned_false"
        });
        results.push({ channel: decision.channel, status: "failed" });
        continue;
      }
      await upsertDelivery(env, payload, {
        channel: decision.channel,
        status: "sent",
        ...(outcome.providerRef ? { providerRef: outcome.providerRef } : {})
      });
      results.push({ channel: decision.channel, status: "sent" });
    } catch (error) {
      await upsertDelivery(env, payload, {
        channel: decision.channel,
        status: "failed",
        error: error instanceof Error ? error.message : "send_failed"
      });
      results.push({ channel: decision.channel, status: "failed" });
    }
  }

  const configuredChannels: DeliveryChannel[] = [];
  if (emailConfigured) configuredChannels.push("email");
  if (telegramConfigured) configuredChannels.push("telegram");
  const summary = summarizeDeliveryOutcomes({ configuredChannels, results });
  await updateAlert(env, payload, summary.alertState);
  if (summary.alertState === "failed") {
    throw new Error(summary.reason);
  }
  env.ANALYTICS?.writeDataPoint({
    indexes: [payload.monitorId],
    blobs: ["alert_sent", payload.severity, summary.reason],
    doubles: [payload.severityScore, summary.sentCount]
  });
}

export default {
  async queue(batch: MessageBatch<JobEnvelope<AlertPayload>>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processMessage(message, env);
        message.ack();
      } catch (error) {
        structuredLog("error", "alert_delivery_failed", { requestId: message.body.traceId, tenantId: message.body.tenantId, monitorId: message.body.monitorId }, {
          alertId: message.body.payload.alertId,
          error: error instanceof Error ? error.message : "unknown"
        });
        message.retry({ delaySeconds: 60 });
      }
    }
  }
};

export { decideChannelActions, summarizeDeliveryOutcomes } from "./delivery.ts";
