# Crawler Algorithm Specification

## Objective

Build a distributed, Cloudflare-native discovery/crawl system that maximizes useful mention freshness and precision while keeping browser, AI, and network cost bounded.

Primary SLO:

```text
P95 important negative mention detection < 15 minutes
```

This SLO is measured from the earliest timestamp the source exposes the content publicly to the time an alert-ready classification is persisted, when the source is supported and observable by the platform.

The crawler does not promise complete Internet coverage.

## 1. Pipeline

```text
Monitor Query
   -> Query Planner
   -> Discovery Providers
   -> Candidate URL/Event Frontier
   -> URL Canonicalizer
   -> Global Content Cache lookup
   -> Domain Lease
   -> Fast Fetch
   -> Extraction Quality Gate
      -> success -> Normalize
      -> insufficient -> Browser Queue
   -> Raw R2 write
   -> Fingerprint / Change Detection
   -> Match Many Monitors
   -> Relevance
   -> Sentiment / Severity
   -> Priority Alert path
```

Discovery and crawling are separate subsystems.

## 2. Data structures

### 2.1 DiscoveryCandidate

```ts
interface DiscoveryCandidate {
  schemaVersion: 1;
  candidateId: string;
  scanId: string;
  tenantId: string;
  monitorId: string;
  source: string;
  discoveredUrl?: string;
  sourceNativeId?: string;
  titleHint?: string;
  snippetHint?: string;
  publishedAtHint?: string;
  discoveredAt: string;
  queryVariantId: string;
  discoveryProvider: string;
  priority: number;
  freshnessClass: 'breaking' | 'hot' | 'normal' | 'background';
}
```

### 2.2 CrawlTarget

```ts
interface CrawlTarget {
  schemaVersion: 1;
  contentKey: string;
  canonicalUrl: string;
  source: string;
  domain: string;
  firstSeenAt: string;
  priority: number;
  requestedBy: Array<{
    tenantId: string;
    monitorId: string;
    scanId: string;
  }>;
  fetchMode: 'static-first' | 'browser-required';
  previousVersion?: {
    etag?: string;
    lastModified?: string;
    contentHash?: string;
  };
}
```

### 2.3 ContentRecord

Authoritative raw payload lives in R2. Operational metadata may be indexed by monitor DOs.

```ts
interface ContentRecord {
  schemaVersion: 1;
  contentKey: string;
  canonicalUrl: string;
  fetchedAt: string;
  source: string;
  httpStatus?: number;
  mimeType?: string;
  title?: string;
  text: string;
  author?: string;
  publishedAt?: string;
  modifiedAt?: string;
  outboundLinks?: string[];
  contentHash: string;
  simHash?: string;
  extractionQuality: number;
  fetchMethod: 'fetch' | 'browser';
  rawObjectKey: string;
}
```

## 3. URL frontier

Do not implement a single global in-memory frontier.

The system uses Queues as the distributed frontier and Durable Objects only for strongly consistent coordination/state.

Frontier classes:

```text
P0 emergency     - known/high-confidence negative follow-up URLs
P1 priority      - fresh discoveries for active monitors
P2 normal        - standard new candidate URLs
P3 refresh       - known pages that need periodic recheck
P4 background    - sitemap/domain expansion/backfill
```

Map P0/P1 into priority queues; P2/P3/P4 may share normal queues initially if queue age remains healthy.

## 4. Priority score

Each candidate receives a deterministic score from 0-1000.

Suggested initial formula:

```text
priority =
  freshness_weight
+ monitor_tier_weight
+ query_match_weight
+ source_velocity_weight
+ negative_hint_weight
+ source_authority_weight
- domain_backoff_penalty
- duplicate_probability_penalty
```

Example weights:

```text
freshness                  0..250
monitor tier               0..150
exact phrase/entity        0..150
source velocity            0..120
negative lexical hint      0..120
source authority           0..80
domain penalty             0..-150
duplicate penalty          0..-120
```

Do not overfit these constants. Keep them versioned in config and measure precision/latency.

