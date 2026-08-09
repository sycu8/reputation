# Codex Prompt — Phase 6: Relevance and Deduplication

You are a senior information-retrieval engineer.

## Objective

Reduce noise before expensive sentiment/deep-AI processing.

## Build

- canonical Boolean post-fetch evaluation
- deterministic relevance signals
- entity/context relevance scoring
- URL normalization hash
- exact content hash
- near-duplicate fingerprint (SimHash/MinHash or justified alternative)
- optional Vectorize abstraction, disabled by default unless configured
- global-content versus tenant-mention ownership
- feedback persistence: relevant/not relevant

## Design target

A page is fetched/stored once globally but can produce multiple tenant-specific mentions. Never expose tenant A's monitor/analysis state to tenant B.

## Tests

- same canonical URL with tracking params collapses
- syndicated/near-identical fixture is grouped or marked duplicate
- same-name unrelated fixture is rejected
- one raw content object matches two independent monitors without duplicate blob storage
- feedback is auditable and affects future scoring only through explicit versioned logic
