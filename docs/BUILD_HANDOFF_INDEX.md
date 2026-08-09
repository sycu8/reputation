# Build Handoff Index

This repository documentation is the canonical handoff package for the multi-tenant Cloudflare-native social listening SaaS.

## Mandatory reading order for every coding agent

1. `AGENTS.md`
2. `docs/TECHNICAL_SPEC.md`
3. `docs/DATA_MODEL.md`
4. `docs/AUTH_BILLING_SUPERADMIN.md`
4a. `docs/BRAND_KIT.md`
4b. `docs/SEO_MARKETING.md`
4c. `docs/MARKETING_COPY_BANK.md`
5. `docs/QUEUE_CONTRACTS.md`
6. `docs/CRAWLER_AND_SOURCES.md`
7. `docs/SOURCE_COVERAGE_MATRIX.md`
8. `docs/SOURCE_DISCOVERY_ENGINE.md`
9. `docs/UI_UX_SPEC.md`
10. `docs/WRANGLER_BINDINGS_ARCHITECTURE.md`
11. `docs/CRAWLER_ALGORITHM_SPEC.md`
12. `docs/SRE_RUNBOOK.md`
13. `docs/IMPLEMENTATION_ROADMAP.md`
14. The prompt for the current phase under `prompts/`
15. After implementation, run `prompts/UNIVERSAL_PHASE_REVIEW_PROMPT.md` as the phase gate

## Product invariant

The product answers two questions better than anything else:

1. Who is talking about the monitored person, brand, product, or company right now?
2. Is any new mention negative enough that the customer should be alerted within 15 minutes?

Everything else is secondary.

## Architecture invariant

- Cloudflare Workers are the stateless compute layer.
- SQLite-backed Durable Objects hold strongly consistent operational state and are sharded by role; never create a single global database DO.
- R2 is the raw-content and blob data lake.
- Queues buffer and isolate asynchronous stages.
- Workflows orchestrate durable multi-step operations, not every tiny fetch.
- Browser Run/Browser Rendering is an escalation path for public JS-rendered content, not the default fetcher and never a login/CAPTCHA bypass mechanism.
- Workers AI is used cheap-first; deep inference only runs on narrowed candidates.
- Multi-tenancy exists from the first production schema.
- All source adapters expose capability, policy, freshness, and health state.

## Phase workflow

For every phase:

1. Agent performs read-only repository discovery.
2. Agent summarizes current implementation against the phase acceptance criteria.
3. Agent proposes exact files to change.
4. Agent implements the smallest safe patch.
5. Agent runs repository-native validation.
6. Agent updates docs if contracts or architecture changed.
7. Agent produces the required final report from `AGENTS.md`.
8. A separate review pass is recommended before proceeding to the next phase.

## Never infer live source capability

Social-platform access changes frequently. The implementation must treat source access as runtime configuration. A source may be `available`, `degraded`, `contract_required`, or `disabled`. Never fake live coverage in production.


## Universal phase review

After each implementation phase, paste `prompts/UNIVERSAL_PHASE_REVIEW_PROMPT.md` once. It automatically identifies the current phase from the repository and reviews the correct acceptance criteria. Do not create separate review prompts per phase unless a future phase needs a specialized security audit.


## Wrangler examples

Concrete dev/staging/production examples live under `config-examples/`. They are templates only; every agent must validate them against the installed Wrangler schema and run `wrangler types` before deployment.


## One-shot Codex entrypoint
For a fresh or partially built repository, use `prompts/ONE_SHOT_CODEX_BOOTSTRAP.md`. It instructs Codex to discover state, execute phases sequentially, self-apply the universal review gate, and stop only on genuine production/credential/policy blockers.
