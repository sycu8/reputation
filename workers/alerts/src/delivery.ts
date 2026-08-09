export type DeliveryChannel = "email" | "telegram";
export type DeliveryStatus = "pending" | "sent" | "failed" | "skipped";

export interface DeliveryReceipt {
  channel: string;
  status: string;
  attempt?: number;
}

export interface ChannelPlan {
  channel: DeliveryChannel;
  configured: boolean;
}

export interface ChannelDecision {
  channel: DeliveryChannel;
  action: "send" | "skip";
  reason?: string;
}

export interface DeliverySummary {
  alertState: "sent" | "failed";
  reason: string;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  configuredCount: number;
}

/** Skip channels already marked sent so retries remain idempotent. */
export function decideChannelActions(
  channels: ChannelPlan[],
  existing: DeliveryReceipt[]
): ChannelDecision[] {
  const sent = new Set(
    existing.filter((item) => item.status === "sent").map((item) => item.channel)
  );
  return channels.map((item) => {
    if (sent.has(item.channel)) {
      return { channel: item.channel, action: "skip" as const, reason: "already_sent" };
    }
    if (!item.configured) {
      return { channel: item.channel, action: "skip" as const, reason: "not_configured" };
    }
    return { channel: item.channel, action: "send" as const };
  });
}

export function summarizeDeliveryOutcomes(input: {
  configuredChannels: DeliveryChannel[];
  results: Array<{ channel: DeliveryChannel; status: DeliveryStatus }>;
}): DeliverySummary {
  const configuredCount = input.configuredChannels.length;
  const relevant = input.results.filter((item) => input.configuredChannels.includes(item.channel));
  const sentCount = relevant.filter((item) => item.status === "sent").length;
  const failedCount = relevant.filter((item) => item.status === "failed").length;
  const skippedCount = relevant.filter((item) => item.status === "skipped").length;

  if (configuredCount === 0) {
    return {
      alertState: "failed",
      reason: "no_channels_configured",
      sentCount: 0,
      failedCount: 0,
      skippedCount,
      configuredCount: 0
    };
  }
  if (sentCount > 0) {
    return {
      alertState: "sent",
      reason: "at_least_one_channel_sent",
      sentCount,
      failedCount,
      skippedCount,
      configuredCount
    };
  }
  return {
    alertState: "failed",
    reason: "all_configured_channels_failed",
    sentCount,
    failedCount,
    skippedCount,
    configuredCount
  };
}