### Freshness score

For a source result with publication time:

```text
age <= 2 min     +250
<= 5 min         +220
<= 15 min        +180
<= 1 h           +120
<= 24 h          +60
older            +20
```

If publication time is unknown, use `discoveredAt` but reduce confidence.

## 5. Query scheduling

Every MonitorDO stores per-source state:

```text
last_scan_at
next_scan_at
last_success_at
last_cursor
recent_yield
recent_negative_yield
error_rate
latency_ewma
coverage_state
```

### Adaptive interval

Base intervals by paid tier are product config, not hardcoded architecture.

For professional target:

```text
base: 10 minutes
minimum hot interval: 2 minutes
maximum quiet interval: 30 minutes
```

Calculate next interval using activity:

```text
activity =
  mention_rate_15m
+ negative_rate_15m * boost
+ engagement_velocity * boost
```

Rules:

```text
critical/viral activity -> 2 min
high activity           -> 5 min
normal                   -> 10 min
quiet 6h                 -> 15 min
quiet 24h                -> 30 min
```

Never make all sources hot because one source is hot. Keep source-specific next scan state.

## 6. Discovery provider budget

Each monitor has a scan budget partitioned by source/provider.

A provider call is skipped/deferred when:

- source is disabled/degraded beyond configured threshold
- tenant quota is exhausted
- provider rate budget is exhausted
- previous cursor indicates no expected freshness advantage
- an equivalent query variant was recently run and cached

Cache discovery results by normalized provider query for a short window. Many tenants may monitor identical brands/terms; reuse provider results where contractual/source policy permits.

## 7. Query plan compilation

Boolean AST is the authoritative filter after fetch.

Discovery compilers may generate provider-specific queries that are broader than the AST to avoid false negatives.

Example:

```text
("ABC" OR "ABC Vietnam") AND (refund OR "hoan tien") NOT "ABC School"
```

may compile into several provider requests because providers differ in operator support.

Every result is later evaluated against the full normalized AST using extracted content.

## 8. Canonicalization

Canonicalization is mandatory before crawl dedupe.

Process:

1. parse URL safely
2. normalize scheme/host casing
3. IDN normalization
4. remove fragment
5. strip known tracking parameters
6. sort safe query parameters
7. resolve default port
8. normalize trailing slash conservatively
9. inspect page canonical tag after fetch
10. retain both requested URL and canonical URL for audit

Do not strip arbitrary query parameters because many pages use them as content identity.

Tracking denylist examples:

```text
utm_*
syn-*
fbclid
gclid
mc_cid
mc_eid
```

Source adapters may define additional safe canonicalization rules.

## 9. SSRF guard

Before every fetch/browser navigation:

- allow only http/https
- reject embedded credentials
- validate host
- reject loopback/private/link-local/reserved IP ranges after DNS resolution where available
- protect against DNS rebinding across redirects
- cap redirects
- re-run validation on every redirect target
- reject metadata/internal service endpoints
- enforce maximum URL length

A Browser navigation must apply the same policy as static fetch.

## 10. DomainCoordinatorDO

Key by effective domain/host policy unit.

State:

```text
active_leases
max_concurrency
next_allowed_at
backoff_until
recent_429_rate
recent_5xx_rate
latency_ewma
robots_cache_version
policy_state
```

Acquire lease before network access.

Lease algorithm:

```text
if now < backoff_until -> deny with retry_at
if active >= concurrency -> deny with short retry_at
if now < next_allowed_at -> deny with retry_at
else increment active and issue lease token
```

Release in `finally` logic or let short lease TTL expire.

Backoff grows on 429/503 and honors `Retry-After`.

Do not use DomainCoordinatorDO to store content.

## 11. Fetch-first algorithm

Static crawler uses bounded fetch:

- AbortController timeout
- redirect cap
- body size cap
- content-type allowlist
- stream large bodies to extraction/storage when possible

Use conditional request headers for refresh when available:

```text
If-None-Match
If-Modified-Since
```

