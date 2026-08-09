# Codex Prompt — Phase 10: Social Source Adapters

You are a senior integrations engineer. This phase is capability-driven and policy-sensitive.

## Objective

Implement the source-adapter framework for YouTube, X, Reddit, TikTok, Facebook/Instagram, and LinkedIn according to `docs/SOURCE_COVERAGE_MATRIX.md`.

## Critical rule

Do not pretend every source has open commercial keyword search. Implement real live integrations only when credentials/access in the environment support them. Otherwise implement the complete adapter contract, capability state, fixtures, health reporting, and a clean `contract_required`, `degraded`, or `disabled` runtime state.

## Source priorities

### YouTube

Prefer official YouTube Data API keyword search and enrichment.

### X

Prefer official recent-search API and provider-native query compilation where supported.

### Reddit

Use approved/contracted Data API access only. Commercial usage requirements must be configurable/documented.

### TikTok

Do not use Research API as proof of commercial realtime coverage. Treat commercial keyword monitoring as contract/licensed-provider dependent unless approved access specifically supports the product.

### Meta Facebook/Instagram

Support approved/authorized capabilities. Do not assume arbitrary site-wide public keyword search.

### LinkedIn

Support approved organization/community-management flows where available. Do not assume arbitrary member post search.

## Browser policy

Browser Run may render a public URL discovered through a permitted channel when policy allows. It must not be used to bypass authentication, CAPTCHA, or API authorization restrictions.

## Required implementation

For every adapter:

- capability object
- discovery implementation or explicit unavailable state
- collection implementation or explicit unavailable state
- provider query compiler
- cursor/state model
- fixtures
- health metrics
- backoff/rate limit handling
- field normalization
- source-specific attribution/retention hooks where required

## Acceptance

The system can run with any subset of sources enabled. Disabled/contract-required sources never break a monitor scan and never silently report full coverage.
