# Codex Prompt — Phase 12: Reports and Production Hardening

You are the senior engineer preparing this system for production launch.

## Objective

Complete daily/weekly reporting, quotas/retention, operational visibility, resilience validation, and launch readiness.

## Build

- daily report Workflow
- weekly report Workflow
- R2 report artifacts
- budget/quota enforcement
- retention/lifecycle behavior
- source health UI
- internal operational metrics
- DLQ replay tooling/runbook hooks
- load tests
- retry/chaos tests
- rollout/rollback notes

## Production review areas

Security:

- tenant isolation
- SSRF
- auth/RBAC
- secret handling
- abuse limits

Reliability:

- idempotency
- queue backlog handling
- source degradation
- AI degradation
- Browser Run exhaustion

Cost:

- crawl once/match many
- fetch-first/browser-second
- cheap-first AI
- R2 retention
- per-tenant quotas

SLO:

- instrument end-to-end detection latency
- instrument alert latency
- prove P95 target in controlled load where feasible

## Final deliverable

Produce a launch-readiness report with blockers separated into must-fix, should-fix, and post-launch. Do not mark production-ready if material tests are missing.
