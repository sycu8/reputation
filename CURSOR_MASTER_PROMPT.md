# Cursor Master Prompt — Build and Deploy PulseWatch by OrangeCloud

You are the senior implementation and deployment owner of this repository. Work autonomously and systematically until the application is production-ready or you hit a genuine external blocker such as missing credentials, unavailable commercial source access, or a Cloudflare account/zone mismatch.

## First: inspect, do not edit

Read these files in full before making changes:
- `CURSOR_START_HERE.md`
- `AGENTS.md`
- `BUILD_STATUS.md`
- `HANDOFF_MANIFEST.md`
- `docs/BUILD_HANDOFF_INDEX.md`
- all documents referenced by `docs/BUILD_HANDOFF_INDEX.md`
- all `wrangler.jsonc` files
- root `package.json`
- existing tests and implementation files

Run the current validation commands and summarize the actual state. Then produce a concise implementation plan mapped to the remaining phases in `BUILD_STATUS.md`.

## Then implement

Continue the existing architecture; do not rebuild from scratch.

Complete all unfinished product areas:
1. scalable scheduler/due-monitor indexing;
2. federated discovery including web/news/RSS/sitemap and supported native/social adapters;
3. crawl-once/match-many, Browser Run fallback and source health;
4. high-quality relevance, dedupe/Vectorize, story clustering;
5. target-aware sentiment, severity, virality and high-priority negative-alert fast lane;
6. full dashboard UX for overview/mentions/detail/alerts/monitors/reports/settings/source health;
7. durable alert delivery, retries, receipts and reconciliation;
8. authentication/account UX, subscriptions, metering/quotas, subscription provider adapter/webhooks, and secure super-admin console;
9. reports, observability, SLO measurement and production hardening;
10. deploy and smoke-test on Cloudflare.

## Production target

- Cloudflare account: `Cloudspace`
- Account ID reference: `4c15704ef706b9c8954cd6f9feb678d8`
- Hostname: `reputation.orangecloud.vn`

The account ID is operator/deployment context. Do not hardcode it into runtime source.

Before DNS/route changes, verify `orangecloud.vn` is actually in the Cloudspace account. If not, stop only the routing step and report the exact mismatch; continue any independent code work.

Preferred same-origin routing after verification:
- `reputation.orangecloud.vn/api/*` -> production API Worker
- `reputation.orangecloud.vn/*` -> production dashboard/assets Worker

Follow `docs/DEPLOYMENT_CLOUDSPACE.md` for resource order and smoke tests.

## Source-coverage rule

Aim for maximum lawful/public coverage and measurable precision/recall. Do not claim or fake 100% Internet coverage.

Never bypass CAPTCHA, login walls, private groups/accounts or platform access controls. For unavailable providers, keep real adapter contracts and source-health status (`contract-required`, `degraded`, `disabled`) rather than fake data.

## Architecture invariants

Preserve all invariants in `AGENTS.md` and `CURSOR_START_HERE.md`, especially:
- no global database Durable Object;
- R2 for raw/large content;
- per-entity SQLite-backed DO shards for strongly consistent operational state;
- Queues as the distributed async frontier;
- fetch-first / Browser-Run-second;
- DomainCoordinatorDO and BrowserPoolDO boundaries;
- deterministic cheap filtering before expensive AI;
- canonical Boolean re-evaluation after fetch;
- tenant isolation/RBAC on every tenant-scoped API;
- priority path for likely negative content;
- no public path to `super_admin`.

## Validation and review

After every meaningful slice:
- add/update tests;
- run relevant existing repository commands;
- run `npm run validate`;
- run `npm run wrangler:types` after Cloudflare bindings are provisioned;
- use remote binding smoke tests where required;
- never report a test/deploy as successful unless it actually ran.

Before production cutover, perform a strict review for correctness, auth, tenant isolation, billing, DO migrations, queue idempotency, crawler SSRF, source policy, secrets, Browser Run capacity, observability, SLO and rollback.

## Secrets

Read `docs/SECRETS_AND_PROVIDER_ACCESS.md`. Never commit real secrets. Use Cloudflare/Wrangler secret management.

## Keep handoff current

Continuously update `BUILD_STATUS.md` with verified facts only. If you stop, another senior engineer must be able to continue immediately from that file and repository state.

## Final output

When complete, return:
1. live production URL and API health result;
2. resources created/reused;
3. Workers and routes deployed;
4. validation/test results;
5. live/degraded/disabled source coverage;
6. missing external credentials/contracts;
7. billing/entitlement/super-admin status;
8. SLO/observability status;
9. rollback procedure;
10. remaining risks, if any.
