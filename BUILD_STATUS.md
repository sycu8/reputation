# BUILD_STATUS

Last updated: 2026-10-17 (Cursor Cloud Agent — agent discovery documents)

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
| Static RSS/Atom | `public-web` via always-on default tech/startup registry + optional `RSS_FEED_URLS` |
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
| Role | `super_admin` (ops allowlist — unlocks more monitors + ~120s scans) |
| App | https://reputa-dashboard-production.sycu-lee.workers.dev/app/ |
| Monitors | Cloudflare, OrangeCloud, AI Agents, Cybersecurity, Vietnam Tech |
| Super admin allowlist | `sycu.lee@gmail.com` + collector (always merged on deploy) |

Always-on free discovery: HN RSS + Algolia, Bing/Yahoo/Google News RSS, Reddit search RSS, DEV.to/Medium tag feeds, plus expanded static RSS (BBC/Guardian/TechCrunch/Ars/Verge/Wired/CF Blog/security/VN…).

Optional upgrade: set GitHub Actions secret `BRAVE_SEARCH_API_KEY` (Brave dashboard requires a card).

## Agent discovery

Verified locally with `wrangler dev` on `http://127.0.0.1:8788` (2026-10-17):

- `/robots.txt` is `text/plain` and HTTP 200, with AI crawler groups, Content-Signal, and a sitemap reference.
- `/sitemap.xml`, `/auth.md`, `/.well-known/api-catalog` (`application/linkset+json`), OAuth discovery JSON, the MCP server card, the skills index, and `/.well-known/ai-catalog.json` (`Access-Control-Allow-Origin: *`) all return HTTP 200.
- Homepage `Link` response header includes `rel="api-catalog"`.
- `POST /mcp` returns JSON-RPC `initialize`.
- The homepage listening-query form validated `("OrangeCloud" OR PulseWatch) AND NOT hiring` against the local API, and three WebMCP tools registered on load.

DNS-AID SVCB/HTTPS records are created by `scripts/deploy-cloudspace.mjs` when the deploy token can edit zone DNS. This environment had no `CLOUDFLARE_API_TOKEN`, so live DNS was not changed and DNSSEC was not enabled.

## Production incident fixes

The retry-storm change is on main as `0f89943`. The queue follow-up below is local only. `wrangler deploy` was not run for it, and the crawl DLQ was not purged.

- Browser pool: `BrowserPoolDO` now uses expiring leases swept by a Durable Object alarm. The legacy counter that was stuck at 100 is no longer the cap. Default cap is 200 (Workers Paid Browser Run concurrent browsers, overridable with `BROWSER_POOL_MAX`). Reset procedure is in `docs/SRE_RUNBOOK.md`.
- Alerts: `no_channels_configured` is alert state `needs_setup`, logged at warn, and acked. The dashboard shows "Needs notification setup".
- Discovery: RSS/Atom title and snippet are capped, crawl messages are fitted under 120 KB, sends are batched, one candidate failure does not fail the job, and a discovery job stops after 90s instead of running to the 15-minute queue limit. Static RSS/sitemap catalogs are fetched once per job.
- Static crawler: permanent 4xx responses are acked, 403/419 are sent to the browser crawler, and 429 records per-domain backoff on `DomainCoordinatorDO`.
- Retry storm: merged on main as `0f89943`. `domain_busy` / `browser_pool_busy` requeue with a jittered 30–60s delay (longer coordinator hints are kept, capped at 15 minutes). The per-tenant URL cap counts real fetch failures only, not congestion delays. Permanent 4xx, including browser `browser_http_401/402/404/422`, and `browser_extraction_too_small` are acked. A browser cache hit is forwarded to processing. `syn-*`, `utm_*`, and `fbclid` are stripped before dedupe. `ft.com` and `nytimes.com` (override with `HARD_PAYWALL_HOSTS`) are skipped before fetch or Browser Run. `domain_busy` is logged at info as `crawl_domain_busy`.
- Crawl queues: production logs show `message.retry()` reaches attempt 4 and then stops, so `domain_busy` already enters the DLQ. The 14 October messages still on the main queues are unexplained. Congestion (`domain_busy`, `browser_pool_busy`) is re-sent on the same queue with `delaySeconds` (max 900s) and `congestionHops`, then the original is acked. After 12 hops the worker logs `crawl_congestion_cap` and acks, so congestion does not use the DLQ. Real 5xx, network, and upstream 429 failures still use `message.retry()` and `max_retries` 3. A malformed body is acked and logged. Verified locally on 2026-10-18 with `npm run validate` (typecheck, lint, 103 tests) and `npm run wrangler:types:browser`. DLQ handling is proposed in `docs/CRAWL_DLQ_PROPOSAL.md` and is not executed.

## Remaining gaps (honest)

1. Brave / YouTube / X / Reddit OAuth still need operator-supplied secrets.
2. Custom host DNS / CF challenges may still affect `/api` on `reputation.orangecloud.vn` — prefer workers.dev API base.
3. Billing webhook secret not configured (`billing_webhook_not_configured`); plan changes via Stripe Payment Links / manual DO until wired.
4. Starter plan = **3 monitors max** on collector workspace.
5. Remote Browser Run / Workers AI evaluation fixtures not smoke-tested in this agent.
