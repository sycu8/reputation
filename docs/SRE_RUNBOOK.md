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
