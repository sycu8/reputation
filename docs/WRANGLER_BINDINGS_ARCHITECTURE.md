# Wrangler & Cloudflare Binding Architecture

## Purpose

This document is the canonical deployment/binding design for the social-listening SaaS. New Workers must not invent storage ownership or duplicate bindings without updating this document.

Cloudflare recommends `wrangler.jsonc` for new projects. Treat each Worker config as the source of truth and generate Env types with `wrangler types` instead of hand-writing binding interfaces.

## Deployment model

Use a monorepo with independently deployable Workers. Keep edge request paths small; isolate asynchronous workloads by responsibility.

Recommended applications/workers:

- `apps/dashboard` — static/assets + thin BFF if required.
- `workers/api` — authenticated customer API.
- `workers/scheduler` — due-monitor discovery trigger.
- `workers/discovery` — search/RSS/source discovery producer/consumer.
- `workers/crawler-fetch` — static fetch extraction.
- `workers/crawler-browser` — Browser Run rendering/extraction.
- `workers/processor` — normalize, dedupe, relevance.
- `workers/ai-classifier` — sentiment/topic/deep severity analysis.
- `workers/alerts` — notification delivery.
- `workers/reports` — daily/weekly workflow entrypoints.

Durable Object classes may live in dedicated state Worker modules if service boundaries are clearer:

- `TenantDirectoryDO`
- `MonitorDO`
- `DomainCoordinatorDO`
- `BrowserPoolDO`
- `TenantBudgetDO`

## Core rule: binding minimization

A Worker receives only the bindings needed for its responsibility. Do not bind all R2 buckets, queues, or DO namespaces to every Worker.

This limits blast radius, prevents accidental coupling, and makes generated Env types useful.

## Binding ownership map

| Worker | Inbound | Core bindings | Produces to | Reads/writes |
|---|---|---|---|---|
| api | HTTP | TENANT_DO, MONITOR_DO, CONFIG_KV, service bindings | alerts/control jobs when needed | tenant/monitor operational state |
| scheduler | scheduled/Workflow | MONITOR_DO or scheduler shard DO, DISCOVERY_PRIORITY/NORMAL | discovery queues | due scan state |
| discovery | queue | CONFIG_KV, R2 optional, service adapters | CRAWL_STATIC/Crawl Browser | discovery candidates/cursors |
| crawler-fetch | queue | R2_RAW, DOMAIN_DO, CONFIG_KV | PROCESS_CONTENT, CRAWL_BROWSER fallback | raw static content |
| crawler-browser | queue | BROWSER, BROWSER_POOL_DO, DOMAIN_DO, R2_RAW | PROCESS_CONTENT | rendered content/screenshots |
| processor | queue | R2_RAW, MONITOR_DO, VECTORIZE optional, AI optional cheap models | AI_PRIORITY/AI_NORMAL/ALERT candidate | mention metadata, fingerprints |
| ai-classifier | queue | AI, MONITOR_DO, R2_RAW | ALERT_QUEUE | sentiment/topic/severity |
| alerts | queue | MONITOR_DO, CONFIG_KV, outbound provider secrets | external channels | alert state/delivery audit |
| reports | Workflow | MONITOR_DO, R2_REPORTS, AI optional | notification queue | report objects + metadata |

## Environment strategy

Use three isolated environments:

- development: local simulation by default; optional remote bindings only when a feature cannot be simulated.
- staging: real Cloudflare resources with `-stg` suffix.
- production: dedicated production resources with `-prod` suffix or canonical production names.

Never point staging at production DO namespaces, R2 buckets, queues, Vectorize indexes, or KV namespaces.

Use separate secrets per environment.

## Resource naming convention

Use deterministic names:

```text
reputa-<service>-dev
reputa-<service>-stg
reputa-<service>-prod
```

Examples:

```text
reputa-raw-content-prod
reputa-crawl-static-prod
reputa-process-ai-priority-prod
reputa-monitor-do-prod
```

The product codename can be changed later; naming consistency matters more than the prefix.

## Queue topology

Recommended queues:

```text
discovery-normal
discovery-priority
crawl-static
crawl-browser
process-content
process-ai-normal
process-ai-priority
alerts
reports-notify
```

Recommended DLQs:

```text
discovery-dlq
crawl-dlq
process-dlq
ai-dlq
alerts-dlq
```

Priority and normal paths are separated so a large neutral backlog cannot block critical-negative processing.

## R2 buckets