A `304` produces no new content version.

## 12. Extraction quality gate

Browser escalation is based on measurable extraction quality, not domain name alone.

Suggested quality score 0-100:

```text
+ main text length
+ title presence
+ publication metadata
+ author metadata
+ low script-to-text ratio after extraction
+ expected keyword presence
+ article/body semantic coherence
- challenge/login/captcha markers
- empty shell markers
- client-render placeholders
```

Browser escalation when:

```text
quality < threshold
AND source policy permits browser rendering
AND BrowserPool budget available
```

Possible hard escalation indicators:

- static HTML is an app shell with no meaningful body
- explicit supported adapter marks dynamic rendering required
- extraction returns expected canonical metadata but no content

Possible hard stop indicators:

- authentication required
- CAPTCHA/challenge requiring bypass
- source adapter policy disabled
- robots/policy disallows collection

## 13. BrowserPoolDO

Purpose: allocate browser capacity fairly.

Leases have ids and an expiry. A Durable Object alarm sweeps expired leases so a cancelled, timed-out, or crashed crawl cannot wedge the pool. Release is idempotent and keyed by lease id. Capacity defaults to the account Browser Run concurrent-browser limit and is not taken from a persisted counter.

Lease dimensions:

```text
tenant
priority class
domain
session count
browser milliseconds budget
```

Priority order:

```text
critical follow-up
fresh negative candidate
normal fresh mention
refresh
background
```

Use bounded keepalive/session reuse for same-domain bursts where safe. Never rely on session cookies to bypass source controls.

## 14. Crawl once, match many

Global content identity:

```text
contentKey = SHA256(canonical URL identity)
```

Before network fetch:

1. check recent canonical content metadata cache
2. if fresh enough, reuse R2 content
3. attach new monitor match request
4. evaluate monitor AST/relevance against existing normalized text

Do not refetch because a second tenant found the same URL.

Refresh freshness TTL depends on source type:

```text
immutable news article initially: short refresh during hot window, then longer
home page/search page: very short
forum thread: short while active
RSS item URL: moderate
```

TTL must be source-configurable.

## 15. Content fingerprinting

Generate:

```text
exact SHA-256 normalized content hash
SimHash or MinHash for near duplicate
optional embedding for semantic cluster
```

Use exact hash before expensive similarity.

Near-duplicate detection is useful for syndicated news copies but must preserve source-level mention records when reach/source count matters.

Distinguish:

```text
same_content_version
near_duplicate_story
same_story_different_source
```

## 16. Change detection

Known mutable pages can be refreshed.

If exact content hash unchanged:

- update last_seen_at
- do not re-run full AI
- optionally refresh engagement metadata separately

If changed:

- write new version to R2
- compute textual delta
- re-evaluate only affected monitors
- deep AI only if semantic/sentiment-relevant delta exceeds threshold

R2 object metadata includes:

```text
schema_version
content_version
previous_content_key/version pointer
fetched_at
```

## 17. Engagement refresh

For supported sources, engagement metrics may be refreshed independently from content.

Store snapshots:

```text
timestamp
likes
comments
shares
views/reposts where available
```

Calculate robust velocity using elapsed time, not raw difference.

Avoid very frequent refresh of low-risk mentions.

Hot negative content receives higher refresh frequency until velocity decays.

## 18. Negative fast lane

Cheap pre-classification runs as early as possible after normalized text exists.

Signals:

- negative lexicon contextual match
- complaint/risk category hints
- monitor exact entity match
- source/engagement velocity

If candidate exceeds fast-lane threshold:

```text
process-content
 -> process-ai-priority
 -> alert decision
```

Normal candidates use normal AI queue.

The fast-lane classifier may increase recall at the expense of some extra deep AI calls; final alert precision remains strict.

## 19. 15-minute latency budget

Target budget:

```text
source publication -> discovery     <= 5 min P95 for supported hot sources
discovery queue                   <= 1 min
crawl + extraction                <= 3 min including browser fallback
normalize/relevance               <= 1 min
deep AI severity                  <= 2 min
alert persist/send                <= 1 min
margin                            ~2 min
```

