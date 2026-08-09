import test from "node:test";
import assert from "node:assert/strict";
import {
  decideChannelActions,
  summarizeDeliveryOutcomes
} from "../workers/alerts/src/delivery.ts";
import { MonitorDO } from "../workers/state/src/index.ts";
import { DatabaseSync } from "node:sqlite";

test("idempotent channel decisions skip already-sent deliveries", () => {
  const decisions = decideChannelActions(
    [
      { channel: "email", configured: true },
      { channel: "telegram", configured: true }
    ],
    [{ channel: "email", status: "sent", attempt: 1 }]
  );
  assert.deepEqual(decisions, [
    { channel: "email", action: "skip", reason: "already_sent" },
    { channel: "telegram", action: "send" }
  ]);
});

test("unconfigured channels are skipped and summary fails without any channel", () => {
  const decisions = decideChannelActions(
    [
      { channel: "email", configured: false },
      { channel: "telegram", configured: false }
    ],
    []
  );
  assert.equal(decisions.every((item) => item.action === "skip"), true);
  const summary = summarizeDeliveryOutcomes({
    configuredChannels: [],
    results: [
      { channel: "email", status: "skipped" },
      { channel: "telegram", status: "skipped" }
    ]
  });
  assert.equal(summary.alertState, "failed");
  assert.equal(summary.reason, "no_channels_configured");
});

test("summary marks sent when at least one configured channel succeeded", () => {
  const summary = summarizeDeliveryOutcomes({
    configuredChannels: ["email", "telegram"],
    results: [
      { channel: "email", status: "sent" },
      { channel: "telegram", status: "failed" }
    ]
  });
  assert.equal(summary.alertState, "sent");
  assert.equal(summary.sentCount, 1);
  assert.equal(summary.failedCount, 1);
});

test("summary fails when all configured channels failed", () => {
  const summary = summarizeDeliveryOutcomes({
    configuredChannels: ["email"],
    results: [{ channel: "email", status: "failed" }]
  });
  assert.equal(summary.alertState, "failed");
  assert.equal(summary.reason, "all_configured_channels_failed");
});

class SqlAdapter {
  constructor() {
    this.db = new DatabaseSync(":memory:");
  }
  exec(query, ...bindings) {
    const statement = this.db.prepare(query);
    const trimmed = query.trim().toUpperCase();
    let values = [];
    if (trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA") || trimmed.includes(" RETURNING ")) {
      values = statement.all(...bindings);
    } else {
      statement.run(...bindings);
    }
    return {
      toArray: () => values,
      [Symbol.iterator]: function* () { yield* values; }
    };
  }
}

class FakeState {
  constructor() {
    const sql = new SqlAdapter();
    this.storage = {
      sql,
      transaction: async (closure) => closure()
    };
  }
}

test("MonitorDO alert delivery upsert is unique per alert+channel", async () => {
  const monitor = new MonitorDO(new FakeState(), {});
  await monitor.fetch(new Request("https://do.internal/internal/init", {
    method: "POST",
    body: JSON.stringify({ id: "m1", tenantId: "t1", name: "Acme", type: "company" })
  }));
  const alertCreate = await monitor.fetch(new Request("https://do.internal/internal/alerts/upsert", {
    method: "POST",
    body: JSON.stringify({ dedupeKey: "d1", type: "negative_mention", severity: "high", mentionId: "n1" })
  }));
  const { alertId } = await alertCreate.json();

  const first = await monitor.fetch(new Request("https://do.internal/internal/alerts/deliveries/upsert", {
    method: "POST",
    body: JSON.stringify({ alertId, channel: "email", status: "sent", providerRef: "email:a@example.com", attempt: 1 })
  }));
  assert.equal(first.status, 201);

  const second = await monitor.fetch(new Request("https://do.internal/internal/alerts/deliveries/upsert", {
    method: "POST",
    body: JSON.stringify({ alertId, channel: "email", status: "failed", error: "retry_noise", attempt: 2 })
  }));
  assert.equal(second.status, 200);
  const updated = await second.json();
  assert.equal(updated.updated, true);
  assert.equal(updated.attempt, 2);

  const detail = await monitor.fetch(new Request(`https://do.internal/internal/alerts/${alertId}`));
  const body = await detail.json();
  assert.equal(body.deliveries.length, 1);
  assert.equal(body.deliveries[0].status, "failed");
  assert.equal(body.deliveries[0].channel, "email");
});
