# Phase 13 — Billing, Entitlements, and Super Admin

Read `AGENTS.md`, `docs/AUTH_BILLING_SUPERADMIN.md`, `docs/DATA_MODEL.md`, `docs/UI_UX_SPEC.md`, and existing auth/control-plane code before editing.

## Objective

Complete production-oriented subscription and entitlement enforcement for USD 29/49/99 plans plus internal super-admin unlimited entitlements.

## Build

- versioned plan catalog
- subscription state model
- billing provider adapter
- first provider implementation boundary (Stripe-compatible if selected)
- signed webhook verification
- webhook idempotency/replay protection
- reconciliation job
- server-side entitlement evaluator
- TenantBudgetDO usage counters
- soft/hard quota behavior
- billing settings UI
- plan selection / checkout handoff UI
- super-admin console basics
- immutable audit events for privileged actions

## Non-negotiables

- no raw card data
- no public API can set `super_admin`
- UI is not an authorization boundary
- plan values are config/versioned data, not scattered constants
- super-admin bypasses commercial quota only, never platform safety/policy limits
- missing payment credentials must produce a clear credential-blocked state, not fake success

## Acceptance

- Starter/Pro/Business entitlement tests pass
- super-admin entitlement bypass tests pass
- tenant cannot self-upgrade by changing client payload
- duplicate webhooks do not duplicate state transitions
- canceled/past_due behavior matches documented state machine
- quota usage is strongly consistent for gated operations
- privileged admin actions are audited
- billing UI reflects authoritative backend status