Instrument each segment separately.

If P95 fails, identify whether the bottleneck is:

```text
discovery lag
queue lag
domain backoff
browser saturation
AI saturation
notification provider
```

Do not hide source discovery limitations behind aggregate SLA.

## 20. Backpressure

Every stage records queue age.

When normal queue lag increases:

1. preserve priority queue capacity
2. pause/defer P4 background work
3. extend quiet refresh intervals
4. lower browser escalation for low-priority content
5. batch cheap AI where supported
6. never drop committed alert jobs silently

If the system cannot meet SLO, expose source/system degraded state.

## 21. Retry policy

Classify errors before retry.

Retryable:

```text
timeout
429
transient 5xx
browser launch/session transient error
AI transient error
```

Usually non-retryable (ack, do not retry):

```text
400/401/402/404/405/410 and other permanent 4xx
unsupported MIME
policy disabled
authentication required
SSRF rejection
malformed URL
body too large
```

403 and 419 are blocks, not permanent failures: route them to the browser crawler instead of retrying the static fetch. 429 records per-domain backoff (honor `Retry-After`, grow while the domain stays hot) and retries after that delay.

`domain_busy`, `browser_pool_busy`, and Browser Run session limits are congestion, not fetch failures. Session limits are `browser_http_429` (Quick Actions rate limit, or a session 429) and, as whole words, `too many sessions`, `too many browsers`, `browser instance limit`, `unable to create new browser`, `too many requests`, `rate limit exceeded`, `rate limited` / `rate-limited`, `rate_limited`, `ratelimited`, and `rate limiting`. "Too many requests" is re-sent, including when the binding throws that sentence with no status line. That is the published Quick Actions 429 text, and `message.retry()` would dead-letter it after three attempts. Word boundaries keep "generate limited" and "Corporate Limited" off this path. A permanent 4xx is acked and logged as a skip before the session label, even if the body quotes a rate-limit phrase. A fetch or upstream error still counts toward the per-URL cap, including `Rate limit exceeded` with no `upstream_` prefix. A domain wake does not carry the carrier job's tenant, and a failure on that wake does not increment the carrier's URL cap. `browser_pool_busy` and Browser Run session limits re-send the same job to the same queue with `delaySeconds` and `congestionHops` on the body, then ack the original. The delay is `max(coordinator hint or Retry-After, 30s × 2^hop)`, capped at 900 seconds. Hop 0 is the first re-send: 30, 60, 120, 240, 480, then 900 seconds. Do not turn a 250ms lease hint into a 1 second retry loop. Log those events at info (`crawl_browser_session_busy` for Browser Run). After 12 hops the worker logs `crawl_congestion_cap` once at warn, writes one Analytics Engine point with blob `crawl_congestion_cap` and double `1`, and acks. Congestion does not use `message.retry()` and does not enter the crawl DLQ. Those 12 delays add up to 7,230 seconds (about 2 hours) when the hint is shorter than the step. A longer hint is kept until the exponential step passes it, still capped at 900 seconds, so the longest window is 12 × 900 seconds (3 hours).

`domain_busy` does not re-send each URL. The worker parks the job on that domain's `DomainCoordinatorDO` (one row per tenant, monitor or job, and URL, per fetch or browser lane). The per-tenant cap is 1024 and the per-domain ceiling is 4096, so a host with a few hundred distinct URLs an hour fits and one tenant cannot fill the list for the others. A 16 KB body falls back to the per-message re-send. A full list logs `crawl_domain_park_full` at warn and re-sends that job instead of acking it. A duplicate row for the same tenant, monitor, and URL logs `crawl_domain_park_duplicate` and is acked. One wake token is in flight per domain and lane. A second send is not scheduled while that token's `wake_at` is still inside a 120 second delivery window, which covers consumer lag. A wake whose token does not match is acked and does not drain or start another chain. The wake message has no tenant or monitor. It claims one parked job at a time, up to 32 per invocation, and deletes the row only after that job's crawl returns. The browser lease stays at 2 with a 750ms gap. Re-sending does not raise that cap. If the lease is busy and nothing ran, the same wake is sent again after at most 30 seconds (5, 10, 20, then 30) and the hop increases. If some jobs ran and more remain, the wake is sent again after about a second and hops reset to 0. If the domain object is down, the worker falls back to the per-message re-send. At hop 12 the worker logs `crawl_congestion_cap` at warn, counts that event, sweeps every parked row back onto the queue with hops 0, and logs `crawl_domain_park_expired` once per job using that job's tenant. The domain object also sets an alarm for 15 minutes after the wake. If the wake never returns, the alarm deletes the remaining rows and records one `domain_park_events` row per job.

