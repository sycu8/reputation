# Source Coverage Matrix

Status date: 2026-08-09.

This file defines the product's intended source architecture. It is not permission to bypass access controls. Every source adapter must comply with the source's current developer terms, robots directives where applicable, rate limits, and customer data obligations.

## Capability states

- `native-api`: supported using an official API for the commercial use case.
- `public-web`: publicly accessible page can be collected without authentication where policy permits.
- `licensed-provider`: use a contracted third-party data provider when native commercial access is insufficient.
- `contract-required`: commercial access requires a separate agreement or approval.
- `degraded`: partial coverage only; UI must disclose limitations.
- `disabled`: adapter exists but does not collect live data.

## Matrix

| Source | Discovery strategy | Collection strategy | Freshness target | Fields expected | Commercial/reliability notes | V1 operating mode |
|---|---|---|---|---|---|---|
| Open web | Search-provider adapters, RSS, sitemap, known-domain recrawl, discovered links | Worker `fetch()` first; Browser Run fallback | 5-15 min for high-priority known sources; discovery dependent for unknown pages | URL, canonical URL, title, text, author if present, timestamps, metadata | Best general-purpose coverage. Must honor source-specific policies and robots strategy. | `native-api/public-web` |
| News | News/search-provider adapters, RSS, publisher sitemaps | `fetch()` first, Browser Run if rendered | 5-15 min where source/feed supports it | headline, body, publisher, author, published time, canonical URL, images | Strong V1 source. Deduplicate syndicated copies into story clusters. | `native-api/public-web` |
| Blogs/forums | Search discovery, RSS, known-source recrawl | `fetch()` then Browser Run | 5-15 min on watched sources; otherwise discovery dependent | post body, author, thread title, timestamps, reply count when public | DomainCoordinatorDO required for rate control. | `public-web` |
| RSS/Atom | Feed registry, autodiscovery, customer-added feeds | Worker `fetch()` | 1-10 min | feed item title, URL, author, published time, description/content | Highest reliability and lowest cost. Prefer whenever available. | `native-api` |
| YouTube | YouTube Data API `search.list`; channel/activity polling where useful | Official API metadata; fetch public page only for supplemental rendering if needed | 5-15 min subject to API quota and polling | video/channel/playlist IDs, title, description, publish time; enrich with video statistics API | Official search supports keyword query and public content; manage quota carefully. | `native-api` |
| X | X API recent search for last 7 days; full archive only with applicable paid access | Official X API | 5-15 min subject to plan/usage limits | post text, author ID, created time, metrics/expansions per entitlement | Good fit for keyword monitoring when commercial plan permits. Query compiler should emit X-native operators when possible. | `native-api` |
| Reddit | Approved Data API / contracted access; optionally licensed provider; **supplemental** public search Atom/RSS for post permalinks (`public-web`) when OAuth is absent | Official/contracted API preferred for commercial scale; free RSS discovery is best-effort and rate-limited | Depends on agreement; target 5-15 min if granted | posts/comments, subreddit, author, timestamps, scores, URLs | Reddit terms state commercial use may require a separate agreement. Do not design production around login scraping/CAPTCHA bypass. Public search RSS is explicitly labeled `public-web` and may be throttled. | `contract-required` (+ `public-web` supplemental) |
| TikTok | Approved commercial/licensed data source; Research API only if the customer/use case actually qualifies | Official/contracted access; public-page rendering is supplemental, not the primary keyword-discovery strategy | Cannot promise <15 min from Research API | video ID, description, username, create time, region, engagement where authorized | TikTok Research API is approval-based and its search corpus may lag up to 48h; unsuitable as the core commercial realtime path. | `licensed-provider/contract-required/degraded` |
| Facebook | Approved Meta capabilities for owned/authorized assets and any separately approved public-content access; external public-web discovery for URLs | Official API when authorized; public webpage rendering only where accessible and permitted | Capability dependent | page/post metadata and engagement where permissions allow | Do not assume arbitrary keyword search across Facebook. App Review/features/permissions may be required. | `contract-required/degraded` |
| Instagram | Meta-approved APIs for connected professional accounts/assets; licensed provider for broader listening if contracted | Official API where authorized | Capability dependent | media/account metadata for entitled assets | No assumption of open global keyword listening. | `contract-required/degraded` |
| LinkedIn | Community Management APIs for approved/authorized organization workflows; licensed provider for broader public listening if available | Official API where authorized | Capability dependent | organization posts/comments/engagement based on permissions | `r_member_social` is closed; do not promise arbitrary member-post search. | `contract-required/degraded` |
| Customer-owned websites | Direct URL/domain configuration, sitemap, RSS | `fetch()` + Browser Run | 1-10 min | complete public content and change snapshots | Highest-confidence web target; can support aggressive but polite recrawl. | `public-web` |

## Official references used when this matrix was written

- Cloudflare Browser Run crawl endpoint: https://developers.cloudflare.com/browser-run/quick-actions/crawl-endpoint/
- YouTube Data API search: https://developers.google.com/youtube/v3/docs/search/list
- X recent search: https://docs.x.com/x-api/posts/search-recent-posts
- X search overview: https://docs.x.com/x-api/posts/search/introduction
- Reddit Data API Terms: https://redditinc.com/policies/data-api-terms
- Reddit Developer Terms: https://redditinc.com/policies/developer-terms
- TikTok Research API query videos: https://developers.tiktok.com/doc/research-api-specs-query-videos/
- TikTok Research API FAQ: https://developers.tiktok.com/doc/research-api-faq
- LinkedIn Community Management overview: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview

## Adapter contract additions

Every source adapter must expose:

```ts
export type SourceAvailability =
  | 'available'
  | 'degraded'
  | 'contract_required'
  | 'disabled';

export interface SourceCapabilities {
  source: SourceKind;
  availability: SourceAvailability;
  discovery: boolean;
  keywordSearch: boolean;
  booleanSearch: 'native' | 'compiled_subset' | 'post_filter_only' | 'none';
  historicalSearch: boolean;
  comments: boolean;
  engagement: boolean;
  authorMetadata: boolean;
  authenticatedAccessRequired: boolean;
  browserSupplementAllowed: boolean;
  minimumExpectedFreshnessSeconds?: number;
  policyVersion?: string;
}
```

## Source execution policy

1. Compile the user's canonical Boolean AST into a provider-specific discovery query only for operators the provider supports.
2. Do not weaken correctness silently. Unsupported Boolean logic must be applied again after content collection using the canonical evaluator.
3. Persist a `source_capability_snapshot` with every scan so historical reports explain coverage gaps.
4. A degraded or disabled source must never fabricate zero mentions as proof that no conversation exists.
5. UI must show source health: Healthy, Limited, Contract Needed, Temporarily Degraded, Disabled.
6. Never bypass login walls, CAPTCHA, private groups, or access-control mechanisms.
7. Browser Run is for rendering public content that the service is permitted to retrieve; it is not an authorization substitute.

## Fallback order

For each source, use the first permitted method that satisfies freshness and completeness:

1. Official API / approved API product.
2. Contracted or licensed data provider.
3. Public RSS/feed/search index.
4. Public webpage fetch.
5. Browser Run for JS rendering of a public page.
6. Degraded/disabled state with explicit coverage warning.

Never make `5` a workaround for missing authorization to `1`.
