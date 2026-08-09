import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  advanceNextScanAt,
  claimLeaseUntil,
  isClaimable,
  schedulerShardIndex,
  DEFAULT_SCHEDULER_SHARD_COUNT
} from "../packages/crawler-core/src/index.ts";
import { SchedulerShardDO } from "../workers/state/src/index.ts";

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

test("schedulerShardIndex is stable and bounded", async () => {
  const a = await schedulerShardIndex("tenant-alpha");
  const b = await schedulerShardIndex("tenant-alpha");
  const c = await schedulerShardIndex("tenant-beta");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(a >= 0 && a < DEFAULT_SCHEDULER_SHARD_COUNT);
  assert.ok(c >= 0 && c < DEFAULT_SCHEDULER_SHARD_COUNT);
  assert.equal(await schedulerShardIndex("x", 8), (await schedulerShardIndex("x", 8)));
  assert.ok((await schedulerShardIndex("x", 8)) < 8);
});

test("isClaimable and advanceNextScanAt helpers", () => {
  const now = "2026-08-09T05:00:00.000Z";
  assert.equal(isClaimable({ status: "active", nextScanAt: "2026-08-09T04:59:00.000Z", claimedUntil: null }, now), true);
  assert.equal(isClaimable({ status: "paused", nextScanAt: "2026-08-09T04:59:00.000Z", claimedUntil: null }, now), false);
  assert.equal(isClaimable({ status: "active", nextScanAt: "2026-08-09T05:01:00.000Z", claimedUntil: null }, now), false);
  assert.equal(isClaimable({
    status: "active",
    nextScanAt: "2026-08-09T04:59:00.000Z",
    claimedUntil: "2026-08-09T05:02:00.000Z"
  }, now), false);
  assert.equal(isClaimable({
    status: "active",
    nextScanAt: "2026-08-09T04:59:00.000Z",
    claimedUntil: "2026-08-09T04:59:59.000Z"
  }, now), true);

  const advanced = advanceNextScanAt("2026-08-09T04:50:00.000Z", 900, now);
  assert.equal(advanced, "2026-08-09T05:15:00.000Z");
  assert.equal(claimLeaseUntil(now, 120), "2026-08-09T05:02:00.000Z");
});

test("SchedulerShardDO claim advances next_scan_at and blocks double-claim within lease", async () => {
  const shard = new SchedulerShardDO(new FakeState(), {});
  const now = "2026-08-09T05:00:00.000Z";

  const upsert = await shard.fetch(new Request("https://do.internal/internal/upsert", {
    method: "POST",
    body: JSON.stringify({
      tenantId: "tenant-1",
      monitorId: "monitor-1",
      priority: "priority",
      status: "active",
      nextScanAt: "2026-08-09T04:00:00.000Z",
      scanIntervalSec: 600
    })
  }));
  assert.equal(upsert.status, 200);

  const first = await shard.fetch(new Request("https://do.internal/internal/claim", {
    method: "POST",
    body: JSON.stringify({ limit: 10, leaseSec: 120, now })
  }));
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.claimed.length, 1);
  assert.equal(firstBody.claimed[0].tenantId, "tenant-1");
  assert.equal(firstBody.claimed[0].monitorId, "monitor-1");
  assert.equal(firstBody.claimed[0].nextScanAt, "2026-08-09T05:10:00.000Z");
  assert.equal(firstBody.claimed[0].claimedUntil, "2026-08-09T05:02:00.000Z");

  const second = await shard.fetch(new Request("https://do.internal/internal/claim", {
    method: "POST",
    body: JSON.stringify({ limit: 10, leaseSec: 120, now: "2026-08-09T05:01:00.000Z" })
  }));
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.claimed.length, 0);

  const afterLease = await shard.fetch(new Request("https://do.internal/internal/claim", {
    method: "POST",
    body: JSON.stringify({ limit: 10, leaseSec: 120, now: "2026-08-09T05:10:00.000Z" })
  }));
  assert.equal(afterLease.status, 200);
  const afterLeaseBody = await afterLease.json();
  assert.equal(afterLeaseBody.claimed.length, 1);
  assert.equal(afterLeaseBody.claimed[0].nextScanAt, "2026-08-09T05:20:00.000Z");

  const stats = await shard.fetch(new Request("https://do.internal/internal/stats"));
  assert.equal(stats.status, 200);
  const statsBody = await stats.json();
  assert.equal(statsBody.total, 1);
  assert.equal(statsBody.active, 1);

  const remove = await shard.fetch(new Request("https://do.internal/internal/remove", {
    method: "POST",
    body: JSON.stringify({ tenantId: "tenant-1", monitorId: "monitor-1" })
  }));
  assert.equal(remove.status, 200);
  const statsAfter = await (await shard.fetch(new Request("https://do.internal/internal/stats"))).json();
  assert.equal(statsAfter.total, 0);
});
