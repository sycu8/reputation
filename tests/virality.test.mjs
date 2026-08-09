import test from "node:test";
import assert from "node:assert/strict";
import { calculateSeverity } from "../packages/severity/src/index.ts";
import { computeViralityScore, engagementVelocity, shouldClusterAlert } from "../packages/virality/src/index.ts";

test("computeViralityScore stays in 0-100 and ignores missing metrics", () => {
  assert.equal(computeViralityScore({ ageMinutes: 60 }), 0);
  const score = computeViralityScore({ likes: 40, comments: 12, shares: 8, ageMinutes: 30 });
  assert.ok(score >= 0 && score <= 100);
  const hotter = computeViralityScore({ likes: 400, comments: 120, shares: 80, ageMinutes: 30 });
  assert.ok(hotter > score);
  assert.ok(hotter <= 100);
});

test("engagementVelocity averages per-hour deltas", () => {
  const velocity = engagementVelocity([
    { at: "2026-08-09T00:00:00.000Z", engagement: 10 },
    { at: "2026-08-09T01:00:00.000Z", engagement: 40 },
    { at: "2026-08-09T03:00:00.000Z", engagement: 100 }
  ]);
  // (30/h + 30/h) / 2 = 30
  assert.equal(velocity, 30);
  assert.equal(engagementVelocity([{ at: "2026-08-09T00:00:00.000Z", engagement: 10 }]), 0);
});

test("shouldClusterAlert gates on severity, virality, and cluster size", () => {
  assert.equal(shouldClusterAlert(40, 90, 10), false);
  assert.equal(shouldClusterAlert(65, 20, 3), true);
  assert.equal(shouldClusterAlert(58, 75, 1), true);
  assert.equal(shouldClusterAlert(62, 45, 2), true);
  assert.equal(shouldClusterAlert(55, 30, 1), false);
});

test("severity accepts optional viralityScore boost", () => {
  const base = calculateSeverity({
    sentiment: "negative",
    sentimentConfidence: 0.8,
    relevanceScore: 80,
    riskCategories: ["refund"]
  });
  const boosted = calculateSeverity({
    sentiment: "negative",
    sentimentConfidence: 0.8,
    relevanceScore: 80,
    riskCategories: ["refund"],
    viralityScore: 90
  });
  assert.ok(boosted > base);
  assert.ok(boosted <= 100);
});
