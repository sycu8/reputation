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

`scripts/operator-account.mjs` signs admin account requests with HMAC-SHA256. The canonical string is the method, the request path and query, a unix-millisecond timestamp, a nonce, and the hex SHA-256 of the body, separated by newlines. GET and HEAD sign an empty body. The signature headers are `X-Operator-Timestamp`, `X-Operator-Nonce`, and `X-Operator-Signature`. The raw secret is not sent. Reset and lock reject a session that does not also carry a valid signature. A request with no operator headers and no session is `401`. `ACCOUNT_NEW_PASSWORD` is read from the environment and is never printed. `recover-smoke` rebuilds historical smoke addresses from tenant registry names `Deploy Smoke` and `API Prefix Smoke`, refuses to run unless `SMOKE_RUN_START_MS` and `SMOKE_RUN_END_MS` are a valid window, prints the planned lock-request count, and sends those locks only when `RECOVER_SMOKE_CONFIRM=yes`. See `docs/SRE_RUNBOOK.md` for the order of operations after a credential leak. Denial audits are capped per user id, ignoring cf-ray, and do not block a valid signature. Failed signature checks are capped at 8 per IP per 60 seconds inside one Worker isolate, checked before the HMAC is compared, including when a cookie is sent. A valid signature is not recorded. After 8 failures the next attempt is `429` with `Retry-After`, and `scripts/operator-account.mjs` waits, signs a new nonce, and retries. Signatures older than 60 seconds are rejected. A nonce that already succeeded is rejected on that same isolate for the rest of the window. A Workers Rate Limiting binding is not configured. A WAF rule of about 10 requests per minute per IP on `/v1/admin/accounts*` and `/v1/admin/tenants` is recommended and is not applied; it needs approval before anyone creates it. The signature scheme is not in production until this branch is merged and deployed. Production still accepts the raw `X-Operator-Secret` header from the previous deploy until then.

Workers Logs stores invocation logs, and those logs include request headers. The [2025-04-07 Workers changelog](https://developers.cloudflare.com/changelog/post/2025-04-07-increase-trace-events-limit/) says console messages, exceptions, request metadata, and headers are captured on `workers_trace_events`, and Workers Logs indexes that object. A Tail Worker `TailRequest` redacts a header value to `REDACTED` when the name is `cookie` or `set-cookie`, or when the name contains `auth`, `key`, `secret`, `token`, or `jwt` ([Tail handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/)). That list is a heuristic with false positives and negatives, and `getUnredacted()` returns the original values. Workers traces are separate: span attributes record header names, not header values ([traces FAQ](https://developers.cloudflare.com/observability/traces/)). Do not assume `Authorization` is redacted in Workers Logs. Production logs for `reputa-api-production` stored the `x-operator-secret` value even though that header name contains `secret`. `apps/api-worker/wrangler.jsonc` leaves `observability.logs.enabled`, `invocation_logs`, and `head_sampling_rate` at 1, so every invocation can be stored. This change does not edit that setting or the live Cloudflare config. The API worker does not `console.log` the request or its headers. `structuredLog` replaces values whose field names contain `auth`, `key`, `secret`, `token`, `jwt`, `cookie`, or `header` before printing.
