# Deployment Guide — Cloudspace / reputation.orangecloud.vn

## Target

- Cloudflare account name: `Cloudspace`
- Account ID reference: `4c15704ef706b9c8954cd6f9feb678d8`
- Zone/hostname target: `orangecloud.vn` / `reputation.orangecloud.vn`

The account ID is deployment metadata. Do not place it in application runtime source or commit credentials.

## Preflight

1. Authenticate Wrangler to the intended Cloudflare identity.
2. Confirm `wrangler whoami` includes Cloudspace.
3. Verify the `orangecloud.vn` zone is in Cloudspace before changing DNS/routes.
4. Run local validation:
   - `npm install`
   - `npm run validate`
5. Inventory every placeholder in `wrangler.jsonc`, especially fake KV namespace IDs (`000...`).
6. Run a resource diff before creating anything. Reuse intentionally matching resources; do not silently reuse unrelated resources.

## Resource classes required

Expected production resource families:

- Workers:
  - state
  - api
  - dashboard/assets
  - scheduler
  - discovery
  - crawler-fetch
  - crawler-browser
  - processor
  - ai-classifier
  - alerts
  - later: reports / billing webhook if separated
- Durable Objects:
  - UserDirectoryDO
  - TenantDirectoryDO
  - MonitorDO
  - TenantBudgetDO
  - DomainCoordinatorDO
  - BrowserPoolDO
- R2:
  - raw content/data lake bucket
  - optional reports/exports bucket if later separated
- KV:
  - CONFIG_KV
  - CRAWL_CACHE
  - NOTIFY_CONFIG
- Queues/DLQs:
  - discovery normal / priority
  - crawl static / browser
  - process content
  - AI normal / priority
  - alerts
  - DLQs for each failure domain
- Workers AI binding
- Browser Run binding
- Analytics Engine datasets
- Vectorize index when semantic dedupe/clustering is enabled
- Email Service binding when sender configuration is ready

## Deployment order

1. Provision KV/R2/Queues/Vectorize and record IDs/names.
2. Replace placeholder resource IDs in environment-specific Wrangler configuration.
3. Deploy `workers/state` first so Durable Object migrations/classes exist.
4. Run `wrangler types` for state and every Worker with changed bindings.
5. Deploy workers that bind to state:
   - scheduler/discovery
   - crawler-fetch
   - crawler-browser
   - processor
   - ai-classifier
   - alerts
   - api
6. Deploy dashboard/assets Worker.
7. Configure same-origin production routing after zone verification:
   - `reputation.orangecloud.vn/api/*` → production API Worker
   - `reputation.orangecloud.vn/*` → production dashboard Worker
8. Update API production `ALLOWED_ORIGINS` to `https://reputation.orangecloud.vn`.
9. Do not enable email alerts until a verified sender/domain configuration exists.
10. Provision secrets using Wrangler/Cloudflare secret mechanisms, never plain committed vars.

## Smoke tests

Minimum production smoke tests:

- Homepage responds successfully at `https://reputation.orangecloud.vn`.
- API health endpoint responds under `/api/...` as implemented by the repo.
- Signup/login/logout and session revocation work.
- Create workspace/monitor/query.
- Cross-tenant access is denied.
- Boolean validation works for Vietnamese/Unicode queries.
- Scheduler can enqueue a controlled test monitor.
- Discovery emits candidates.
- Static fetch crawler persists raw content to R2.
- A JS-heavy controlled page exercises Browser Run fallback.
- Processor deduplicates and evaluates relevance.
- Workers AI remote call succeeds or explicit fallback/degraded state is visible.
- Negative test mention creates one idempotent alert.
- Telegram/email only tested when corresponding credentials/config are present.
- Analytics/trace IDs make the complete pipeline observable.

## Production routing caution

Do not assume the zone exists in this account. Verify it first. If the zone is in a different Cloudflare account, stop and report the mismatch instead of moving DNS or silently deploying elsewhere.

## Rollback

- Record deployed Worker versions before route cutover.
- Keep prior route configuration documented.
- Avoid destructive Durable Object migrations.
- Any schema evolution must be backward compatible through the rollback window.
- If the crawler/AI pipeline degrades, disable or slow affected source adapters rather than disabling authentication/dashboard availability.
