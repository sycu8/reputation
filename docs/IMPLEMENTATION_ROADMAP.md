# Implementation Roadmap for Codex

## Phase 0 — Foundation

Deliverables:
- monorepo scaffold
- shared TypeScript config
- Wrangler environments
- CI
- AGENTS.md compliance
- base observability package
- environment/binding validation

Acceptance:
- dev/staging/prod config skeleton exists
- `wrangler types` works
- typecheck/lint/test scripts work

## Phase 1 — Multi-tenant control plane

Build:
- account registration/login and auth/session abstraction
- role/capability model
- subscription/entitlement primitives (full billing provider integration in Phase 13)
- TenantDirectoryDO
- MonitorDO
- workspace/membership model
- monitor CRUD
- query CRUD
- RBAC
- audit log

Acceptance:
- tenant A cannot read tenant B
- monitor CRUD tested
- DO schema migrations repeatable

## Phase 2 — Boolean query engine

Build package:
- tokenizer
- parser
- AST types
- validator
- normalizer
- evaluator
- provider-query compiler interface

Tests:
- nested parentheses
- implicit/explicit AND
- NOT precedence
- quoted phrases
- invalid syntax
- Unicode/Vietnamese terms

Acceptance:
- deterministic truth table tests pass

## Phase 3 — Queue skeleton + scheduler

Build:
- scheduler worker
- discovery queues + DLQ
- crawl queues + DLQ
- process queues + DLQ
- alert queue + DLQ
- common job envelope
- idempotency helper

Acceptance:
- due monitor emits discovery job
- replay does not duplicate scan state

## Phase 4 — Generic web/news/RSS

Build:
- SourceAdapter contract
- generic web adapter
- RSS adapter
- sitemap adapter
- search-provider abstraction
- direct fetch crawler
- R2 raw storage
- canonical URL/fingerprint

Acceptance:
- monitor discovers and stores public web mentions
- crawl once/match many demonstrated

## Phase 5 — Browser Run crawler

Build:
- BrowserPoolDO
- DomainCoordinatorDO
- browser crawler
- fetch-quality detector
- auto fallback
- bounded scroll/navigation
- browser failure taxonomy

Acceptance:
- JS-heavy fixture renders successfully
- browser is not invoked for static fixtures
- concurrent browser requests respect leases

## Phase 6 — Relevance + dedupe

Build:
- Boolean post-fetch evaluator
- deterministic relevance scoring
- content hash + SimHash/MinHash
- optional Vectorize adapter
- user feedback storage

Acceptance:
- duplicate fixtures collapse
- unrelated same-name fixtures rejected

## Phase 7 — Sentiment + severity

Build:
- Workers AI router
- target-aware sentiment classifier
- confidence thresholds
- topic classification
- severity scoring
- risk-category rules

Acceptance:
- tests include mixed sentiment toward multiple entities
- Critical cannot be triggered by keyword alone

## Phase 8 — Mentions UI/API

Build:
- overview
- mentions feed
- mention detail
- filters
- feedback actions
- latest-first pagination

Acceptance:
- tenant can see fresh mention within product flow

## Phase 9 — Alerts

Build:
- alert rule engine
- dedupe
- email
- Telegram
- alert UI
- acknowledgment/resolution

Acceptance:
- High negative fixture produces one alert only
- retries do not duplicate notification

## Phase 10 — Social adapters

Implement adapters one by one under capability flags:
- YouTube
- Reddit
- X
- Facebook
- TikTok
- LinkedIn

For each source:
1. document supported access method
2. add policy config
3. add fixtures
4. add source health metrics
5. add graceful degraded/disabled states

Do not merge an adapter that only works via brittle bypass behavior.

## Phase 11 — Virality + clustering

Build:
- engagement snapshots
- velocity/acceleration
- story clustering
- cluster-aware alerts

## Phase 12 — Reports + hardening

Build:
- daily report workflow
- weekly report
- retention lifecycle
- budget enforcement
- source health UI
- operational dashboards
- load tests
- chaos/retry tests

## Definition of Done for every phase

- implementation complete
- tests added/updated
- typecheck/lint/tests pass
- wrangler validation passes
- docs updated
- no unrelated refactors
- known risks documented

## Phase prompt mapping

- Phase 1: `prompts/PHASE_01_MULTI_TENANT.md`
- Phase 2: `prompts/PHASE_02_BOOLEAN_ENGINE.md`
- Phase 3: `prompts/PHASE_03_SCHEDULER_QUEUES.md`
- Phase 4: `prompts/PHASE_04_WEB_NEWS_RSS.md`
- Phase 5: `prompts/PHASE_05_BROWSER_RUN.md`
- Phase 6: `prompts/PHASE_06_RELEVANCE_DEDUPE.md`
- Phase 7: `prompts/PHASE_07_SENTIMENT_SEVERITY.md`
- Phase 8: `prompts/PHASE_08_UI_API.md`
- Phase 9: `prompts/PHASE_09_ALERTS.md`
- Phase 10: `prompts/PHASE_10_SOCIAL_ADAPTERS.md`
- Phase 11: `prompts/PHASE_11_VIRALITY_CLUSTERING.md`
- Phase 12: `prompts/PHASE_12_REPORTS_HARDENING.md`


## Phase 13 — Billing, Entitlements, and Super Admin

Build:
- USD 29 / 49 / 99 versioned plan catalog
- billing provider adapter and signed webhook handling
- subscription state machine
- entitlement evaluation
- TenantBudgetDO usage metering/quota enforcement
- billing/settings UI
- super-admin console and unlimited commercial entitlement bypass
- audit/reconciliation

Acceptance:
- customer cannot self-grant a paid plan
- webhook replay is idempotent
- plan gates are enforced server-side
- super-admin bypasses plan quotas only, not platform safety limits
- privileged actions are audited

Phase 13 prompt: `prompts/PHASE_13_BILLING_SUPERADMIN.md`
