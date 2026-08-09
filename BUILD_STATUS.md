# BUILD_STATUS

Last updated: 2026-08-09 (Cursor Cloud Agent — self-supplement collection)

## Summary

Handoff package imported into `sycu8/reputation`. Local validation + **Cloudspace production deploy** are live via GitHub Actions (`Deploy Cloudspace` on `main`). Product covers sharded scheduling, federated discovery (free public news + Reddit RSS, optional Brave/social secrets), SimHash/story clustering, dashboard UX, alert delivery receipts, reports worker skeleton, and billing stub/webhook/admin APIs.

## Deployment target

- Cloudflare account: **Cloudspace** (`4c15704ef706b9c8954cd6f9feb678d8`)
- Production hostname: `reputation.orangecloud.vn`
- Workers.dev API: `https://reputa-api-production.sycu-lee.workers.dev`
- Workers.dev app: `https://reputa-dashboard-production.sycu-lee.workers.dev/app/`
- Deployment status: **DEPLOYED** (auto-deploy on push to `main`)

## Validation

Local (this agent):

- `npm install` / `npm run validate` — run before each PR merge
- Live collector login + mention counts verified against production API

## Phase status

| Phase | Status | Notes |
|---|---|---|
| 0 Foundation | PASS | Monorepo, TS, lint, tests, CI, Wrangler configs |
| 1 Multi-tenant control plane | IMPLEMENTED | Auth/session/RBAC/tenants/monitors/audit |
| 2 Boolean engine | IMPLEMENTED | AND/OR/NOT, phrases, Vietnamese |
| 3 Scheduler + Queues | IMPLEMENTED | `SchedulerShardDO` (64 shards), claim/advance |
| 4 Web/News/RSS | LIVE | Free public news RSS + expanded static feeds; Brave optional |
| 5 Browser Run | IMPLEMENTED / UNVERIFIED REMOTELY | Needs remote binding smoke |
| 6 Relevance + dedupe | IMPLEMENTED | Boolean post-fetch, SimHash, story clusters |
| 7 Sentiment + severity | IMPLEMENTED / UNVERIFIED REMOTELY | Virality can boost severity |
| 8 Mentions UI/API | LIVE | Overview/Mentions/Alerts/Monitors/Reports/Settings |
| 9 Alerts | IMPLEMENTED | Per-channel receipts |
| 10 Social adapters | PARTIAL LIVE | Free Reddit public search RSS; YouTube/X/OAuth Reddit need secrets |
| 11 Virality + clustering | PRIMITIVES | Engagement snapshots still thin |
| 12 Reports + hardening | SKELETON | Reports worker stub |
| 13 Billing + super admin | PARTIAL | Stripe Payment Links in Settings; stub webhook; super admin allowlist |

## Source coverage (runtime truthfulness)

| Source | Runtime without paid secrets |
|---|---|
| Open web (Brave) | `disabled` until `BRAVE_SEARCH_API_KEY` |
| News (Brave news) | `disabled` until Brave key |
| Public news RSS (HN/Bing/Google News) | **always on** (`public-web`) |
| Public Reddit search RSS | **always on** (`public-web`) — post permalinks only |
| Static RSS/Atom | `public-web` via `RSS_FEED_URLS` (expanded tech/VN/security set) |
| Sitemap | `public-web` when `SITEMAP_URLS` configured |
| YouTube / X | empty until secrets |
| Reddit OAuth | empty until credentials; free RSS still collects |
| Facebook / TikTok / LinkedIn | `degraded` / `contract-required` stubs; no fake data |

## Live collector (production)

Auto-bootstrapped after each production deploy (`npm run bootstrap:collection`):

| Field | Value |
|---|---|
| Email | `collector@pulsewatch.orangecloud.vn` |
| Password | `PulseWatch-Collect-2026!` |
| App | https://reputa-dashboard-production.sycu-lee.workers.dev/app/ |
| Super admin allowlist | `sycu.lee@gmail.com` (sign in with that account’s existing password) |
| Mentions (sample) | Cloudflare ~17+, AI Agents ~7+; OrangeCloud niche brand may stay low until wider crawl/Brave |

Discovery without paid keys: HN + Bing + Google News RSS, public Reddit search RSS, plus BBC / Guardian / TechCrunch / Ars / Verge / Wired / Cloudflare Blog / NYT Tech / security feeds / VNExpress / Thanh Niên / Tuổi Trẻ / VietnamNet / CafeF.

Optional upgrade: set GitHub Actions secret `BRAVE_SEARCH_API_KEY` (Brave dashboard requires a card).

## Remaining gaps (honest)

1. Brave / YouTube / X / Reddit OAuth still need operator-supplied secrets.
2. Custom host DNS / CF challenges may still affect `/api` on `reputation.orangecloud.vn` — prefer workers.dev API base.
3. Billing webhook secret not configured (`billing_webhook_not_configured`); plan changes via Stripe Payment Links / manual DO until wired.
4. Starter plan = **3 monitors max** on collector workspace.
5. Remote Browser Run / Workers AI evaluation fixtures not smoke-tested in this agent.