Recommended physical buckets per environment:

```text
raw-content
media
reports
```

Do not create a bucket per tenant. Use object prefixes for tenant/source organization while keeping raw canonical content globally reusable where policy allows.

Example raw key:

```text
raw/v1/sha256/<first2>/<sha256>/content.json
```

Tenant-specific extracted/analysis metadata belongs in MonitorDO, not duplicated raw objects.

## Durable Object namespaces

Use SQLite-backed Durable Objects for new namespaces.

Roles:

- `TenantDirectoryDO`: workspace metadata, memberships, role/config references.
- `MonitorDO`: monitor query config, source cursor state, customer-specific mention metadata, feedback, alert state.
- `DomainCoordinatorDO`: per-domain crawl leases, politeness, error/backoff state.
- `BrowserPoolDO`: browser concurrency/session lease coordination.
- `TenantBudgetDO`: strongly consistent quota counters where required.

Do not introduce a `GlobalDatabaseDO`.

## KV

`CONFIG_KV` is allowed for:

- feature flags
- source adapter configuration cache
- model/threshold configuration
- short-lived lookup cache

Do not store billing ledger, mention records, alert transactions, or source cursor truth in KV.

## Vectorize

Keep optional in early phases. Recommended use:

- semantic duplicate detection
- story clustering
- similar complaint search
- semantic relevance fallback

Store only vector metadata necessary to find the authoritative MonitorDO/R2 record.

## Analytics Engine

Use append-only datapoints for operational telemetry, not source-of-truth state.

Minimum dimensions:

```text
environment
worker
source
domain
monitor_tier
job_type
result
error_class
```

Minimum measures:

```text
latency_ms
queue_age_ms
bytes
browser_ms
mentions_emitted
ai_calls
alert_latency_ms
```

Do not put raw customer content into telemetry dimensions.

## Workflows

Use Workflows for durable multi-step operations such as:

- periodic scheduler sweep
- daily/weekly reports
- source re-enrichment jobs
- reprocessing a monitor after query changes
- controlled replay/backfill

Do not create one workflow step per page fetch if Queues are more appropriate for fan-out.

Cloudflare supports schedules directly on Workflow bindings; use this when it removes an otherwise empty scheduled Worker. Keep a standalone scheduler Worker only if it needs custom due-monitor sharding/coordination that is clearer outside the Workflow.

## Browser Run

Bind Browser Run only to `crawler-browser`.

Rules:

- static crawler decides whether escalation is required.
- BrowserPoolDO enforces concurrency budget and session leases.
- DomainCoordinatorDO still controls per-domain request policy.
- browser jobs have explicit wall-clock, navigation, page-count, and scroll limits.
- no login, CAPTCHA, authentication, or source-policy bypass.

## Service bindings

Prefer service bindings for trusted internal Worker calls that need request/response semantics. Prefer Queues for asynchronous fan-out/retries.

Suggested service bindings:

```text
api -> source-health service (optional)
api -> report retrieval service (optional)
```

Do not replace queues with chained synchronous service calls for crawling.

## Secrets

Store via Wrangler/Cloudflare secrets, not JSONC:

```text
SESSION_SECRET
EMAIL_PROVIDER_TOKEN
TELEGRAM_BOT_TOKEN
SEARCH_PROVIDER_TOKEN_*
SOCIAL_PROVIDER_TOKEN_*
```

Never commit values.

## Observability

Every deployed Worker enables Workers observability/logging. Every job carries:

```text
request_id
job_id
scan_id
tenant_id
monitor_id
source
attempt
created_at
```

Logs must be structured JSON and must redact secrets and sensitive raw content.

## Compatibility date policy

Use one compatibility date managed at repository level when possible. Upgrades are intentional changes reviewed separately; do not allow different Workers to drift without reason.

## `wrangler.jsonc` reference — crawler-browser

```jsonc
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "reputa-crawler-browser",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-09",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },

  "browser": { "binding": "BROWSER" },

  "r2_buckets": [
    { "binding": "R2_RAW", "bucket_name": "reputa-raw-content-prod" }
  ],

  "durable_objects": {
    "bindings": [
      { "name": "DOMAIN_DO", "class_name": "DomainCoordinatorDO", "script_name": "reputa-state-prod" },
      { "name": "BROWSER_POOL_DO", "class_name": "BrowserPoolDO", "script_name": "reputa-state-prod" }
    ]
  },

  "queues": {
    "consumers": [
      {
        "queue": "reputa-crawl-browser-prod",
        "max_batch_size": 5,
        "max_batch_timeout": 5,
        "max_retries": 2,
        "dead_letter_queue": "reputa-crawl-dlq-prod"
      }
    ],
    "producers": [
      { "binding": "PROCESS_CONTENT", "queue": "reputa-process-content-prod" }
    ]
  }
}
```

