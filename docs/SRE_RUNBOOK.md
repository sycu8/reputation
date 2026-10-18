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

2. Confirm capacity, then reset. The cap defaults to the Workers Paid Browser Run concurrent-browser limit (200 as of 2026-08-20). Override with the `BROWSER_POOL_MAX` var when the account limit differs. Quick Actions are additionally limited to 30 requests/second on Workers Paid. A Browser Run HTTP 429, or an error that says the account is out of sessions, is congestion: the browser consumer re-sends the job with hop backoff instead of `message.retry()`.

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

## 10. Cost controls

Primary cost levers:
- browser fallback rate
- AI deep-analysis rate
- crawl duplication
- source refresh intervals
- retention policy

Never optimize cost by dropping High/Critical candidate processing first.
