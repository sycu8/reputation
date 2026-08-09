# Queue and Workflow Contracts

## 1. Queues

Recommended logical queues:

```text
discovery-normal
discovery-priority
crawl-static
crawl-browser
process-content
process-ai
process-ai-priority
alerts
reports
dlq-discovery
dlq-crawl
dlq-process
dlq-ai
dlq-alerts
```

## 2. Common job envelope

```ts
export interface JobEnvelope<T> {
  version: 1;
  jobId: string;
  traceId: string;
  tenantId?: string;
  monitorId?: string;
  createdAt: string;
  attempt: number;
  priority: 'normal' | 'high' | 'critical';
  payload: T;
}
```

## 3. DiscoveryJob

```ts
interface DiscoveryJobPayload {
  monitorId: string;
  queryId: string;
  source: string;
  queryVersion: string;
  windowStart?: string;
  windowEnd?: string;
  cursor?: string;
}
```

Idempotency key:

```text
sha256(monitorId + queryId + source + timeBucket + cursor)
```

Output: CrawlJob(s) + updated source cursor/checkpoint.

## 4. CrawlJob

```ts
interface CrawlJobPayload {
  source: string;
  url?: string;
  sourceNativeId?: string;
  adapterId: string;
  fetchMode: 'static' | 'browser' | 'auto';
  discoveredAt: string;
  requestingMonitors: Array<{tenantId: string; monitorId: string}>;
}
```

A crawl job may be coalesced for multiple monitors.

## 5. ProcessContentJob

```ts
interface ProcessContentJobPayload {
  contentId: string;
  rawR2Key: string;
  source: string;
  requestingMonitors: Array<{tenantId: string; monitorId: string}>;
}
```

Steps:
- normalize
- canonicalize
- fingerprint
- dedupe
- keyword candidate matching
- emit AI jobs only for monitor candidates

## 6. AIJob

```ts
interface AIJobPayload {
  contentId: string;
  tenantId: string;
  monitorId: string;
  queryVersion: string;
  normalizedTextRef: string;
  deterministicSignals: Record<string, number | string | boolean>;
}
```

Priority promotion conditions:
- deterministic negative phrase/risk signal
- unusually high engagement
- source authority high
- active incident state

## 7. AlertJob

```ts
interface AlertJobPayload {
  alertId: string;
  tenantId: string;
  monitorId: string;
  mentionId: string;
  channels: Array<'email' | 'telegram' | 'slack' | 'teams' | 'webhook'>;
}
```

Consumer must verify alert state before sending to prevent duplicates.

## 8. Retry strategy

Default:
- discovery transient: 3 retries
- static crawl: 3 retries
- browser crawl: 2 retries
- process: 3 retries
- AI: 2 retries + fallback route
- notification: 5 retries for transient provider errors

Backoff: exponential + jitter.

Permanent errors route to terminal state, not infinite retry.

## 9. DLQ processing

DLQ record must preserve:
- original envelope
- last error class
- last error message
- attempts
- first failure time
- last failure time

Admin tooling must support:
- inspect
- replay
- discard with reason

## 10. Workflow usage

Use Workflows for coarse multi-step units, not every fetch.

### MonitorScanWorkflow

```text
load monitor snapshot
 -> enqueue discovery jobs
 -> await/check completion markers
 -> aggregate scan statistics
 -> update adaptive schedule
 -> finish scan run
```

### DailyReportWorkflow

```text
load daily metrics
 -> identify top stories/negative mentions
 -> AI summarize
 -> write report to R2
 -> enqueue notification
```