Note: exact queue consumer tuning must be load-tested. Do not copy batch sizes blindly to production.

## `wrangler.jsonc` reference — state Worker

```jsonc
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "reputa-state",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-09",
  "observability": { "enabled": true },

  "durable_objects": {
    "bindings": [
      { "name": "TENANT_DO", "class_name": "TenantDirectoryDO" },
      { "name": "MONITOR_DO", "class_name": "MonitorDO" },
      { "name": "DOMAIN_DO", "class_name": "DomainCoordinatorDO" },
      { "name": "BROWSER_POOL_DO", "class_name": "BrowserPoolDO" },
      { "name": "TENANT_BUDGET_DO", "class_name": "TenantBudgetDO" }
    ]
  },

  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": [
        "TenantDirectoryDO",
        "MonitorDO",
        "DomainCoordinatorDO",
        "BrowserPoolDO",
        "TenantBudgetDO"
      ]
    }
  ]
}
```

Never rewrite an already-deployed migration tag. Add new migration entries.

## `wrangler.jsonc` reference — AI processor

```jsonc
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "reputa-ai-classifier",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-09",
  "observability": { "enabled": true },

  "ai": { "binding": "AI" },

  "r2_buckets": [
    { "binding": "R2_RAW", "bucket_name": "reputa-raw-content-prod" }
  ],

  "queues": {
    "consumers": [
      {
        "queue": "reputa-process-ai-priority-prod",
        "max_batch_size": 5,
        "max_batch_timeout": 1,
        "max_retries": 2,
        "dead_letter_queue": "reputa-ai-dlq-prod"
      },
      {
        "queue": "reputa-process-ai-normal-prod",
        "max_batch_size": 20,
        "max_batch_timeout": 5,
        "max_retries": 2,
        "dead_letter_queue": "reputa-ai-dlq-prod"
      }
    ],
    "producers": [
      { "binding": "ALERT_QUEUE", "queue": "reputa-alerts-prod" }
    ]
  },

  "analytics_engine_datasets": [
    { "binding": "ANALYTICS", "dataset": "reputa_runtime_prod" }
  ]
}
```

## Environment override pattern

Prefer environment-specific resource names while keeping binding names identical in code.

Conceptual pattern:

```jsonc
{
  "name": "reputa-crawler-fetch",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-09",

  "env": {
    "staging": {
      "name": "reputa-crawler-fetch-stg",
      "r2_buckets": [
        { "binding": "R2_RAW", "bucket_name": "reputa-raw-content-stg" }
      ]
    },
    "production": {
      "name": "reputa-crawler-fetch-prod",
      "r2_buckets": [
        { "binding": "R2_RAW", "bucket_name": "reputa-raw-content-prod" }
      ]
    }
  }
}
```

Important: Cloudflare Wrangler environment inheritance rules differ by field. Codex must validate the generated config against the current Wrangler schema instead of assuming every top-level binding is inherited.

## Deployment validation

For every Worker:

```text
npx wrangler types
npm/pnpm/yarn typecheck
npm/pnpm/yarn test
npx wrangler deploy --env staging
```

Then run integration smoke tests against staging.

Production requires explicit approval and rollback reference.

## Rollback

- retain previous Worker versions.
- queue/schema changes must be backward compatible during rollout.
- producers deploy before consumers only when consumers tolerate the new envelope; otherwise use versioned envelopes.
- DO schema migrations are additive/forward-safe.
- R2 object schemas carry explicit `schema_version`.

## Sources used to verify this design

- Cloudflare Wrangler configuration: https://developers.cloudflare.com/workers/wrangler/configuration/
- Workers bindings: https://developers.cloudflare.com/workers/runtime-apis/bindings/
- Browser Run Wrangler: https://developers.cloudflare.com/browser-run/reference/wrangler/
- Durable Objects: https://developers.cloudflare.com/durable-objects/
- R2 Workers API: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- Workers AI bindings: https://developers.cloudflare.com/workers-ai/configuration/bindings/
- Workflows guide: https://developers.cloudflare.com/workflows/get-started/guide/
