# AGENTS.md — Social Listening SaaS

## Product mission
Build a multi-tenant, Cloudflare-native social listening SaaS that continuously monitors public web and supported social sources for people, brands, products, and companies; returns the latest relevant mentions; classifies sentiment toward the monitored entity; and alerts customers about significant negative mentions with a P95 detection target under 15 minutes.

## Non-negotiable architecture
- Cloudflare-first deployment.
- Runtime: Cloudflare Workers.
- Dynamic web rendering/scraping: Cloudflare Browser Run / Browser Rendering.
- Operational state: SQLite-backed Durable Objects, sharded by tenant/monitor/domain role. Never use one global DO as the database.
- Raw content and large blobs: R2.
- Async jobs: Queues with DLQs.
- Durable multi-step orchestration: Workflows.
- Read-heavy config/cache: KV only where eventual consistency is acceptable.
- AI: Workers AI first for cheap classification/embeddings; deeper models only when required.
- Semantic dedupe/clustering: Vectorize when enabled.
- Telemetry: Analytics Engine + structured Worker logs.

## Product scope V1
P0:
- Auth and multi-tenant workspaces.
- Monitors for person/company/brand/product keywords.
- Boolean query parser: AND, OR, NOT, parentheses, exact phrase.
- Continuous monitoring.
- Web/news/blog/forum/RSS discovery and crawling.
- Social source adapters for Facebook, TikTok, YouTube, Reddit, X, LinkedIn where public/officially accessible and compliant with source capabilities.
- Mention feed.
- Relevance classification.
- Positive/neutral/negative sentiment toward the monitored entity.
- Severity score.
- Negative alerting by email + Telegram.
- Daily report.
- User feedback: relevant/not relevant/wrong sentiment/resolved.

Out of scope for V1:
- Face recognition.
- CAPTCHA bypass.
- Private groups/accounts.
- Password-based scraping.
- Dark web collection.
- Arbitrary recursive scraping as a customer feature.

## Coding rules
- TypeScript only unless a task explicitly requires otherwise.
- Inspect the repo before editing.
- Prefer small, reversible patches.
- Do not refactor unrelated modules.
- Preserve package boundaries.
- Every queue consumer must be idempotent.
- Every external-source fetch must use bounded retries + exponential backoff + jitter.
- Never store secrets in source code or wrangler config.
- Never use KV as transactional state.
- Never store large HTML/media blobs in Durable Objects.
- All multi-tenant reads/writes must enforce tenant isolation at the service boundary.
- SSRF protection is mandatory for crawler URL handling.
- Source adapters must expose capabilities and policy constraints.

## Required validation before completion
- typecheck
- lint
- unit tests
- integration tests for touched flows
- `wrangler types`
- local Worker validation where available
- explicit note of unvalidated behavior

## Required final report from any coding agent
1. Summary
2. Files changed
3. Architecture impact
4. Validation performed
5. Risks/trade-offs
6. Follow-up work

## Mandatory handoff documents
Before architecture-sensitive work, read `docs/BUILD_HANDOFF_INDEX.md`. Cloudflare bindings must follow `docs/WRANGLER_BINDINGS_ARCHITECTURE.md`; crawler scheduling/frontier logic must follow `docs/CRAWLER_ALGORITHM_SPEC.md`. Source integrations must follow `docs/SOURCE_COVERAGE_MATRIX.md`; frontend work must follow `docs/UI_UX_SPEC.md`. Phase work must use the matching prompt under `prompts/`.

## Social-source truthfulness rule
Never claim or implement "full coverage" by silently substituting brittle scraping for unavailable official/contracted access. Every source must expose capability and availability state. Browser Run may render permitted public pages; it is never an authentication, CAPTCHA, or platform-authorization bypass.


## Review gate
After every implementation phase, use `prompts/UNIVERSAL_PHASE_REVIEW_PROMPT.md`. A phase is not complete until that review returns PASS or PASS WITH FIXES and all blocker/high findings are resolved.

## Authentication, billing, and admin invariant
Read `docs/AUTH_BILLING_SUPERADMIN.md` before modifying auth, plans, subscriptions, quota, usage metering, or admin behavior. Canonical customer plans are USD 29 / USD 49 / USD 99 per month. The internal `super_admin` has unlimited commercial entitlements but never bypasses platform safety, source policy, SSRF, domain politeness, or Cloudflare hard limits.

## Discovery invariant
Read `docs/SOURCE_DISCOVERY_ENGINE.md` before changing URL discovery, provider federation, query fan-out, ranking/fusion, freshness scheduling, source coverage metrics, or historical discovery. Never claim absolute Internet coverage or perfect accuracy; expose measured precision/recall and source availability truthfully.
