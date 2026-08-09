# Source Discovery Engine Specification

## 1. Objective

Build a very fast, high-precision, broad-coverage discovery engine that continuously finds newly published public URLs/posts likely to match monitor Boolean queries and sends candidates into the crawl/analysis pipeline with a P95 important-negative detection target below 15 minutes.

Absolute accuracy and literal coverage of the entire Internet are impossible. The engineering target is:

- maximum lawful/public coverage,
- measurable precision and recall,
- low discovery latency,
- transparent source health/coverage,
- no hidden substitution of brittle bypass scraping for unavailable access.

## 2. Core principle: federation, not one search engine

Discovery is a federation of independent providers:

1. Official platform APIs where commercially permitted.
2. Search/web index providers.
3. RSS/Atom feeds.
4. News feeds/providers.
5. Sitemaps and sitemap indexes.
6. Known-domain incremental crawling.
7. Link graph expansion from freshly discovered pages.
8. Public social pages where policy and technical access permit.
9. Public web archives/index datasets for historical seed discovery.
10. Customer-supplied domains/URLs.

No provider is the single source of truth.

## 3. Open-source systems to study, not blindly embed

These projects are architectural references. Most cannot run directly inside Cloudflare Workers because they are Python/Java/Rust server processes, so copy ideas/patterns, not deployment assumptions.

### Scrapy

Study:
- request/response middleware,
- downloader middleware,
- spiders/adapters,
- item pipelines,
- retry and throttling concepts,
- duplicate filters.

Do not deploy the Python runtime as the product crawler.

### Apache Nutch / Common Crawl Nutch lineage

Study:
- crawl database/frontier concepts,
- URL scoring,
- fetch scheduling,
- politeness,
- parse/index separation,
- large-scale incremental crawling.

Translate those concepts into Queues + Durable Objects + R2.

### SearXNG

Study:
- metasearch federation,
- independent engine adapters,
- provider health/fallback,
- result normalization,
- dedupe across engines.

Do not copy its AGPL code into a proprietary repository without deliberate license review.

### Tantivy / Lucene-style ranking

Study:
- BM25,
- field-aware scoring,
- phrase/Boolean query evaluation,
- incremental indexing.

Tantivy itself is a Rust library and not a direct Workers dependency for V1.

### Common Crawl

Use as:
- historical URL/domain discovery,
- link graph/domain seed enrichment,
- corpus sampling,
- backfill hints.

Do not treat monthly Common Crawl releases as a realtime source; realtime monitoring still requires live discovery.

## 4. Discovery Provider contract

```ts
interface DiscoveryProvider {
  id: string;
  capabilities(): DiscoveryCapabilities;
  discover(input: DiscoveryRequest): Promise<DiscoveryBatch>;
  health(): Promise<ProviderHealth>;
}
```

Capabilities include:

- realtime_search
- recent_search
- historical_search
- boolean_native
- exact_phrase
- language_filter
- domain_filter
- author_filter
- cursor_pagination
- publication_timestamp
- engagement_metadata

## 5. Query compilation

Canonical Boolean AST is the source of truth.

Each provider has a compiler that maps supported parts of the AST into the provider's syntax.

Unsupported semantics must be re-evaluated after content retrieval.

Never reduce correctness by assuming provider Boolean semantics are identical.

## 6. Discovery fan-out

For each due monitor/source:

1. Load canonical AST.
2. Generate constrained provider variants.
3. Normalize/cache the discovery request key.
4. Fan out to eligible providers in parallel.
5. Merge candidates.
6. Canonicalize URLs/IDs.
7. Remove exact duplicates.
8. Rank by candidate priority.
9. Enqueue high-priority candidates immediately.
10. Persist provider cursor/watermark.

## 7. Shared query cache

Normalized discovery key:

`hash(provider + normalized_query + filters + time_bucket)`

Multiple tenants can reuse a discovery result set only when provider licensing/policy permits it. Tenant-specific post-filtering still runs separately.

Cache TTL depends on source freshness:

- breaking news/social: 1-3 minutes
- normal web search: 5-10 minutes
- sitemap/RSS: based on feed activity
- historical/backfill: hours/days

## 8. Candidate scoring

Candidate score 0-1000. Initial heuristic weights:

- publication freshness: +0..250
- exact monitored entity phrase: +0..160
- query semantic match: +0..140
- negative-risk lexical hints: +0..100
- source authority/reliability: +0..90
- source recent velocity: +0..90
- professional/business plan SLA: +0..60
- known duplicate probability: -0..150
- repeated low-quality domain: -0..120
- stale publication: -0..200

Scores are versioned configuration, later tuned from labeled feedback.

## 9. Frontier mapping

Use Cloudflare Queues as the distributed frontier:

- `discovery-emergency`
- `discovery-priority`
- `discovery-normal`
- `crawl-priority`
- `crawl-normal`
- `crawl-refresh`
- `crawl-background`

Do not centralize millions of candidate URLs inside one Durable Object.

## 10. Freshness scheduling

Maintain source-specific state per monitor:

