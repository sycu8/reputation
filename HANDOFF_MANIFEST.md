# Cursor Handoff Manifest

This package consolidates the latest source code, tests, Cloudflare configs, product/architecture documentation and all generated implementation prompts from the social-listening project.

## Entry points

1. `CURSOR_START_HERE.md` — primary Cursor instructions.
2. `.cursor/rules/` — persistent project rules for Cursor.
3. `AGENTS.md` — architecture/coding rules shared with coding agents.
4. `BUILD_STATUS.md` — verified current implementation state and known gaps.
5. `docs/BUILD_HANDOFF_INDEX.md` — documentation reading order.
6. `README.md` — repository quickstart.

## Source

- `apps/api-worker/`
- `apps/dashboard/`
- `workers/state/` (includes `SchedulerShardDO`)
- `workers/scheduler/`
- `workers/discovery/`
- `workers/crawler-fetch/`
- `workers/crawler-browser/`
- `workers/processor/`
- `workers/ai-classifier/`
- `workers/alerts/`
- `workers/reports/`
- `packages/` (`auth`, `billing`, `boolean-query`, `crawler-core`, `dedupe`, `observability`, `severity`, `source-adapters`, `types`, `virality`)
- `tests/`
- `scripts/`

## Documentation

All `docs/*.md` files are retained, including product architecture, data model, crawler/source design, source coverage, UI/UX, auth/billing/super-admin, Wrangler/binding design, SRE and roadmap.

## Prompts retained

All historical implementation prompts are retained under `prompts/`, including phase prompts 01–13, one-shot Codex bootstrap and universal review prompt. They are historical/operator assets; for Cursor use `CURSOR_START_HERE.md` as the primary entry point.

## Production target carried into this handoff

- Cloudflare account: Cloudspace
- Production hostname: `reputation.orangecloud.vn`
- Plans: $29 / $49 / $99 monthly
- Goal: broad public Internet/social coverage with source-health transparency and high-precision negative alerts, not a false claim of 100% Internet coverage.

## Agent progress (2026-08-09)

- Branch: `cursor/import-and-build-reputation-8cdc`
- Local `npm run validate`: PASS (36 tests)
- Cloudflare deploy: blocked on missing Wrangler/MCP authentication in cloud agent

## No secrets included

This archive intentionally contains no real API tokens, payment secrets, social credentials or Cloudflare access tokens.
