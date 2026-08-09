# Cursor Start Here — PulseWatch by OrangeCloud

You are the primary senior engineer responsible for completing and deploying this repository.

## Target

Build and deploy **PulseWatch by OrangeCloud**, the commercial multi-tenant social-listening SaaS described in this repository.

Production target:
- Product name: **PulseWatch**
- Endorsed brand: **PulseWatch by OrangeCloud**
- Cloudflare account: **Cloudspace**
- Account ID (deployment target reference only): `4c15704ef706b9c8954cd6f9feb678d8`
- Production hostname: `reputation.orangecloud.vn` (technical hostname; do not treat as product display name)
- Owner/super-admin: explicit `super_admin` role with commercial quota bypass, while still respecting platform safety/rate limits.
- Core SLA: important supported-source negative alerts P95 `< 15 minutes`.

Brand docs: `docs/BRAND_KIT.md`, `docs/SEO_MARKETING.md`, `docs/MARKETING_COPY_BANK.md`.

## Mandatory first pass — analyze only

Before editing any file:
1. Read `AGENTS.md`.
2. Read `BUILD_STATUS.md`.
3. Read `docs/BUILD_HANDOFF_INDEX.md`.
4. Read all architecture documents referenced by that index, especially:
   - `docs/TECHNICAL_SPEC.md`
   - `docs/DATA_MODEL.md`
   - `docs/QUEUE_CONTRACTS.md`
   - `docs/CRAWLER_ALGORITHM_SPEC.md`
   - `docs/CRAWLER_AND_SOURCES.md`
   - `docs/SOURCE_DISCOVERY_ENGINE.md`
   - `docs/SOURCE_COVERAGE_MATRIX.md`
   - `docs/UI_UX_SPEC.md`
   - `docs/AUTH_BILLING_SUPERADMIN.md`
   - `docs/WRANGLER_BINDINGS_ARCHITECTURE.md`
   - `docs/SRE_RUNBOOK.md`
   - `docs/IMPLEMENTATION_ROADMAP.md`
5. Inspect every `wrangler.jsonc`, root `package.json`, tests, current Worker code and dashboard.
6. Run existing validation commands before changing code.
7. Return a short current-state report and exact implementation/deployment plan.

Do **not** start broad rewrites before completing this discovery pass.

## Implementation objective

Continue from the current `BUILD_STATUS.md` until the application is production-ready, prioritizing incomplete work in this order:

1. Production-grade sharded scheduler/due-monitor index.
2. RSS, sitemap, news and federated discovery providers.
3. Semantic dedupe / Vectorize and story clustering.
4. Full mention/detail/filtering/alert dashboard UX.
5. Durable alert-delivery idempotency and reconciliation.
6. Source adapters for YouTube, X, Reddit, Facebook, TikTok and LinkedIn using lawful supported access modes.
7. Virality tracking and cluster-level alerts.
8. Reports and production hardening.
9. Authentication UX, subscriptions, metering, billing webhook/provider adapter and super-admin console.
10. Cloudflare production provisioning, deployment, routes and smoke tests.

## Non-negotiable architecture

- Cloudflare-native runtime.
- Workers for stateless compute.
- SQLite-backed Durable Objects for strongly consistent per-entity operational state.
- Never create one global Durable Object database.
- R2 owns raw HTML/JSON/media/snapshots/reports and other large payloads.
- Queues are the distributed frontier and async backbone.
- Workflows only for durable multi-step orchestration, not every tiny fetch.
- Workers AI for inference where justified; deterministic/cheap filters before expensive AI.
- Vectorize for semantic dedupe/clustering where useful.
- KV only for read-heavy configuration/cache where eventual consistency is acceptable.
- `fetch()` first; Browser Run only when extraction quality requires JavaScript rendering.
- Domain coordination and Browser Run concurrency must remain controlled by dedicated DO coordination.
- Crawl once, match many.
- Canonical Boolean AST must be evaluated again after source content is fetched.
- Potential negative content uses a priority lane so neutral backlog cannot break the `<15 min` objective.
- Every tenant-scoped operation must be authorization-checked server-side.
- Never put authorization truth only in client-controlled tokens.
- Never allow public signup/query to assign `super_admin`.

## Source policy

"All sources" means maximum supported public/lawful coverage, not CAPTCHA/login bypass.

Each source adapter must declare capability/status such as:
- `native-api`
- `public-web`
- `licensed-provider`
- `contract-required`
- `degraded`
- `disabled`

If credentials/contracts are unavailable:
- implement the real adapter boundary, configuration, fixtures and health state;
- mark the integration unavailable/degraded;
- never fake production data or claim live coverage.

Do not bypass CAPTCHA, private groups, login walls or platform access controls.

## Cloudflare deployment rules

Read `docs/DEPLOYMENT_CLOUDSPACE.md` before provisioning anything.

- Do not commit secrets.
- Do not hardcode the Cloudspace account ID into runtime source code. It is deployment metadata only.
- Replace placeholder KV namespace IDs and other resource identifiers with provisioned values.
- Keep dev/staging/production resources isolated.
- Validate `wrangler types` after bindings are provisioned.
- Deploy state/Durable Objects before Workers that bind to them.
- Use production hostname `reputation.orangecloud.vn`.
- Preferred same-origin routes:
  - `reputation.orangecloud.vn/api/*` → API Worker
  - `reputation.orangecloud.vn/*` → dashboard/assets Worker
- Verify the zone actually belongs to the selected Cloudspace account before route changes.
- Preserve a rollback path to previous Worker versions.

## Validation gate after every implementation slice

Run the repository's real commands, including as applicable:
- `npm install`
- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run validate`
- `npm run wrangler:types`
- relevant `wrangler dev --remote` or equivalent binding smoke tests

Add tests for changed behavior. Never report success for a command that was not run.

For auth, billing, Durable Object schema, queues, source policy, deployment or secrets, perform a second production review before shipping.

## Required final delivery from Cursor

When the full requested implementation/deployment is complete, report:
1. Current production URL and API health endpoint.
2. Cloudflare resources created/used by environment.
3. Workers/routes deployed.
4. Validation/test results.
5. Source coverage matrix with live/degraded/disabled status.
6. Required credentials/contracts still missing.
7. Billing status and plan enforcement status.
8. SLO/observability status.
9. Rollback procedure.
10. Update `BUILD_STATUS.md` to reflect only verified facts.
