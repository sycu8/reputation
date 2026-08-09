import type { JobEnvelope } from "../../../packages/crawler-core/src/index.ts";
import { structuredLog } from "../../../packages/observability/src/index.ts";

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

function emailHtml(payload: AlertPayload): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
  return `<h2>Negative mention detected</h2><p><strong>${escape(payload.monitorName)}</strong> · ${escape(payload.severity.toUpperCase())} · ${payload.severityScore}/100</p><p>${escape(payload.reason)}</p><blockquote>${escape(payload.excerpt)}</blockquote><p><a href="${escape(payload.canonicalUrl)}">View source</a></p>`;
}

async function sendEmail(env: Env, config: NotificationConfig, payload: AlertPayload): Promise<boolean> {
  if (!env.EMAIL || !env.ALERT_FROM_EMAIL || !config.email) return false;
  await env.EMAIL.send({
    from: env.ALERT_FROM_EMAIL,
    to: config.email,
    subject: `[${payload.severity.toUpperCase()}] Negative mention: ${payload.monitorName}`,
    text: `Negative mention detected for ${payload.monitorName}\nSeverity: ${payload.severityScore}/100\n${payload.reason}\n${payload.excerpt}\n${payload.canonicalUrl}`,
    html: emailHtml(payload)
  });
  return true;
}

async function sendTelegram(env: Env, config: NotificationConfig, payload: AlertPayload): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN || !config.telegramChatId) return false;
  const text = `🔴 ${payload.severity.toUpperCase()} negative mention\n${payload.monitorName} · ${payload.severityScore}/100\n\n${payload.reason}\n\n${payload.excerpt.slice(0, 700)}\n\n${payload.canonicalUrl}`;
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: config.telegramChatId, text, disable_web_page_preview: false }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`telegram_http_${response.status}`);
  return true;
}

async function processMessage(message: Message<JobEnvelope<AlertPayload>>, env: Env): Promise<void> {
  const payload = message.body.payload;
  const config = await loadConfig(env, payload.tenantId);
  const outcomes = await Promise.allSettled([
    sendEmail(env, config, payload),
    sendTelegram(env, config, payload)
  ]);
  const sentCount = outcomes.filter((outcome) => outcome.status === "fulfilled" && outcome.value).length;
  if (!sentCount) {
    await updateAlert(env, payload, "failed");
    throw new Error("no_notification_channel_succeeded");
  }
  await updateAlert(env, payload, "sent");
  env.ANALYTICS?.writeDataPoint({ indexes: [payload.monitorId], blobs: ["alert_sent", payload.severity], doubles: [payload.severityScore, sentCount] });
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