The browser consumer calls `BROWSER.quickAction("content")` once per message, sequentially inside the batch. Workers Paid Browser Run allows 200 concurrent browsers per account (sessions) and 30 Quick Action requests per second (limits page, 2026-10-14). `reputa-crawl-browser` sets `max_concurrency` 200 and `max_batch_size` 1 so in-flight Quick Actions stay at that session ceiling. `reputa-crawl-static` sets `max_concurrency` 80, `max_batch_size` 10, and `max_batch_timeout` 5. Leaving `max_concurrency` unset scales a push consumer to the Queues cap of 250.

Real transient failures (5xx, network, upstream 429, browser 5xx that are not a session limit) use `message.retry()`. That spends `max_retries` 3, so the fourth delivery is the last and the queue dead-letters the message. A delay on one message does not delay its siblings. The worker does not ack those errors when a per-URL cap is reached. A body that is not a crawl job is logged as `crawl_malformed_message` and acked. What to do with `reputa-crawl-dlq-production` is in `docs/CRAWL_DLQ_PROPOSAL.md`.

Real fetch failures are counted per tenant and normalized URL, at most 8 in a 15-minute window. `domain_busy`, `browser_pool_busy`, and Browser Run session limits do not increment that counter. A new message for a capped tenant/URL is acked. A redelivery of a message already in retry continues so it can reach the DLQ. Permanent 4xx (including 401, 402, 404, and 422), oversized or empty browser extractions, and hard-paywall hosts are acked and are not retried. A browser cache hit is forwarded to processing for the current monitor. Paywall hosts default to `ft.com` and `nytimes.com` plus their subdomains. Override the list with the `HARD_PAYWALL_HOSTS` var.

Use exponential backoff + jitter. Honor `Retry-After`.

Every retry keeps the same idempotency key.

## 22. Idempotency

Recommended job idempotency key:

```text
SHA256(job_type + content_key + monitor_id + logical_version)
```

Consumers perform UPSERT/checkpoint in authoritative DO state before producing downstream side effects.

For alerts, delivery key includes alert rule/version so queue replay does not notify twice.

## 23. Source adapters

Each adapter exposes:

```ts
interface SourceCapabilities {
  discovery: boolean;
  realtimeFreshness: 'high' | 'medium' | 'low' | 'unknown';
  contentFetch: 'api' | 'public-web' | 'browser' | 'provider' | 'none';
  comments: boolean;
  engagement: boolean;
  author: boolean;
  publishedAt: boolean;
  policyState: 'available' | 'degraded' | 'contract_required' | 'disabled';
}
```

The scheduler uses capabilities when allocating scan budget.

Do not treat unavailable social search as a generic browser crawl problem.

## 24. Politeness and robots/source policy

Generic web adapter must respect configured public-web crawl policy and robots handling. Platform adapters obey platform/API contracts separately.

`robots.txt` cache belongs in config/cache with bounded TTL; policy decisions must be observable.

## 25. Search result pages

Do not recursively crawl arbitrary search engine result pages as if they were ordinary websites when that violates source terms or creates brittle dependencies. Discovery providers are explicit adapters.

## 26. Sitemap/RSS discovery

RSS:

- use ETag/Last-Modified
- dedupe GUID + canonical URL
- prioritize newly published items

