import test from "node:test";
import assert from "node:assert/strict";
import {
  assignStoryCluster,
  contentFingerprint,
  embeddingReady,
  hammingDistance64,
  isNearDuplicate,
  simHash64,
  simHashFromHex,
  simHashToHex
} from "../packages/dedupe/src/index.ts";

test("simHash is stable for identical text", () => {
  const a = simHash64("Acme refund delay complaint from customers");
  const b = simHash64("Acme refund delay complaint from customers");
  assert.equal(a, b);
  assert.equal(simHashToHex(a).length, 16);
});

test("near-duplicate texts have small hamming distance", () => {
  const a = simHash64(
    "Breaking: Acme Payments customers report refused refunds after account cancellation across multiple regions this week"
  );
  const b = simHash64(
    "Breaking: Acme Payments customers report refused refunds after account cancellation across multiple regions this week."
  );
  assert.ok(hammingDistance64(a, b) <= 3);
  assert.equal(isNearDuplicate(a, b), true);
  const c = simHash64(
    "Breaking: Acme Payments customers report refused refund after account cancellation across multiple regions this week"
  );
  assert.ok(hammingDistance64(a, c) <= 8);
  assert.equal(isNearDuplicate(a, c, 8), true);
});

test("unrelated texts are not near-duplicates", () => {
  const a = simHash64("Acme refund delay complaint from customers in Hanoi");
  const b = simHash64("Tonight's football match ended with a late equalizer");
  assert.equal(isNearDuplicate(a, b, 3), false);
});

test("contentFingerprint returns sha256 and simhash hex", () => {
  const fp = contentFingerprint("  Hello World!! Hello ");
  assert.match(fp.contentHash, /^[0-9a-f]{64}$/);
  assert.match(fp.simHash, /^[0-9a-f]{16}$/);
  assert.equal(fp.simHash, simHashToHex(simHash64("  Hello World!! Hello ")));
  assert.equal(contentFingerprint("Hello World Hello").contentHash, fp.contentHash);
});

test("assignStoryCluster joins near-dupe or high title overlap", () => {
  const baseText = "Acme bank outage affects card payments nationwide today";
  const simHash = simHashToHex(simHash64(baseText));
  const joined = assignStoryCluster({
    contentId: "content-b",
    simHash,
    title: "Acme bank outage affects card payments",
    existing: [{ clusterId: "cluster-a", simHash, title: "Acme bank outage affects card payments nationwide" }]
  });
  assert.equal(joined, "cluster-a");

  const fresh = assignStoryCluster({
    contentId: "content-c",
    simHash: simHashToHex(simHash64("Completely different gardening tips for spring")),
    title: "Gardening tips for spring vegetables",
    existing: [{ clusterId: "cluster-a", simHash, title: "Acme bank outage affects card payments nationwide" }]
  });
  assert.equal(fresh, "content-c");
});

test("embeddingReady returns fixed 64-dim unit-ish vector", () => {
  const values = embeddingReady("token bag of words for vectorize placeholder");
  assert.equal(values.length, 64);
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9);
  assert.equal(simHashFromHex(simHashToHex(1n)), 1n);
});
