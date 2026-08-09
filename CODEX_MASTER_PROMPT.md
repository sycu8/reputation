# Codex Master Build Prompt

You are the lead senior engineer responsible for building a production-ready multi-tenant social listening SaaS on Cloudflare.

Before doing anything, read these files completely:

- `AGENTS.md`
- `docs/TECHNICAL_SPEC.md`
- `docs/DATA_MODEL.md`
- `docs/CRAWLER_AND_SOURCES.md`
- `docs/QUEUE_CONTRACTS.md`
- `docs/SRE_RUNBOOK.md`
- `docs/IMPLEMENTATION_ROADMAP.md`

Treat them as the product and architecture source of truth.

## Objective

Build the platform incrementally according to `docs/IMPLEMENTATION_ROADMAP.md`.

The product is a professional social listening SaaS for individuals and businesses. Users create monitors from keywords and Boolean queries. The system continuously discovers public mentions across web/news/RSS/forums/blogs and supported social sources, crawls/scrapes them using Cloudflare Workers and Browser Run/Browser Rendering where needed, determines relevance, classifies target-aware sentiment, scores negative severity, and alerts customers about important negative mentions with a P95 target below 15 minutes.

## Cloudflare constraints

The deployment must remain Cloudflare-native:

- Cloudflare Workers for compute/API/background workers.
- Cloudflare Browser Run / Browser Rendering for dynamic-page browser crawling.
- SQLite-backed Durable Objects for strongly consistent operational shards.
- R2 for raw content/media/reports/exports.
- Queues + DLQs for asynchronous workloads and retries.
- Workflows for durable coarse-grained multi-step orchestration.
- KV only for read-heavy config/cache where eventual consistency is acceptable.
- Workers AI for cheap-first inference.
- Vectorize only where semantic dedupe/clustering/relevance helps.
- Analytics Engine / structured logs for telemetry.

Never introduce an external primary database unless the user explicitly changes the architecture.

## Non-negotiables

- Multi-tenant from the first commit.
- Never create one global Durable Object as the database.
- Never use KV as transactional state.
- Never store large raw HTML/media inside Durable Objects.
- Never use Browser Run for pages that direct fetch handles correctly.
- Never design CAPTCHA bypass, private-account access, login scraping, or bot-control circumvention.
- Every queue consumer must be idempotent.
- Every external fetch must be bounded by timeout, retry policy, SSRF protections, redirect validation, and domain coordination.
- Keep source adapters independent and capability-driven.
- Keep raw canonical content separate from tenant-specific mention analysis.
- Preserve the `crawl once, match many` strategy.
- Keep the High/Critical negative candidate path prioritized so it cannot be starved by normal traffic.
- Do not invent fake integrations. If credentials/provider access are unavailable, implement the adapter interface, config, mocks/fixtures for tests, and mark live integration as pending.
- Do not perform unrelated refactors.

## Mandatory workflow for each phase

1. Inspect the current repository before editing.
2. State the current phase and acceptance criteria from `docs/IMPLEMENTATION_ROADMAP.md`.
3. List the exact files/modules that already exist and are relevant.
4. Identify gaps between current state and the phase acceptance criteria.
5. Propose the smallest safe implementation plan.
6. If the phase requires an architecture change that conflicts with the docs, stop implementation and report the conflict instead of silently changing architecture.
7. Implement the smallest complete vertical slice.
8. Add/update tests.
9. Run available validation commands from the repository, including typecheck, lint, tests, build, and `wrangler types` where applicable.
10. Update docs when behavior/contracts change.

## Source-adapter rules

The platform must support adapters for:

- generic web
- news
- RSS
- forum/blog
- YouTube
- Reddit
- X
- Facebook
- TikTok
- LinkedIn

But each adapter must declare its actual capabilities and policy constraints. Do not pretend every source supports full search/comments/history. Feature-flag live integrations independently.

## Boolean query requirements

V1 supports:

- AND
- OR
- NOT
- parentheses
- exact phrases in double quotes

Discovery-provider query syntax is not the source of truth. Always evaluate the normalized fetched content against our own AST before accepting a mention.

## AI requirements

Use a cheap-first pipeline:

1. deterministic Boolean match
2. deterministic relevance signals
3. cheap relevance/sentiment model
4. deep model only for uncertain/high-value candidates

Sentiment must be toward the monitored entity, not the overall emotional tone of the page.

## Reliability requirements

- Queue retries use exponential backoff + jitter.
- DLQs preserve original payload and final error class.
- Alert sends are deduplicated and idempotent.
- DomainCoordinatorDO prevents thundering-herd crawling.
- BrowserPoolDO controls scarce browser concurrency.
- BudgetDO protects tenant cost limits without sacrificing Critical candidate handling first.

## Security requirements

- tenant isolation
- RBAC
- Turnstile where appropriate
- Cloudflare WAF/rate limiting assumptions documented
- SSRF blocks including loopback, private ranges, link-local, metadata endpoints, redirect-to-private, and DNS rebinding mitigation
- secrets only through Cloudflare secret bindings

## First task

Start with **Phase 0 — Foundation** only.

Do not implement later phases yet.

For Phase 0:
- scaffold the monorepo according to the documented repository shape
- create shared TypeScript config
- create environment-aware Wrangler configuration skeletons
- create package scripts for typecheck/lint/test
- create a base observability package
- create placeholder Worker entrypoints for API, scheduler, discovery, crawler-fetch, crawler-browser, processor, ai-classifier, alerts, and reports
- create Durable Object class placeholders for tenant-directory, monitor, domain-coordinator, browser-pool, and budget
- define shared Env/types interfaces for bindings without hardcoding resource IDs
- set up unit-test framework
- add a CI workflow if the repo is on GitHub
- make the minimum code necessary so typecheck/tests can run

Do not add fake production logic.

## Final response format after Phase 0

1. Phase completed
2. Current repository structure
3. Files created/changed
4. Binding/environment strategy
5. Validation commands run and exact results
6. Known gaps intentionally left for Phase 1
7. Any architecture conflicts or risks
8. Recommended next prompt: Phase 1 only

## Additional canonical handoff docs

Also read before implementation:

- `docs/BUILD_HANDOFF_INDEX.md`
- `docs/SOURCE_COVERAGE_MATRIX.md`
- `docs/UI_UX_SPEC.md`
- `prompts/README.md`

When working after Phase 0, use exactly one phase prompt from `prompts/PHASE_*.md` as the execution scope. Do not batch future phases unless explicitly instructed.

## New canonical docs
Before implementation also read:
- `docs/AUTH_BILLING_SUPERADMIN.md`
- `docs/SOURCE_DISCOVERY_ENGINE.md`

For a single-paste autonomous phased build, prefer `prompts/ONE_SHOT_CODEX_BOOTSTRAP.md` as the entrypoint.
