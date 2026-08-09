import test from "node:test";
import assert from "node:assert/strict";
import { calculateSeverity, severityBand } from "../packages/severity/src/index.ts";

test("non-negative content cannot become critical from keywords alone", () => {
  assert.equal(calculateSeverity({ sentiment: "neutral", sentimentConfidence: 1, relevanceScore: 100, riskCategories: ["fraud", "data_leak"] }), 0);
  assert.equal(severityBand(0), "low");
});

test("high-confidence negative risk categories increase severity", () => {
  const score = calculateSeverity({
    sentiment: "negative",
    sentimentConfidence: 0.96,
    relevanceScore: 98,
    riskCategories: ["fraud", "refund"]
  });
  assert.ok(score >= 76);
  assert.equal(severityBand(score), "critical");
});