- last_success_at
- next_due_at
- cursor/watermark
- recent_result_rate
- recent_negative_rate
- recent_error_rate
- observed publication lag

Adaptive interval:

- active negative event: 2-5 minutes where source supports it
- normal high-value source: 5-10 minutes
- normal source: 10-15 minutes
- quiet source: 30-60 minutes

Never claim 2-minute scan frequency if provider data itself arrives with multi-hour/day latency.

## 11. Domain discovery

For domains found relevant:

1. Discover sitemap URL from robots/homepage.
2. Parse sitemap indexes.
3. Track `lastmod` where reliable.
4. Learn recurring content sections.
5. Maintain domain-specific feed candidates.
6. Expand high-value fresh links from article pages.
7. Avoid calendar traps, faceted navigation explosions, session URLs, and infinite pagination.

## 12. Link graph expansion

Every accepted page can yield new candidate links.

Rank outgoing links using:

- same-domain relevance,
- anchor match,
- publication path patterns,
- recency hints,
- known content-template classifiers,
- historical yield rate.

Only enqueue links above threshold; never recursively crawl the entire web from every page.

## 13. URL canonicalization

Normalize:

- scheme/host casing,
- fragments,
- default ports,
- common tracking params,
- known session IDs,
- duplicate trailing slash rules,
- canonical link tags when trustworthy.

Store both discovered URL and canonical URL for audit.

## 14. Fresh-content detection

Use:

- ETag / If-None-Match,
- Last-Modified / If-Modified-Since,
- content hash,
- normalized-text hash,
- structural fingerprint.

No AI processing when the content version is unchanged.

## 15. Fast-fetch / Browser Run cascade

Default:

1. Worker `fetch()` or Browser Run `/crawl` with `render:false` where appropriate.
2. Evaluate extraction quality.
3. If dynamic content is missing, escalate to Browser Run Quick Actions or a controlled browser session.
4. Stop on login wall/CAPTCHA/policy prohibition.

Cloudflare Browser Run `/crawl` can crawl from a starting URL and supports rendered or non-rendered operation. Browser rendering is an expensive escalation path, not the default.

## 16. Precision stack

Use layered verification:

1. Boolean AST post-fetch evaluation.
2. Exact phrase/entity match.
3. Alias/context rules.
4. Source-specific field checks.
5. Lightweight semantic relevance model.
6. Deep model only for ambiguous/high-value candidates.
7. User feedback loop.

For negative alerts, optimize precision first. A false critical alert is more damaging than a low-priority mention arriving a little later.

## 17. Recall stack

Increase recall by:

- alias expansion approved by user,
- spelling/transliteration variants,
- hashtags/usernames/domains,
- multiple discovery providers,
- source-specific search,
- RSS/sitemap monitoring,
- link graph expansion,
- historical seed enrichment,
- query miss analysis.

Do not broaden aliases automatically without confidence thresholds; uncontrolled expansion destroys precision.

## 18. Ranking and fusion

Combine independent provider result lists using Reciprocal Rank Fusion (RRF) or a deterministic weighted fusion before AI ranking.

Suggested stages:

1. provider rank normalization,
2. RRF merge,
3. freshness boost,
4. source-quality boost,
5. exact-entity boost,
6. duplicate collapse,
7. cheap semantic rerank for top candidates.

This is inspired by metasearch/search-engine practice and avoids allowing one noisy provider to dominate.

## 19. Coverage telemetry

Per source/provider expose:

- enabled/disabled/degraded/contract_required,
- last successful discovery,
- observed lag,
- success rate,
- rate-limit rate,
- candidates/minute,
- accepted mentions/minute,
- precision from user feedback,
- estimated recall proxy,
- queue delay.

UI must distinguish `zero results` from `coverage unavailable`.

## 20. Accuracy KPIs

Track labeled metrics:

- mention precision,
- mention recall on benchmark sets,
- negative precision,
- negative recall,
- critical-alert precision,
- duplicate rate,
- entity-resolution error rate,
- median/P95 discovery lag.

Initial launch targets:

- relevant mention precision >= 90%
- high/critical negative alert precision >= 95%
- duplicate rate <= 2%
- P95 supported-source important-negative alert < 15 minutes

These are measurable engineering targets, not claims of perfect accuracy.

## 21. Benchmark suite

Create a versioned benchmark corpus with:

- Vietnamese and English,
- ambiguous person names,
- aliases,
- brand/product overlap,
- sarcasm,
- quoted negative statements that are not directed at target,
- copied news stories,
- stale pages,
- dynamic pages,
- misleading title/body combinations.

Every ranking/classification change runs against the benchmark before deployment.

## 22. Historical coverage

Historical discovery uses a separate low-priority pipeline so it never competes with realtime monitoring.

Potential inputs:

- search provider historical endpoints,
- public archives,
- Common Crawl indexes/datasets,
- known-source archive pages.

Historical records must be marked as `backfill`, not new alerts.

## 23. Important non-goal

Do not attempt to build a Google-scale global index in V1. Build a monitor-driven focused crawler/search federation that spends resources only where customer queries create demand. This is the fastest path to broad practical coverage and sustainable unit economics.
