# SRE and Production Runbook

## 1. Critical SLO

Most important production SLO:

> P95 detection-to-alert latency for important negative mentions < 15 minutes.

Track separately:
- discovery delay
- queue delay
- crawl delay
- processing delay
- AI delay
- notification delay

## 2. Dashboards

Minimum internal dashboard panels:
- total active monitors
- due monitors
- discovery jobs/min
- crawl jobs/min
- browser jobs/min
- queue depth by queue
- oldest message age
- crawl success % by source
- 403/429 rates by source/domain
- browser utilization
- AI latency/error rate
- negative mentions/min
- alerts/min
- P50/P95 end-to-end latency
- DLQ depth

## 3. Alerting thresholds

Page/urgent:
- P95 important detection >15 min for 15 min
- priority queue oldest message >3 min
- alert queue oldest message >1 min
- widespread crawler failure on top source
- Browser Pool saturation >90% sustained
- DO error rate spike

Ticket/non-urgent:
- source parse failure >5%
- dedupe anomaly
- source schema drift
- rising DLQ but no user impact

## 4. Incident: source starts returning 429

1. verify source/domain scope
2. DomainCoordinatorDO increases backoff
3. reduce concurrency
4. honor Retry-After
5. disable browser fallback if it amplifies rate
6. preserve source health degraded state
7. do not silently claim full coverage

## 5. Incident: browser saturation

1. verify `crawl-browser` queue age
2. promote critical jobs
3. reduce low-priority browser fallbacks
4. prefer cached/fetch results where acceptable
5. increase quiet-monitor intervals
6. inspect source causing disproportionate browser use

### Browser pool stuck (`browser_pool_busy` / HTTP 429 from BrowserPoolDO)

`BrowserPoolDO` (name `global` on `reputa-state-production`) tracks leases, not a bare counter. Expired leases are deleted on acquire/release and by the Durable Object alarm. A crashed crawl cannot pin a slot past the lease TTL (90 seconds).

Deploy `reputa-state-production` before `reputa-crawler-browser-production`. The new class ignores the legacy `pool_state.active` counter (the value that wedged production at 100) and counts unexpired `pool_leases` rows, so the pool unsticks on the first acquire after that deploy.

To zero leases explicitly after deploy:

1. Set a secret on the state worker (do not commit it):

```text
npx wrangler secret put BROWSER_POOL_RESET_TOKEN --config workers/state/wrangler.jsonc --env production
```

2. Confirm capacity, then reset. The cap defaults to the Workers Paid Browser Run concurrent-browser limit (200 as of 2026-08-20). Override with the `BROWSER_POOL_MAX` var when the account limit differs. Quick Actions are additionally limited to 30 requests/second on Workers Paid.

```text
curl -sS -H "Authorization: Bearer $BROWSER_POOL_RESET_TOKEN" \
  https://reputa-state-production.sycu-lee.workers.dev/internal/browser-pool/state

curl -sS -X POST -H "Authorization: Bearer $BROWSER_POOL_RESET_TOKEN" \
  https://reputa-state-production.sycu-lee.workers.dev/internal/browser-pool/reset
```

The reset route fails closed (HTTP 503) until the secret is set, and HTTP 401 on a wrong token. It deletes lease rows and sets the legacy counter back to 0. It does not touch tenant, monitor, or crawl data.

## 6. Incident: AI backlog

1. separate priority and normal queues
2. ensure deterministic filters are still reducing volume
3. process High/Critical candidates first
4. temporarily reduce deep analysis for low-value neutral content
5. do not degrade critical-alert path unless unavoidable

## 7. Incident: false negative alerts

1. identify monitor/query/model version
2. inspect raw content + target entity
3. record feedback
4. patch deterministic rules or prompt/model threshold
5. version config
6. replay recent affected candidate set

## 8. Incident: false positive relevance

1. inspect Boolean AST result
2. inspect aliases/exclusions
3. inspect cheap relevance classifier
4. add tenant/monitor feedback signal
5. never globally suppress a term from one tenant's feedback without evidence

## 9. Rollback

Worker code:
- deploy versioned Workers
- rollback to previous known-good version

Config:
- KV config is versioned
- jobs reference config version

DO schema:
- additive migrations first
- backward-compatible readers during rollout
- destructive changes only after data migration and validation

## 10. Incident: leaked account password

Use this after a collector or smoke-account password has been committed. Do not put the old or new password in the repo, the shell history you commit, or the pull request.

The product stores the hash on the user Durable Object for that email. `scripts/operator-account.mjs reset-password` replaces the hash and sets `revoked_at` on every session row for that account. `lock` sets the account to `suspended` (or `deleted` when `ACCOUNT_LOCK_STATUS=deleted`) and revokes every session. Login and session checks reject any status other than `active`.

