# BUILD_STATUS

Last updated: 2026-10-18 (collector credentials removed from the repo; set them in the environment)

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

Auto-bootstrapped after each production deploy (`npm run bootstrap:collection`).

Collector email and password were removed from this file. Bootstrap requires `COLLECTOR_EMAIL` and `COLLECTOR_PASSWORD` and exits if either is missing. The production super-admin allowlist is only the Worker secret `SUPER_ADMIN_EMAILS`, written from that environment variable at deploy time. Git history still has the previous collector password. `scripts/operator-account.mjs` resets that hash and revokes every session when the request carries a valid HMAC signature (`X-Operator-Timestamp`, `X-Operator-Nonce`, `X-Operator-Signature`). The raw operator secret is not a header. The application does not log it. Cloudflare Workers Logs stores a legacy `X-Operator-Secret` header when a stale client sends it. A `super_admin` session alone receives 403 on reset and on lock. No operator headers and no session is 401. The ordered steps are in `docs/SRE_RUNBOOK.md`. Unit tests cover the routes. The signature scheme is not deployed; production still has the previous `X-Operator-Secret` header until this branch is merged and the main deploy runs.

| Field | Value |
|---|---|
| Role | `super_admin` when the collector email is listed in `SUPER_ADMIN_EMAILS` |
| App | https://reputa-dashboard-production.sycu-lee.workers.dev/app/ |
| Monitors | Cloudflare, OrangeCloud, AI Agents, Cybersecurity, Vietnam Tech |

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
- Retry storm: merged on main as `0f89943`. That commit requeued `domain_busy` / `browser_pool_busy` with a flat jittered 30–60s delay. Main replaces that delay with exponential hop backoff, described in the crawl queues bullet below. The per-tenant URL cap counts real fetch failures only, not congestion delays. Permanent 4xx, including browser `browser_http_401/402/404/422`, and `browser_extraction_too_small` are acked. A browser cache hit is forwarded to processing. `syn-*`, `utm_*`, and `fbclid` are stripped before dedupe. `ft.com` and `nytimes.com` (override with `HARD_PAYWALL_HOSTS`) are skipped before fetch or Browser Run. `domain_busy` is logged at info as `crawl_domain_busy`.
- Domain busy coalesce (this branch, not deployed): `domain_busy` is parked on `DomainCoordinatorDO`, one row per tenant, monitor (or job), and URL, per fetch or browser lane. The per-tenant cap is 1024 and the per-domain ceiling is 4096. A full list logs `crawl_domain_park_full` at warn and re-sends that job. One wake token is in flight per domain and lane; a mismatched token is acked. The wake drains up to 32 jobs and deletes a row only after that job runs. Claims rotate by tenant, oldest row inside a tenant. The browser lease starts at 2 and grows with the browser-lane parked queue up to 8 (`2 + floor(waiting / 32)`). Each lease expires after 60 seconds, so a missed release cannot stick the counter. A release without a lease id does not drop a held slot. A busy wake of at most 60 seconds is sent again with a delay that doubles from 2 seconds to a 30 second cap and ±20% jitter, and the hop does not increase. A wake that ran jobs resets that counter. Three hot domains add 366–459 of those wake writes in the first hour. A longer busy wait is still at most 30 seconds and does climb. A wake that made progress is sent again after about a second with hops reset to 0. Hop 12 logs `crawl_congestion_cap` at warn and counts it once. `congestionLifetime` increases at most once per 15 minutes per row (`lastLifetimeIncAt`). A simulation with a wait over 60 seconds first dead-letters 32 rows at 235 minutes, 64 rows at 235 minutes, and 500 rows at 238 minutes. The sweep generation survives wake deletion. The alarm re-arms a missing wake onto the crawl queue and does not dead-letter those rows. A failed DLQ send or park update retries after 1, 2, 4, … seconds up to 60, per lane. Kept visits log `crawl_domain_park_kept`. Lifetime expiry logs `crawl_domain_park_lifetime`. A stranded wake logs `crawl_domain_park_stranded`. Past 12 lifetimes the job is sent to `CRAWL_DLQ` with reason `crawl_domain_park_lifetime` and the domain, and the row is deleted only after that send is accepted. The event is counted per domain. The domain alarm is `max(parked_at, wake_at) + 15 minutes` and at least 60 seconds ahead. When it fires on a wake that has been dead for 15 minutes, each stranded job is sent to `CRAWL_DLQ` first, then logged as `crawl_domain_park_stranded` with count 1 and recorded in `domain_park_events`. The row is deleted only after that send is accepted. A missing binding or a failed send leaves the row. The alarm is rewritten only when the earliest deadline changes. Deploy `reputa-state` before the crawler workers. `browser_pool_busy` and Browser Run session limits still re-send per message. `too many requests`, `rate limit exceeded`, `rate limited`, `rate_limited`, `ratelimited`, and `rate limiting` are re-sent only as whole words. A permanent 4xx is logged as a skip before the session label. A fetch error, including `Rate limit exceeded` with no `upstream_` prefix, still counts toward the per-URL cap. A wake does not charge the carrier tenant. "Too many requests" is re-sent because it is the published Quick Actions 429 text; `message.retry()` would dead-letter it after three attempts. Verified locally on 2026-10-18 with `npm run typecheck`, `npm run lint`, and `npm test` (175 passed). No `wrangler deploy`, no secret put, and no queue purge.
- Crawl queues: production logs show `message.retry()` reaches attempt 4 and then stops, so congestion that used `retry()` already enters the DLQ. A 17:17 UTC+7 read showed both consumers at concurrency 250 (the push-consumer cap, because `max_concurrency` was unset). Static backlog 1,125, oldest 15 October 00:54; browser backlog 194 and growing, oldest 15 October 00:45; browser last hour about 68% of terminal outcomes went to the DLQ. The browser worker's `quickAction("content")` turned HTTP 429 and session-limit errors into `message.retry()`. Those, plus `domain_busy` and `browser_pool_busy`, are now re-sent with `delaySeconds` of `max(hint, 30s × 2^hop)` capped at 900s (30, 60, 120, 240, 480, then 900) and `congestionHops`, then the original is acked. Twelve hops cover 7,230 seconds, about 2 hours. After that the worker logs `crawl_congestion_cap` at warn and writes one Analytics Engine point (`blobs: [crawl_congestion_cap, fetch|browser]`, `doubles: [1]`). Browser Run text `rate limit exceeded` and `rate limited` is congestion even without a `browser_http_429` prefix. Re-sending does not raise the per-domain browser lease (`maxConcurrency` 2). Real 5xx, network, and upstream 429 failures still use `message.retry()` and `max_retries` 3. Static consumers are capped at concurrency 80, batch 10, timeout 5s. Browser consumers are capped at concurrency 200 (Workers Paid concurrent browsers) and batch size 1. Why the 15 October head is not the message being delivered is a hypothesis in `docs/CRAWL_DLQ_PROPOSAL.md`, not a finding. DLQ handling in that note is not executed. Verified locally on 2026-10-18 with `npm run typecheck`, `npm run lint`, and `npm test` (106 passed). `npm run wrangler:types:browser` was run for the producer bindings on the previous commit. Consumer `max_concurrency` does not change generated types.

## Remaining gaps (honest)

1. Brave / YouTube / X / Reddit OAuth still need operator-supplied secrets.
2. Custom host DNS / CF challenges may still affect `/api` on `reputation.orangecloud.vn` — prefer workers.dev API base.
3. Billing webhook secret not configured (`billing_webhook_not_configured`); plan changes via Stripe Payment Links / manual DO until wired.
4. Starter plan = **3 monitors max** on collector workspace.
5. Remote Browser Run / Workers AI evaluation fixtures not smoke-tested in this agent.
