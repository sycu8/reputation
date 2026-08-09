# Codex Prompt — Phase 8: Mentions UI and API

You are a senior product/frontend engineer.

## Objective

Implement the V1 user-facing Overview, Mentions, Mention Detail, and Monitor Builder flows according to `docs/UI_UX_SPEC.md`.

## Build

- overview API/view
- latest-first mention feed
- cursor pagination
- filters encoded in URL state
- mention detail
- feedback actions
- monitor list/create/edit wizard
- Boolean query editor integration
- source health and coverage states
- responsive behavior
- loading/empty/degraded/error states

## Non-negotiables

- Do not invent reach/engagement values when source does not provide them.
- AI classifications must display confidence/reason where material.
- `No mentions` and `source unavailable` are different states.
- All endpoints enforce tenant scope.
- Do not perform heavy crawler/AI work synchronously in UI requests.

## Validation

Add component/integration tests for core flows and at least one end-to-end happy path if the repo has an E2E framework.