Reset and lock both require `X-Operator-Secret` for every target. A session alone, including `super_admin`, receives `403 operator_secret_required`. Generate `OPERATOR_ACCOUNT_SECRET` outside the repo with `openssl rand -base64 32`. Denial audits are capped at 8 per actor per account per 60 seconds and do not apply to a valid operator secret. Anonymous wrong-secret guesses are capped at 8 per IP per 60 seconds inside one Worker isolate. A correct secret from that IP still succeeds. A Workers Rate Limiting binding is not configured, because that binding needs a Cloudflare config change. These routes are not deployed until this change is on `main` and the deploy workflow runs.

Ordered steps:

1. Set GitHub Actions secrets `SUPER_ADMIN_EMAILS`, `COLLECTOR_EMAIL`, and `OPERATOR_ACCOUNT_SECRET`. Generate the operator secret with `openssl rand -base64 32` and do not commit the output. Leave `COLLECTOR_PASSWORD` unset. Leave `DEPLOY_SMOKE_PASSWORD` unset so deploy does not create more smoke accounts.
2. Merge and deploy. A push to `main` deploys. `workflow_dispatch` deploys only when the selected ref is `refs/heads/main`. `OPERATOR_ACCOUNT_SECRET` is passed only to the deploy step. Deploy writes `SUPER_ADMIN_EMAILS` and `OPERATOR_ACCOUNT_SECRET` and exits before publish if either is empty. The bootstrap step skips while `COLLECTOR_PASSWORD` is empty. That skip is expected.
3. Reset the collector account. `TARGET_EMAIL` is the address stored in `COLLECTOR_EMAIL` (previously recorded at `BUILD_STATUS.md:63`). `ACCOUNT_NEW_PASSWORD` is a new password that has never been committed.

```text
API_BASE=https://reputa-api-production.sycu-lee.workers.dev \
OPERATOR_ACCOUNT_SECRET="$OPERATOR_ACCOUNT_SECRET" \
TARGET_EMAIL="$COLLECTOR_EMAIL" \
ACCOUNT_NEW_PASSWORD="$ACCOUNT_NEW_PASSWORD" \
node scripts/operator-account.mjs reset-password
```

4. Read `sessionsRevoked` in that command's output. The reset is the revocation: every session for that account has `revoked_at` set. Run the same command again if a new session appears before you finish. Do not log in with the previous password.
5. Disable smoke accounts from the tenant registry, not from signup logs. Signup bodies were never logged. Deploy created a workspace named exactly `Deploy Smoke` (`deploy-smoke-<unix-ms>@example.com`) or `API Prefix Smoke` (`deploy-api-prefix-<unix-ms>@example.com`). The registry row stores `name` and `createdAt`, not the email. `createdAt` is server time after signup, so the email's `Date.now()` is near `createdAt` and usually earlier. `recover-smoke` exits before any request unless `SMOKE_RUN_START_MS` and `SMOKE_RUN_END_MS` are both finite unix milliseconds and the start is not after the end. Take them from that GitHub Actions run (start through completion). The script keeps registry rows with those names inside the run window, then tries addresses from 2 seconds after `createdAt` back to 15 seconds before it, and stops at the first account that exists. The total span is capped at 60 seconds. A miss creates an empty user Durable Object, so narrow the run window before probing. This command does not lock the collector.

```text
API_BASE=https://reputa-api-production.sycu-lee.workers.dev \
OPERATOR_ACCOUNT_SECRET="$OPERATOR_ACCOUNT_SECRET" \
SMOKE_RUN_START_MS="$SMOKE_RUN_START_MS" \
SMOKE_RUN_END_MS="$SMOKE_RUN_END_MS" \
node scripts/operator-account.mjs recover-smoke
```

`GET /v1/admin/accounts` lists only accounts created, reset, or locked after the directory was added. It does not enumerate older smoke accounts. An address that cannot be reconstructed cannot be locked, because each user Durable Object is sharded by the SHA-256 of the email. Do not widen the probe into a multi-minute sweep.

6. Set the GitHub secret `COLLECTOR_PASSWORD` to the same new password used in step 3. Then run `npm run bootstrap:collection` with `COLLECTOR_EMAIL` and `COLLECTOR_PASSWORD` set. Bootstrap logs in with that password, so the stored hash from step 3 must already match.

## 11. Cost controls

Primary cost levers:
- browser fallback rate
- AI deep-analysis rate
- crawl duplication
- source refresh intervals
- retention policy

Never optimize cost by dropping High/Critical candidate processing first.