Sitemap:

- use `lastmod` only as a hint
- cap URL expansion per job
- persist continuation/cursor
- prioritize URLs whose paths/content hints match monitor query

Do not recursively fan out a 1M-URL sitemap into one queue burst.

## 27. Frontier expansion

Links extracted from a page may become candidates only when a SourceAdapter/monitor policy allows expansion.

Generic expansion score:

```text
same domain + relevant anchor + recent path pattern + monitor keyword -> high
unrelated navigation/footer -> reject
external arbitrary link -> reject unless source workflow explicitly permits
```

This product is mention monitoring, not a general-purpose web indexer.

## 28. Data retention

Raw content retention is plan/policy configurable.

Separate:

```text
raw blob retention
mention metadata retention
alert audit retention
telemetry retention
```

R2 lifecycle rules should expire temporary screenshots/debug artifacts sooner than customer report objects.

## 29. Accuracy feedback loop

User feedback:

```text
relevant
not_relevant
wrong_sentiment
resolved
```

feeds monitor-specific configuration and evaluation datasets.

Do not online-train uncontrolled models directly from one feedback click. Store labeled examples and use them for rule/threshold/model evaluation.

## 30. Test fixtures

Required crawler test suites:

- static HTML article
- JS shell requiring browser
- redirect canonicalization
- tracking query URL
- relative canonical URL
- RSS update + 304
- sitemap pagination/large sitemap cap
- 429 Retry-After
- 503 transient
- 404 permanent
- private IP/SSRF rejection
- redirect to private IP rejection
- duplicate URL across two tenants
- unchanged content refresh
- changed article body
- syndicated near duplicate
- browser lease saturation
- domain concurrency saturation
- priority negative fast lane

## 31. Load tests

Minimum scenarios before production:

```text
10k active monitors with staggered scans
burst of shared URL across 1k monitors
browser-required domain burst
429-heavy domain
AI priority spike
notification spike
```

Measure:

```text
queue age P50/P95/P99
crawl latency
browser wait time
DO request latency
R2 read/write count
AI invocation count
alert end-to-end latency
```

## 32. Cost-efficiency levers

In priority order:

1. crawl once / match many
2. discovery query reuse
3. conditional GET / no-change skip
4. fetch before browser
5. exact/near dedupe before embedding
6. Boolean/relevance before deep AI
7. priority AI only for important candidates
8. adaptive scheduling
9. engagement refresh only for hot content
10. R2 lifecycle management

## 33. Failure modes

### Browser saturation

- preserve critical lane
- degrade low-priority dynamic sources
- increase normal browser retry delay
- publish source health degraded state

### Domain blocking/rate limiting

- DomainCoordinatorDO increases backoff
- stop retry storm
- source health records degraded
- never bypass access control

### Discovery provider outage

- continue other adapters
- use cached cursors/results only within safe TTL
- expose source coverage gap

### AI outage

- deterministic relevance and lexical risk continue
- hold likely-negative candidates in priority queue with bounded retry
- optionally emit "unclassified high-risk candidate" internal operational signal, not a misleading customer sentiment label

### R2 write failure

- do not persist mention claiming content exists
- retry before downstream processing

## 34. Algorithm evolution

V1 uses deterministic weighted priority + rule-based scheduling.

When enough production data exists, offline-learn ranking weights from:

```text
customer relevance feedback
alert acknowledgments
source yield
latency
negative detection success
```

Any learned ranker must remain bounded by hard product rules such as tenant tier, policy blocks, and priority-negative lane.

## 35. Definition of done

Crawler subsystem is ready when:

- static + browser paths are both implemented
- URL canonicalization and SSRF tests pass
- shared URL across tenants crawls once
- source/domain rate limiting works under concurrency
- queue replay is idempotent
- unchanged refresh skips deep processing
- dynamic page escalates only when quality gate fails
- priority negative candidate bypasses normal backlog
- source degraded state is visible
- load test demonstrates a plausible path to P95 <15 min for supported hot sources

