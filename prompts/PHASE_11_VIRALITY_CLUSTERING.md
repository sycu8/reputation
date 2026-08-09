# Codex Prompt — Phase 11: Virality and Story Clustering

You are a senior ranking/stream-processing engineer.

## Objective

Detect rapidly growing negative conversations and group duplicate/syndicated mentions into story clusters.

## Build

- engagement snapshots
- source-aware metric normalization
- velocity and acceleration features
- cluster candidate generation
- deterministic + semantic clustering strategy
- primary/canonical story selection
- cluster severity aggregation
- cluster-aware alert deduplication

## Constraints

- Missing engagement is not zero engagement.
- Do not compare unlike metrics without source normalization.
- Avoid expensive all-pairs similarity; use hashes/blocking/vector nearest-neighbor as appropriate.
- Store algorithm/model version for reproducibility.

## Acceptance

- fixture with 10 copies of one article becomes one story cluster
- rapidly rising engagement raises priority without automatically changing sentiment
- one story produces one primary alert plus updates, not notification spam
