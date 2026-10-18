# Secrets and Provider Access Checklist

Never commit real values from this checklist.

## Cloudflare

Required at deploy/operator level:
- Cloudflare auth with access to account `Cloudspace`.
- Permission to manage Workers, Durable Objects, R2, KV, Queues, Browser Run, Workers AI, Vectorize, Analytics Engine, DNS/Workers Routes and Email Service as required.

## Discovery/search

Always-on free discovery (no API key):
- Public news RSS via Hacker News (`hnrss.org`), Bing News RSS (publisher URLs unwrapped from apiclick), and Google News RSS (interstitial URLs skipped)
- Public Reddit search Atom/RSS (`reddit.com/search.rss`) for post permalinks only — OAuth Reddit remains preferred for commercial scale
- Optional static `RSS_FEED_URLS` / `SITEMAP_URLS` (comma-separated) — merged with the always-on default registry in `packages/source-adapters/src/default-rss-feeds.ts` (TechCrunch / Verge / Ars / Wired / VentureBeat / Crunchbase / Sifted / Tech in Asia / Product Hunt / YC / eng blogs / VN tech press, plus query-scoped tech/startup `site:` news clusters)

Optional paid/search upgrade:
- `BRAVE_SEARCH_API_KEY` on `reputa-discovery-*` for Brave web + news search

Add providers behind source-adapter interfaces rather than hard-coding provider logic into the pipeline.

Bootstrap a live collector workspace after deploy. Required environment variables, never committed:

- `COLLECTOR_EMAIL`
- `COLLECTOR_PASSWORD`

The script exits if either is missing. Optional: `API_BASE`, `COLLECTOR_WORKSPACE`, `COLLECTOR_SCAN_INTERVAL_SEC`, `COLLECTOR_PRIORITY`.

```bash
node scripts/bootstrap-production-collection.mjs
```


## Social/native source credentials

Only configure credentials for access actually approved for this commercial use case.
Potential adapters:
- YouTube Data API key/OAuth as required
- X API credentials/plan
- Reddit approved commercial/API credentials or licensed-provider contract
- Meta/Facebook permissions/products appropriate to the supported public data use case
- TikTok approved commercial/public access mechanism if available for the required data
- LinkedIn approved products/permissions if available for the required data

If access is unavailable, adapter status must be `contract-required`, `degraded` or `disabled`; never substitute login scraping/CAPTCHA bypass.

## Alerts

- Telegram bot token and target/chat configuration if Telegram alerts are enabled
- Cloudflare Email Service verified sender/domain configuration if email alerts are enabled

The repo currently contains placeholder email values; do not treat them as production configuration.

## Billing

The billing architecture is provider-abstracted. Configure a real payment provider only after inspecting `docs/AUTH_BILLING_SUPERADMIN.md` and the implementation.
Likely secret categories:
- payment provider secret API key
- webhook signing secret
- price/product IDs as non-secret configuration where appropriate

Do not store full card data in Workers, R2, KV or Durable Objects.

## Super admin bootstrap

Do not expose `super_admin` assignment through public signup/profile APIs.
Bootstrap the owner using an explicit secure operator-only procedure and record an audit event.

## Account reset and lock

`OPERATOR_ACCOUNT_SECRET` is required at deploy. Generate it with `openssl rand -base64 32`. `scripts/deploy-cloudspace.mjs` exits before publish if it is empty, then stores it with `wrangler secret put` on the API Worker. Do not commit the value. The GitHub Actions workflow passes this secret only to the deploy step.

`scripts/operator-account.mjs` calls the admin account routes with that secret. Reset and lock reject a session that does not also send `X-Operator-Secret`. `ACCOUNT_NEW_PASSWORD` is read from the environment and is never printed. `recover-smoke` rebuilds historical smoke addresses from tenant registry names `Deploy Smoke` and `API Prefix Smoke`, refuses to run unless `SMOKE_RUN_START_MS` and `SMOKE_RUN_END_MS` are a valid window, prints the planned lock-request count, and sends those locks only when `RECOVER_SMOKE_CONFIRM=yes`. See `docs/SRE_RUNBOOK.md` for the order of operations after a credential leak. Denial audits are capped per user id, ignoring cf-ray, and do not block a valid operator secret. Failed operator-secret comparisons are capped at 8 per IP per 60 seconds inside one Worker isolate, checked before the secret is compared, including when a cookie is sent. A correct secret is not recorded. After 8 failures the next attempt is `429` with `Retry-After`, and `scripts/operator-account.mjs` waits and retries. A Workers Rate Limiting binding is not configured. A WAF rule of about 10 requests per minute per IP on `/v1/admin/accounts*` and `/v1/admin/tenants` is recommended and is not applied; it needs approval before anyone creates it. These routes are not in production until this branch is merged and deployed.
