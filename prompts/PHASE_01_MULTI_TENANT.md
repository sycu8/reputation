# Codex Prompt — Phase 1: Multi-tenant Control Plane

You are a senior Cloudflare Workers engineer working inside this repository. Be conservative and production-minded.

## Objective

Implement the multi-tenant control plane defined in `docs/IMPLEMENTATION_ROADMAP.md` without introducing crawler or AI behavior yet.

## Read first

Read `AGENTS.md`, `docs/BUILD_HANDOFF_INDEX.md`, `docs/TECHNICAL_SPEC.md`, `docs/DATA_MODEL.md`, `docs/SRE_RUNBOOK.md`, and the current repository structure. Do not edit before summarizing what already exists.

## Required outcome

Implement or complete:

- authentication/session abstraction compatible with Cloudflare Workers
- TenantDirectoryDO
- MonitorDO skeleton with SQLite-backed storage
- workspace model
- membership model
- RBAC roles: owner, admin, analyst, viewer
- monitor CRUD
- query CRUD storage only; Boolean parsing is Phase 2
- audit log for control-plane changes
- environment-safe bindings for dev/staging/prod

## Non-negotiables

- Never use one global DO as the application database.
- Enforce tenant isolation at the service boundary and in tests.
- Do not put raw page content in DO storage.
- Do not add D1 unless architecture docs are explicitly changed and justified; current canonical persistence is DO + R2.
- Do not implement crawler, AI, social integrations, dashboard polish, or billing in this phase.
- Schema migrations must be repeatable and backward-safe.

## Investigation first

Before editing:

1. List relevant packages/workers/config files.
2. Describe current authentication, routing, Durable Object, and migration patterns.
3. Identify missing pieces versus this phase.
4. Propose exact files to modify.

## Tests

At minimum:

- tenant A cannot fetch/update tenant B workspace or monitor
- RBAC allows/denies expected operations
- monitor CRUD
- query CRUD storage
- migration initializes idempotently
- audit log records actor/action/target/timestamp

## Validation

Use repository-native commands plus:

- typecheck
- lint
- tests
- `wrangler types`

## Final report

Use the format required in `AGENTS.md`. Also state whether Phase 1 acceptance criteria are fully met and list blockers without hiding them.
