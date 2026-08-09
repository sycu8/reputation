# Crawler, Discovery, and Source Adapter Specification

## 1. Goal

Create a source-agnostic acquisition layer that can discover and collect publicly accessible content from web, news, RSS, forums, blogs, and supported social platforms while respecting per-source technical constraints and product policy.

The platform must support Facebook, TikTok, YouTube, Reddit, X, LinkedIn, generic web/news/blog/forum/RSS through a common adapter framework, but must not assume identical access semantics across platforms.

## 2. Adapter contract

```ts
export type SourceType =
  | 'web'
  | 'news'
  | 'rss'
  | 'forum'
  | 'blog'
  | 'facebook'
  | 'tiktok'
  | 'youtube'
  | 'reddit'
  | 'x'
  | 'linkedin';

export interface SourceCapabilities {
  discovery: boolean;
  directFetch: boolean;
  browserFetch: boolean;
  comments: boolean;
  engagement: boolean;
  author: boolean;
  publishTime: boolean;
  pagination: boolean;
  historical: boolean;
  cursor: boolean;
}

export interface SourcePolicy {
  publicOnly: true;
  loginRequired: boolean;
  approvedApiPreferred: boolean;
  browserAllowed: boolean;
  robotsAware: boolean;
  maxRequestsPerMinute?: number;
  notes?: string;
}

export interface SourceAdapter {
  id: string;
  source: SourceType;
  capabilities: SourceCapabilities;
  policy: SourcePolicy;

  discover(input: DiscoveryInput): Promise<DiscoveryResult[]>;
  fetch(input: FetchInput): Promise<RawSourceContent>;
  normalize(raw: RawSourceContent): Promise<NormalizedContent>;
}
```

## 3. Discovery strategies

### Generic web/news/blog/forum
- search-provider adapters
- RSS/Atom
- sitemap
- monitored-domain crawling
- page link expansion from previously discovered content

### YouTube
- official/public API paths where configured
- public page/browser extraction only when allowed and necessary
- channel/video/query discovery abstraction

### Reddit
- official/publicly permitted API/feed/search integrations
- public page fetch as policy permits

### X / Facebook / TikTok / LinkedIn
- use supported/approved API or public-access paths where available
- browser rendering may be used only for publicly accessible pages and only when source policy allows
- never implement CAPTCHA bypass, credential stuffing, session theft, or private-account collection
- adapters must be feature-flagged because capability can change independently

## 4. Source capability registry

Store in KV as versioned config:

```json
{
  "source": "tiktok",
  "enabled": true,
  "discovery": "provider_or_public_path",
  "browserFallback": true,
  "comments": false,
  "engagement": true,
  "rateClass": "restricted",
  "configVersion": 3
}
```

All workers must read a stable config version per job to make replay deterministic.

## 5. Crawl flow

```text
candidate
  -> validate scheme/domain
  -> SSRF/DNS safety checks
  -> canonical cache lookup
  -> DomainCoordinatorDO acquire
  -> source adapter fetch mode selection
  -> direct fetch
  -> quality test
  -> optional Browser Run fallback
  -> canonicalize
  -> fingerprint
  -> R2 persist
  -> process queue
```

## 6. Direct fetch

Use direct fetch when:
- HTTP 2xx
- expected content type
- body under configured maximum
- content extraction produces sufficient text
- no JS-only shell/interstitial

Required protections:
- max redirects
- redirect destination revalidation
- max body bytes
- timeout
- content-type allowlist
- decompression limits
- private IP/metadata destination blocks

## 7. Browser Run / Browser Rendering

Use browser when direct fetch fails quality checks or adapter requires rendered state.

Browser task limits:
- maximum navigation duration
- maximum scroll count
- maximum DOM actions
- no arbitrary scripts from tenant input
- no download execution
- no login credentials in V1

Recommended extraction sequence:
1. navigate
2. wait for bounded network idle/selector
3. dismiss only harmless cookie UI when adapter allows
4. bounded scroll/load-more
5. extract rendered title/text/author/time/engagement
6. canonical URL
7. optional screenshot for debugging or High/Critical mentions

## 8. Crawl cache

Global key:

```text
sha256(canonicalUrl)
```

Cache metadata:
- last fetched
- ETag
- Last-Modified
- content hash
- freshness TTL by source type
- latest R2 key

Before crawling, check whether the current snapshot is fresh enough for all requesting monitors.

## 9. Content freshness

Suggested defaults:
- breaking news/high activity: 2-5 min
- normal news/blog: 10-30 min
- evergreen pages: 6-24 h
- RSS feeds: 2-10 min
- social items: source-specific

## 10. Politeness and backoff

DomainCoordinatorDO enforces:
- concurrent request cap per domain
- minimum interval
- exponential backoff on 429/503
- longer cooldown on repeated 403/429
- Retry-After support

## 11. Parsing and normalization

Normalize:
- Unicode NFKC where appropriate
- whitespace
- HTML entities
- URL normalization
- timestamps to UTC ISO-8601
- engagement numeric formats
- author handles
- hashtags/mentions
- language detection

Preserve original text separately from normalized matching text.

## 12. Comments

Comments are a separate child-content stream because they can dominate volume.

V1 rule:
- enable comments only for sources/adapters with reliable supported access
- cap comment depth/volume per parent
- prioritize top/recent comments depending source
- comments inherit parent context but get their own sentiment/relevance

## 13. Error classes

```text
DISCOVERY_RATE_LIMIT
DISCOVERY_AUTH_REQUIRED
FETCH_TIMEOUT
FETCH_BLOCKED
FETCH_404
FETCH_429
FETCH_5XX
BROWSER_TIMEOUT
BROWSER_BLOCKED
PARSE_EMPTY
PARSE_SCHEMA_CHANGED
POLICY_DISABLED
SSRF_BLOCKED
```

Each class has a retry policy. Permanent/policy errors must not loop.

## 14. Source testing

Every adapter must include fixtures/tests for:
- query discovery
- pagination/cursor
- canonical URL
- author extraction
- publish time
- engagement extraction
- empty/blocked page behavior
- schema drift handling
- idempotent fetch
