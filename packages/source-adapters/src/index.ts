import { assertPublicHttpUrl } from "../../crawler-core/src/index.ts";
import { evaluateBooleanAst, type BooleanAst } from "../../boolean-query/src/index.ts";
import {
  DEFAULT_PUBLIC_RSS_FEEDS,
  TECH_STARTUP_SITE_CLAUSES,
  mergeRssFeedUrls
} from "./default-rss-feeds.ts";

export {
  DEFAULT_PUBLIC_RSS_FEEDS,
  TECH_STARTUP_SITE_CLAUSES,
  mergeRssFeedUrls
} from "./default-rss-feeds.ts";

export type SourceType =
  | "web"
  | "news"
  | "rss"
  | "youtube"
  | "reddit"
  | "x"
  | "facebook"
  | "tiktok"
  | "linkedin"
  | "facebook_group"
  | "telegram"
  | "zalo"
  | "discord";
export type SourceAvailability = "native-api" | "public-web" | "licensed-provider" | "contract-required" | "degraded" | "disabled";

export interface SourceCapabilities {
  keywordSearch: boolean;
  booleanSearch: boolean;
  historicalSearch: boolean;
  comments: boolean;
  engagement: boolean;
  renderMayBeRequired: boolean;
}

export interface DiscoveryInput {
  query: string;
  ast: BooleanAst;
  since?: string;
  cursor?: string | undefined;
  limit: number;
}

export interface DiscoveryResult {
  source: SourceType;
  url: string;
  nativeId?: string;
  title?: string | undefined;
  snippet?: string | undefined;
  author?: string | undefined;
  publishedAt?: string | undefined;
  cursor?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface DiscoveryProvider {
  readonly id: string;
  readonly source: SourceType;
  readonly availability: SourceAvailability;
  readonly capabilities: SourceCapabilities;
  discover(input: DiscoveryInput): Promise<DiscoveryResult[]>;
}

export interface RawSourceContent {
  source: SourceType;
  url: string;
  status: number;
  contentType: string | null;
  body: string;
  fetchedAt: string;
  headers: Record<string, string>;
}

export interface NormalizedContent {
  source: SourceType;
  canonicalUrl: string;
  title?: string | undefined;
  text: string;
  author?: string | undefined;
  publishedAt?: string | undefined;
  language?: string | undefined;
  metadata: Record<string, unknown>;
}

export interface SourceAdapter {
  readonly source: SourceType;
  readonly availability: SourceAvailability;
  readonly capabilities: SourceCapabilities;
  normalize(raw: RawSourceContent): Promise<NormalizedContent>;
}

export const SOURCE_CAPABILITY_DEFAULTS: Record<SourceType, { availability: SourceAvailability; capabilities: SourceCapabilities }> = {
  web: { availability: "public-web", capabilities: { keywordSearch: false, booleanSearch: false, historicalSearch: false, comments: false, engagement: false, renderMayBeRequired: true } },
  news: { availability: "licensed-provider", capabilities: { keywordSearch: true, booleanSearch: true, historicalSearch: true, comments: false, engagement: false, renderMayBeRequired: true } },
  rss: { availability: "public-web", capabilities: { keywordSearch: false, booleanSearch: false, historicalSearch: true, comments: false, engagement: false, renderMayBeRequired: false } },
  youtube: { availability: "native-api", capabilities: { keywordSearch: true, booleanSearch: true, historicalSearch: true, comments: true, engagement: true, renderMayBeRequired: false } },
  reddit: { availability: "contract-required", capabilities: { keywordSearch: true, booleanSearch: false, historicalSearch: true, comments: true, engagement: true, renderMayBeRequired: false } },
  x: { availability: "native-api", capabilities: { keywordSearch: true, booleanSearch: true, historicalSearch: false, comments: true, engagement: true, renderMayBeRequired: false } },
  facebook: { availability: "public-web", capabilities: { keywordSearch: true, booleanSearch: false, historicalSearch: false, comments: false, engagement: false, renderMayBeRequired: true } },
  tiktok: { availability: "public-web", capabilities: { keywordSearch: true, booleanSearch: false, historicalSearch: false, comments: false, engagement: true, renderMayBeRequired: true } },
  linkedin: { availability: "public-web", capabilities: { keywordSearch: true, booleanSearch: false, historicalSearch: false, comments: false, engagement: false, renderMayBeRequired: true } },
  // Closed / private communities — authorized access only; never scrape behind login walls.
  facebook_group: { availability: "contract-required", capabilities: { keywordSearch: false, booleanSearch: false, historicalSearch: false, comments: true, engagement: false, renderMayBeRequired: true } },
  telegram: { availability: "contract-required", capabilities: { keywordSearch: false, booleanSearch: false, historicalSearch: false, comments: true, engagement: false, renderMayBeRequired: false } },
  zalo: { availability: "contract-required", capabilities: { keywordSearch: false, booleanSearch: false, historicalSearch: false, comments: true, engagement: false, renderMayBeRequired: true } },
  discord: { availability: "contract-required", capabilities: { keywordSearch: false, booleanSearch: false, historicalSearch: false, comments: true, engagement: true, renderMayBeRequired: false } }
};

function decodeXmlEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractTag(block: string, tag: string): string | undefined {
  const cdata = block.match(new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i"));
  if (cdata?.[1] != null) return decodeXmlEntities(cdata[1].trim());
  const plain = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (plain?.[1] != null) return decodeXmlEntities(plain[1].replace(/<[^>]+>/g, "").trim());
  return undefined;
}

function extractAtomLink(block: string): string | undefined {
  const relAlternate = block.match(/<link\b[^>]*\brel\s*=\s*["']alternate["'][^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\/?>/i)
    ?? block.match(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\brel\s*=\s*["']alternate["'][^>]*\/?>/i);
  if (relAlternate?.[1]) return decodeXmlEntities(relAlternate[1].trim());
  const anyHref = block.match(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\/?>/i);
  if (anyHref?.[1]) return decodeXmlEntities(anyHref[1].trim());
  const plain = extractTag(block, "link");
  return plain && /^https?:\/\//i.test(plain) ? plain : undefined;
}

function matchBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) != null) {
    if (match[1] != null) blocks.push(match[1]);
  }
  return blocks;
}

function toResult(partial: {
  source: SourceType;
  url: string;
  title?: string | undefined;
  snippet?: string | undefined;
  author?: string | undefined;
  publishedAt?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  nativeId?: string | undefined;
}): DiscoveryResult | null {
  try {
    const url = assertPublicHttpUrl(partial.url).toString();
    const result: DiscoveryResult = { source: partial.source, url };
    if (partial.title != null) result.title = partial.title;
    if (partial.snippet != null) result.snippet = partial.snippet;
    if (partial.author != null) result.author = partial.author;
    if (partial.publishedAt != null) result.publishedAt = partial.publishedAt;
    if (partial.metadata != null) result.metadata = partial.metadata;
    if (partial.nativeId != null) result.nativeId = partial.nativeId;
    return result;
  } catch {
    return null;
  }
}

/** Parse RSS 2.0 / Atom feeds into discovery candidates (dependency-free string extraction). */
export function parseRssOrAtom(xml: string, sourceFeedUrl: string): DiscoveryResult[] {
  const results: DiscoveryResult[] = [];
  const itemBlocks = matchBlocks(xml, "item");
  for (const block of itemBlocks) {
    const link = extractTag(block, "link") ?? extractTag(block, "guid");
    if (!link) continue;
    const parsed = toResult({
      source: "rss",
      url: link,
      title: extractTag(block, "title"),
      snippet: extractTag(block, "description") ?? extractTag(block, "content:encoded"),
      author: extractTag(block, "author") ?? extractTag(block, "dc:creator"),
      publishedAt: extractTag(block, "pubDate") ?? extractTag(block, "dc:date"),
      metadata: { provider: "rss-atom", feedUrl: sourceFeedUrl, format: "rss" }
    });
    if (parsed) results.push(parsed);
  }
  if (results.length > 0) return results;

  const entryBlocks = matchBlocks(xml, "entry");
  for (const block of entryBlocks) {
    const link = extractAtomLink(block) ?? extractTag(block, "id");
    if (!link || !/^https?:\/\//i.test(link)) continue;
    const parsed = toResult({
      source: "rss",
      url: link,
      title: extractTag(block, "title"),
      snippet: extractTag(block, "summary") ?? extractTag(block, "content"),
      author: extractTag(block, "name") ?? extractTag(block, "author"),
      publishedAt: extractTag(block, "published") ?? extractTag(block, "updated"),
      metadata: { provider: "rss-atom", feedUrl: sourceFeedUrl, format: "atom" }
    });
    if (parsed) results.push(parsed);
  }
  return results;
}

/** Extract `<loc>` URLs from sitemap urlset / sitemapindex documents. */
export function parseSitemap(xml: string): DiscoveryResult[] {
  const locs: string[] = [];
  const re = /<loc\b[^>]*>([\s\S]*?)<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) != null) {
    const raw = decodeXmlEntities((match[1] ?? "").trim());
    if (raw) locs.push(raw);
  }
  const results: DiscoveryResult[] = [];
  for (const loc of locs) {
    const parsed = toResult({
      source: "web",
      url: loc,
      metadata: { provider: "sitemap" }
    });
    if (parsed) results.push(parsed);
  }
  return results;
}

function splitCsvUrls(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

const DISCOVERY_USER_AGENT = "reputa-discovery/0.1 (+https://reputation.orangecloud.vn; PulseWatch collector)";

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const safe = assertPublicHttpUrl(url);
  const headers = new Headers(init?.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", DISCOVERY_USER_AGENT);
  const response = await fetch(safe.toString(), {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`fetch_http_${response.status}`);
  return response.text();
}

/** Reddit's public search prefers simpler text than full Boolean AST strings. */
export function simplifyPublicSearchQuery(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const phrases = [...trimmed.matchAll(/"([^"]{2,80})"/g)].map((match) => match[1]!.trim()).filter(Boolean);
  const remainder = trimmed
    .replace(/"([^"]{2,80})"/g, " ")
    .replace(/[()]/g, " ")
    .replace(/\b(OR|AND|NOT)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const bareTerms = remainder.split(" ").map((term) => term.trim()).filter((term) => term.length >= 2).slice(0, 4);
  const parts = [
    ...phrases.slice(0, 3).map((phrase) => `"${phrase}"`),
    ...bareTerms
  ].slice(0, 4);
  if (parts.length === 0) return trimmed.slice(0, 120);
  return parts.join(" OR ").slice(0, 160);
}

export class BraveWebDiscoveryProvider implements DiscoveryProvider {
  readonly id = "brave-web";
  readonly source: SourceType = "web";
  readonly availability: SourceAvailability = "licensed-provider";
  readonly capabilities: SourceCapabilities = {
    keywordSearch: true,
    booleanSearch: true,
    historicalSearch: false,
    comments: false,
    engagement: false,
    renderMayBeRequired: true
  };

  readonly apiKey: string | undefined;

  constructor(apiKey: string | undefined) {
    this.apiKey = apiKey;
  }

  async discover(input: DiscoveryInput): Promise<DiscoveryResult[]> {
    if (!this.apiKey) return [];
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", input.query);
    url.searchParams.set("count", String(Math.min(20, Math.max(1, input.limit))));
    url.searchParams.set("safesearch", "moderate");
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "x-subscription-token": this.apiKey
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`brave_search_http_${response.status}`);
    const data = await response.json() as { web?: { results?: Array<Record<string, unknown>> } };
    return (data.web?.results ?? []).flatMap((item): DiscoveryResult[] => {
      if (typeof item.url !== "string") return [];
      const parsed = toResult({
        source: "web",
        url: item.url,
        title: typeof item.title === "string" ? item.title : undefined,
        snippet: typeof item.description === "string" ? item.description : undefined,
        publishedAt: typeof item.page_age === "string" ? item.page_age : undefined,
        metadata: { provider: "brave-search" }
      });
      return parsed ? [parsed] : [];
    });
  }
}

export class BraveNewsDiscoveryProvider implements DiscoveryProvider {
  readonly id = "brave-news";
  readonly source: SourceType = "news";
  readonly availability: SourceAvailability = "licensed-provider";
  readonly capabilities = SOURCE_CAPABILITY_DEFAULTS.news.capabilities;

  readonly apiKey: string | undefined;

  constructor(apiKey: string | undefined) {
    this.apiKey = apiKey;
  }

  async discover(input: DiscoveryInput): Promise<DiscoveryResult[]> {
    if (!this.apiKey) return [];
    const url = new URL("https://api.search.brave.com/res/v1/news/search");
    url.searchParams.set("q", input.query);
    url.searchParams.set("count", String(Math.min(20, Math.max(1, input.limit))));
    url.searchParams.set("safesearch", "moderate");
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "x-subscription-token": this.apiKey
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`brave_news_http_${response.status}`);
    const data = await response.json() as { results?: Array<Record<string, unknown>> };
    return (data.results ?? []).flatMap((item): DiscoveryResult[] => {
      if (typeof item.url !== "string") return [];
      const parsed = toResult({
        source: "news",
        url: item.url,
        title: typeof item.title === "string" ? item.title : undefined,
        snippet: typeof item.description === "string" ? item.description : undefined,
        publishedAt: typeof item.age === "string" ? item.age : (typeof item.page_age === "string" ? item.page_age : undefined),
        metadata: { provider: "brave-news" }
      });
      return parsed ? [parsed] : [];
    });
  }
}

export class RssFeedDiscoveryProvider implements DiscoveryProvider {
  readonly id = "rss-feeds";
  readonly source: SourceType = "rss";
  readonly availability: SourceAvailability = SOURCE_CAPABILITY_DEFAULTS.rss.availability;
  readonly capabilities = SOURCE_CAPABILITY_DEFAULTS.rss.capabilities;

  readonly feedUrls: string[];

  constructor(feedUrls: string[]) {
    this.feedUrls = feedUrls;
  }

  async discover(input: DiscoveryInput): Promise<DiscoveryResult[]> {
    const out: DiscoveryResult[] = [];
    const batches = await Promise.all(this.feedUrls.map(async (feedUrl) => {
      try {
        const xml = await fetchText(feedUrl, { headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" } });
        return parseRssOrAtom(xml, feedUrl).filter((item) => {
          const haystack = `${item.title ?? ""} ${item.snippet ?? ""}`;
          return evaluateBooleanAst(input.ast, haystack);
        });
      } catch {
        return [] as DiscoveryResult[];
      }
    }));
    for (const batch of batches) {
      for (const item of batch) {
        out.push(item);
        if (out.length >= input.limit) return out;
      }
    }
    return out.slice(0, input.limit);
  }
}

/** Free query-scoped public news RSS (HN + Bing + Yahoo + Google News + tech/startup site clusters). No API key required. */
export class PublicNewsRssDiscoveryProvider implements DiscoveryProvider {
  readonly id = "public-news-rss";
  readonly source: SourceType = "news";
  readonly availability: SourceAvailability = "public-web";
  readonly capabilities = SOURCE_CAPABILITY_DEFAULTS.news.capabilities;

  async discover(input: DiscoveryInput): Promise<DiscoveryResult[]> {
    const q = simplifyPublicSearchQuery(input.query) || input.query.trim();
    if (!q) return [];
    const encoded = encodeURIComponent(q);
    const templates = [
      `https://hnrss.org/newest?q=${encoded}`,
      `https://hnrss.org/newest?q=${encoded}&points=20`,
      `https://www.bing.com/news/search?q=${encoded}&format=rss`,
      `https://www.bing.com/news/search?q=${encoded}&format=rss&qft=interval%3d%227%22`,
      `https://www.bing.com/news/search?q=${encoded}&format=rss&cc=vn`,
      `https://news.yahoo.com/rss/search?p=${encoded}`,
      `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`,
      `https://news.google.com/rss/search?q=${encoded}&hl=vi&gl=VN&ceid=VN:vi`,
      // Famous tech + startup publisher clusters (wider page coverage beyond homepage feeds).
      ...TECH_STARTUP_SITE_CLAUSES.flatMap((clause) => {
        const scoped = encodeURIComponent(`${clause} ${q}`);
        return [
          `https://www.bing.com/news/search?q=${scoped}&format=rss`,
          `https://news.google.com/rss/search?q=${scoped}&hl=en-US&gl=US&ceid=US:en`
        ];
      })
    ];
    const out: DiscoveryResult[] = [];
    const seen = new Set<string>();
    const batches = await Promise.all(templates.map(async (feedUrl) => {
      try {
        const xml = await fetchText(feedUrl, {
          headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" }
        });
        return { feedUrl, items: parseRssOrAtom(xml, feedUrl) };
      } catch {
        return { feedUrl, items: [] as DiscoveryResult[] };
      }
    }));
    for (const { feedUrl, items } of batches) {
      for (const item of items) {
        const resolved = resolvePublicNewsUrl(item.url);
        if (!resolved) continue;
        const key = resolved.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        // Prefer publisher URLs — skip Google News interstitial pages that do not redirect.
        if (/^https?:\/\/news\.google\.com\//i.test(resolved)) continue;
        const parsed = toResult({
          source: "news",
          url: resolved,
          title: item.title,
          snippet: item.snippet,
          publishedAt: item.publishedAt,
          metadata: { ...(item.metadata ?? {}), provider: "public-news-rss", feedUrl }
        });
        if (!parsed) continue;
        out.push(parsed);
        if (out.length >= input.limit) return out;
      }
    }
    return out;
  }
}

/** High-yield Hacker News discovery via Algolia public API (no key). */
export class HackerNewsAlgoliaDiscoveryProvider implements DiscoveryProvider {
  readonly id = "hn-algolia";
  readonly source: SourceType = "web";
  readonly availability: SourceAvailability = "public-web";
  readonly capabilities: SourceCapabilities = {
    keywordSearch: true,
    booleanSearch: false,
    historicalSearch: true,
    comments: false,
    engagement: true,
    renderMayBeRequired: false
  };

  async discover(input: DiscoveryInput): Promise<DiscoveryResult[]> {
    const q = simplifyPublicSearchQuery(input.query) || input.query.trim();
    if (!q) return [];
    const url = new URL("https://hn.algolia.com/api/v1/search_by_date");
    url.searchParams.set("query", q);
    url.searchParams.set("tags", "story");
    url.searchParams.set("hitsPerPage", String(Math.min(50, Math.max(1, input.limit))));
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": DISCOVERY_USER_AGENT },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`hn_algolia_http_${response.status}`);
    const data = await response.json() as {
      hits?: Array<{
        objectID?: string;
        title?: string;
        url?: string | null;
        author?: string;
        created_at?: string;
        story_text?: string | null;
        points?: number;
      }>;
    };
    const out: DiscoveryResult[] = [];
    for (const hit of data.hits ?? []) {
      const external = typeof hit.url === "string" && hit.url.trim() ? hit.url.trim() : null;
      const fallback = hit.objectID ? `https://news.ycombinator.com/item?id=${hit.objectID}` : null;
      const candidateUrl = external ?? fallback;
      if (!candidateUrl) continue;
      const parsed = toResult({
        source: "web",
        url: candidateUrl,
        nativeId: hit.objectID,
        title: hit.title,
        snippet: typeof hit.story_text === "string" ? hit.story_text : undefined,
        author: hit.author,
        publishedAt: hit.created_at,
        metadata: {
          provider: "hn-algolia",
          points: hit.points,
          hnItem: hit.objectID ? `https://news.ycombinator.com/item?id=${hit.objectID}` : undefined
        }
      });
      if (!parsed) continue;
      out.push(parsed);
      if (out.length >= input.limit) break;
    }
    return out;
  }
}

/** Tag/topic feeds on DEV.to + Medium derived from the primary keyword. */
export class PublicTagFeedDiscoveryProvider implements DiscoveryProvider {
  readonly id = "public-tag-feeds";
  readonly source: SourceType = "rss";
  readonly availability: SourceAvailability = "public-web";
  readonly capabilities = SOURCE_CAPABILITY_DEFAULTS.rss.capabilities;

  async discover(input: DiscoveryInput): Promise<DiscoveryResult[]> {
    const tags = publicFeedTagsFromQuery(input.query);
    if (!tags.length) return [];
    const templates = tags.flatMap((tag) => [
      `https://dev.to/feed/tag/${encodeURIComponent(tag)}`,
      `https://medium.com/feed/tag/${encodeURIComponent(tag)}`
    ]);
    const out: DiscoveryResult[] = [];
    const seen = new Set<string>();
    const batches = await Promise.all(templates.map(async (feedUrl) => {
      try {
        const xml = await fetchText(feedUrl, {
          headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" }
        });
        return parseRssOrAtom(xml, feedUrl);
      } catch {
        return [] as DiscoveryResult[];
      }
    }));
    for (const items of batches) {
      for (const item of items) {
        const haystack = `${item.title ?? ""} ${item.snippet ?? ""}`;
        if (!evaluateBooleanAst(input.ast, haystack)) continue;
        const key = item.url.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          ...item,
          metadata: { ...(item.metadata ?? {}), provider: "public-tag-feeds" }
        });
        if (out.length >= input.limit) return out;
      }
    }
    return out;
  }
}

/** Map Boolean queries to safe public tag slugs (alphanumeric + hyphen). */
export function publicFeedTagsFromQuery(raw: string): string[] {
  const phrases = [...raw.matchAll(/"([^"]{2,80})"/g)]
    .map((match) => match[1]!.trim().toLowerCase())
    .map((phrase) => phrase.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter((tag) => tag.length >= 3 && tag.length <= 40);
  const remainder = raw
    .replace(/"([^"]{2,80})"/g, " ")
    .replace(/[()]/g, " ")
    .replace(/\b(OR|AND|NOT)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const bare = remainder
    .split(" ")
    .map((token) => token.trim().toLowerCase())
    .map((token) => token.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter((token) => token.length >= 2 && token.length <= 40);
  return [...new Set([...phrases, ...bare])].slice(0, 3);
}

/** Prefer publisher URLs when feeds wrap clicks (e.g. Bing News apiclick). */
export function resolvePublicNewsUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.hostname.endsWith("bing.com") && url.pathname.includes("apiclick")) {
      const nested = url.searchParams.get("url");
      if (nested) return assertPublicHttpUrl(nested).toString();
    }
    return assertPublicHttpUrl(raw).toString();
  } catch {
    return null;
  }
}

/**
 * Free Reddit discovery via public search Atom/RSS (no OAuth).
 * Prefer post permalinks; skip bare subreddit index pages.
 */
export class PublicRedditRssDiscoveryProvider implements DiscoveryProvider {
  readonly id = "public-reddit-rss";
  readonly source: SourceType = "reddit";
  readonly availability: SourceAvailability = "public-web";
  readonly capabilities: SourceCapabilities = {
    keywordSearch: true,
    booleanSearch: false,
    historicalSearch: false,
    comments: true,
    engagement: false,
    renderMayBeRequired: false
  };

  async discover(input: DiscoveryInput): Promise<DiscoveryResult[]> {
    const q = simplifyPublicSearchQuery(input.query);
    if (!q) return [];
    const templates = [
      `https://www.reddit.com/search.rss?q=${encodeURIComponent(q)}&sort=new&type=link&limit=25`,
      `https://old.reddit.com/search.rss?q=${encodeURIComponent(q)}&sort=new&limit=25`
    ];
    const out: DiscoveryResult[] = [];
    const seen = new Set<string>();
    const batches = await Promise.all(templates.map(async (feedUrl) => {
      try {
        const xml = await fetchText(feedUrl, {
          headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" }
        });
        return { feedUrl, items: parseRssOrAtom(xml, feedUrl) };
      } catch {
        return { feedUrl, items: [] as ReturnType<typeof parseRssOrAtom> };
      }
    }));
    for (const { feedUrl, items } of batches) {
      for (const item of items) {
        const url = resolveRedditPublicUrl(item.url);
        if (!url) continue;
        const key = url.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const parsed = toResult({
          source: "reddit",
          url,
          title: item.title,
          snippet: item.snippet,
          author: item.author,
          publishedAt: item.publishedAt,
          metadata: { ...(item.metadata ?? {}), provider: "public-reddit-rss", feedUrl }
        });
        if (!parsed) continue;
        out.push(parsed);
        if (out.length >= input.limit) return out;
      }
    }
    return out;
  }
}

/** Accept Reddit post/comment permalinks; reject bare subreddit hubs. */
export function resolveRedditPublicUrl(raw: string): string | null {
  try {
    const url = assertPublicHttpUrl(raw);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "reddit.com" && host !== "old.reddit.com" && host !== "np.reddit.com") return null;
    const path = url.pathname.replace(/\/+$/, "");
    // Prefer posts: /r/{sub}/comments/{id}/...
    if (/^\/r\/[^/]+\/comments\/[a-z0-9]+/i.test(path)) {
      url.hostname = "www.reddit.com";
      url.hash = "";
      return url.toString();
    }
    return null;
  } catch {
    return null;
  }
}

export class SitemapDiscoveryProvider implements DiscoveryProvider {
  readonly id = "sitemaps";
  readonly source: SourceType = "web";
  readonly availability: SourceAvailability = SOURCE_CAPABILITY_DEFAULTS.web.availability;
  readonly capabilities = SOURCE_CAPABILITY_DEFAULTS.web.capabilities;

  readonly sitemapUrls: string[];

  constructor(sitemapUrls: string[]) {
    this.sitemapUrls = sitemapUrls;
  }

  async discover(input: DiscoveryInput): Promise<DiscoveryResult[]> {
    const out: DiscoveryResult[] = [];
    for (const sitemapUrl of this.sitemapUrls) {
      try {
        const xml = await fetchText(sitemapUrl, { headers: { accept: "application/xml, text/xml, */*" } });
        out.push(...parseSitemap(xml));
      } catch {
        // Skip failing sitemaps.
      }
      if (out.length >= input.limit) break;
    }
    return out.slice(0, input.limit);
  }
}

export class YouTubeDiscoveryProvider implements DiscoveryProvider {
  readonly id = "youtube";
  readonly source: SourceType = "youtube";
  readonly availability: SourceAvailability = SOURCE_CAPABILITY_DEFAULTS.youtube.availability;
  readonly capabilities = SOURCE_CAPABILITY_DEFAULTS.youtube.capabilities;
  /** Observability note when live discovery is unavailable (never faked as results). */
  healthMetadata: Record<string, unknown> = { health: "uninitialized" };
  readonly apiKey: string | undefined;

  constructor(apiKey: string | undefined) {
    this.apiKey = apiKey;
  }

  async discover(input: DiscoveryInput): Promise<DiscoveryResult[]> {
    if (!this.apiKey) {
      this.healthMetadata = { health: "missing_credentials", note: "YOUTUBE_API_KEY not configured" };
      return [];
    }
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", "video");
    url.searchParams.set("q", input.query);
    url.searchParams.set("maxResults", String(Math.min(25, Math.max(1, input.limit))));
    url.searchParams.set("key", this.apiKey);
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`youtube_search_http_${response.status}`);
    this.healthMetadata = { health: "ok", provider: "youtube-data-api" };
    const data = await response.json() as {
      items?: Array<{
        id?: { videoId?: string };
        snippet?: { title?: string; description?: string; publishedAt?: string; channelTitle?: string };
      }>;
    };
    return (data.items ?? []).flatMap((item): DiscoveryResult[] => {
      const videoId = item.id?.videoId;
      if (!videoId) return [];
      const parsed = toResult({
        source: "youtube",
        url: `https://www.youtube.com/watch?v=${videoId}`,
        nativeId: videoId,
        title: item.snippet?.title,
        snippet: item.snippet?.description,
        author: item.snippet?.channelTitle,
        publishedAt: item.snippet?.publishedAt,
        metadata: { provider: "youtube-data-api", health: "ok" }
      });
      return parsed ? [parsed] : [];
    });
  }
}

export class XDiscoveryProvider implements DiscoveryProvider {
  readonly id = "x";
  readonly source: SourceType = "x";
  readonly availability: SourceAvailability = SOURCE_CAPABILITY_DEFAULTS.x.availability;
  readonly capabilities = SOURCE_CAPABILITY_DEFAULTS.x.capabilities;

  readonly bearerToken: string | undefined;

  constructor(bearerToken: string | undefined) {
    this.bearerToken = bearerToken;
  }

  async discover(input: DiscoveryInput): Promise<DiscoveryResult[]> {
    if (!this.bearerToken) return [];
    const url = new URL("https://api.twitter.com/2/tweets/search/recent");
    url.searchParams.set("query", input.query);
    url.searchParams.set("max_results", String(Math.min(100, Math.max(10, input.limit))));
    url.searchParams.set("tweet.fields", "created_at,author_id,text");
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.bearerToken}`
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`x_search_http_${response.status}`);
    const data = await response.json() as {
      data?: Array<{ id?: string; text?: string; created_at?: string; author_id?: string }>;
    };
    return (data.data ?? []).flatMap((item): DiscoveryResult[] => {
      if (!item.id) return [];
      const parsed = toResult({
        source: "x",
        url: `https://x.com/i/status/${item.id}`,
        nativeId: item.id,
        snippet: item.text,
        author: item.author_id,
        publishedAt: item.created_at,
        metadata: { provider: "x-recent-search", health: "ok" }
      });
      return parsed ? [parsed] : [];
    });
  }
}

export class RedditDiscoveryProvider implements DiscoveryProvider {
  readonly id = "reddit";
  readonly source: SourceType = "reddit";
  readonly availability: SourceAvailability = SOURCE_CAPABILITY_DEFAULTS.reddit.availability;
  readonly capabilities = SOURCE_CAPABILITY_DEFAULTS.reddit.capabilities;

  readonly accessToken: string | undefined;
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;

  constructor(
    accessToken: string | undefined,
    clientId?: string | undefined,
    clientSecret?: string | undefined
  ) {
    this.accessToken = accessToken;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  hasCredentials(): boolean {
    if (this.accessToken) return true;
    return Boolean(this.clientId && this.clientSecret);
  }

  async resolveAccessToken(): Promise<string | undefined> {
    if (this.accessToken) return this.accessToken;
    if (!this.clientId || !this.clientSecret) return undefined;
    const basic = btoa(`${this.clientId}:${this.clientSecret}`);
    const response = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "reputa-discovery/0.1"
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`reddit_token_http_${response.status}`);
    const data = await response.json() as { access_token?: string };
    return data.access_token;
  }

  async discover(input: DiscoveryInput): Promise<DiscoveryResult[]> {
    if (!this.hasCredentials()) return [];
    const token = await this.resolveAccessToken();
    if (!token) return [];
    const url = new URL("https://oauth.reddit.com/search");
    url.searchParams.set("q", input.query);
    url.searchParams.set("limit", String(Math.min(25, Math.max(1, input.limit))));
    url.searchParams.set("sort", "new");
    url.searchParams.set("type", "link");
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": "reputa-discovery/0.1"
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`reddit_search_http_${response.status}`);
    const data = await response.json() as {
      data?: { children?: Array<{ data?: { id?: string; url?: string; title?: string; selftext?: string; author?: string; created_utc?: number; permalink?: string } }> };
    };
    return (data.data?.children ?? []).flatMap((child): DiscoveryResult[] => {
      const post = child.data;
      if (!post) return [];
      const permalink = typeof post.permalink === "string" ? `https://www.reddit.com${post.permalink}` : undefined;
      const candidateUrl = (typeof post.url === "string" && /^https?:\/\//i.test(post.url) ? post.url : permalink);
      if (!candidateUrl) return [];
      const parsed = toResult({
        source: "reddit",
        url: candidateUrl,
        nativeId: post.id,
        title: post.title,
        snippet: post.selftext,
        author: post.author,
        publishedAt: typeof post.created_utc === "number" ? new Date(post.created_utc * 1000).toISOString() : undefined,
        metadata: { provider: "reddit-data-api", health: "ok", permalink }
      });
      return parsed ? [parsed] : [];
    });
  }
}

export class FacebookDiscoveryProvider implements DiscoveryProvider {
  readonly id = "facebook";
  readonly source: SourceType = "facebook";
  readonly availability: SourceAvailability = SOURCE_CAPABILITY_DEFAULTS.facebook.availability;
  readonly capabilities = SOURCE_CAPABILITY_DEFAULTS.facebook.capabilities;

  async discover(input: DiscoveryInput): Promise<DiscoveryResult[]> {
    return discoverPublicSocialSiteMentions("facebook", input);
  }
}

export class TikTokDiscoveryProvider implements DiscoveryProvider {
  readonly id = "tiktok";
  readonly source: SourceType = "tiktok";
  readonly availability: SourceAvailability = SOURCE_CAPABILITY_DEFAULTS.tiktok.availability;
  readonly capabilities = SOURCE_CAPABILITY_DEFAULTS.tiktok.capabilities;

  async discover(input: DiscoveryInput): Promise<DiscoveryResult[]> {
    return discoverPublicSocialSiteMentions("tiktok", input);
  }
}

export class LinkedInDiscoveryProvider implements DiscoveryProvider {
  readonly id = "linkedin";
  readonly source: SourceType = "linkedin";
  readonly availability: SourceAvailability = SOURCE_CAPABILITY_DEFAULTS.linkedin.availability;
  readonly capabilities = SOURCE_CAPABILITY_DEFAULTS.linkedin.capabilities;

  async discover(input: DiscoveryInput): Promise<DiscoveryResult[]> {
    return discoverPublicSocialSiteMentions("linkedin", input);
  }
}

/** Hosts treated as first-party for public social site discovery. */
export const PUBLIC_SOCIAL_SITE_HOSTS: Record<"facebook" | "tiktok" | "linkedin", string[]> = {
  facebook: ["facebook.com", "fb.com", "fb.watch"],
  tiktok: ["tiktok.com"],
  linkedin: ["linkedin.com", "lnkd.in"]
};

export function isPublicSocialSiteHost(source: "facebook" | "tiktok" | "linkedin", hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return PUBLIC_SOCIAL_SITE_HOSTS[source].some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * Free discovery for Facebook / TikTok / LinkedIn via public Bing + Google News RSS
 * with site: filters. Does not fabricate posts — only indexed public URLs.
 */
export async function discoverPublicSocialSiteMentions(
  source: "facebook" | "tiktok" | "linkedin",
  input: DiscoveryInput
): Promise<DiscoveryResult[]> {
  const q = simplifyPublicSearchQuery(input.query) || input.query.trim();
  if (!q) return [];
  const hosts = PUBLIC_SOCIAL_SITE_HOSTS[source];
  const siteClause = hosts.slice(0, 2).map((host) => `site:${host}`).join(" OR ");
  const encoded = encodeURIComponent(`(${siteClause}) ${q}`);
  const templates = [
    `https://www.bing.com/news/search?q=${encoded}&format=rss`,
    `https://www.bing.com/search?q=${encoded}&format=rss`,
    `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${encoded}&hl=vi&gl=VN&ceid=VN:vi`
  ];
  const out: DiscoveryResult[] = [];
  const seen = new Set<string>();
  const batches = await Promise.all(templates.map(async (feedUrl) => {
    try {
      const xml = await fetchText(feedUrl, {
        headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" }
      });
      return { feedUrl, items: parseRssOrAtom(xml, feedUrl) };
    } catch {
      return { feedUrl, items: [] as DiscoveryResult[] };
    }
  }));
  for (const { feedUrl, items } of batches) {
    for (const item of items) {
      const resolved = resolvePublicNewsUrl(item.url);
      if (!resolved) continue;
      let hostname = "";
      try {
        hostname = new URL(resolved).hostname;
      } catch {
        continue;
      }
      if (!isPublicSocialSiteHost(source, hostname)) continue;
      const key = resolved.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const parsed = toResult({
        source,
        url: resolved,
        title: item.title,
        snippet: item.snippet,
        publishedAt: item.publishedAt,
        metadata: { ...(item.metadata ?? {}), provider: `public-${source}-site-rss`, feedUrl }
      });
      if (!parsed) continue;
      out.push(parsed);
      if (out.length >= input.limit) return out;
    }
  }
  return out;
}

/**
 * Closed / private community discovery.
 * Honest no-op without authorized credentials — never bypasses login walls or invites.
 */
abstract class ClosedGroupDiscoveryProvider implements DiscoveryProvider {
  abstract readonly id: string;
  abstract readonly source: SourceType;
  readonly availability: SourceAvailability = "contract-required";
  abstract readonly capabilities: SourceCapabilities;

  async discover(_input: DiscoveryInput): Promise<DiscoveryResult[]> {
    // Collection requires customer-authorized access (official APIs / bot tokens / membership).
    return [];
  }
}

export class FacebookGroupDiscoveryProvider extends ClosedGroupDiscoveryProvider {
  readonly id = "facebook-group";
  readonly source: SourceType = "facebook_group";
  readonly capabilities = SOURCE_CAPABILITY_DEFAULTS.facebook_group.capabilities;
}

export class TelegramDiscoveryProvider extends ClosedGroupDiscoveryProvider {
  readonly id = "telegram";
  readonly source: SourceType = "telegram";
  readonly capabilities = SOURCE_CAPABILITY_DEFAULTS.telegram.capabilities;
}

export class ZaloDiscoveryProvider extends ClosedGroupDiscoveryProvider {
  readonly id = "zalo";
  readonly source: SourceType = "zalo";
  readonly capabilities = SOURCE_CAPABILITY_DEFAULTS.zalo.capabilities;
}

export class DiscordDiscoveryProvider extends ClosedGroupDiscoveryProvider {
  readonly id = "discord";
  readonly source: SourceType = "discord";
  readonly capabilities = SOURCE_CAPABILITY_DEFAULTS.discord.capabilities;
}

export function createFederatedDiscoveryProviders(env: {
  BRAVE_SEARCH_API_KEY?: string | undefined;
  RSS_FEED_URLS?: string | undefined;
  SITEMAP_URLS?: string | undefined;
}): DiscoveryProvider[] {
  const providers: DiscoveryProvider[] = [
    // Always-on free discovery so production collects without paid API keys.
    new PublicNewsRssDiscoveryProvider(),
    new HackerNewsAlgoliaDiscoveryProvider(),
    new PublicRedditRssDiscoveryProvider(),
    new PublicTagFeedDiscoveryProvider()
  ];
  if (env.BRAVE_SEARCH_API_KEY) {
    providers.push(new BraveWebDiscoveryProvider(env.BRAVE_SEARCH_API_KEY));
    providers.push(new BraveNewsDiscoveryProvider(env.BRAVE_SEARCH_API_KEY));
  }
  const feedUrls = mergeRssFeedUrls(DEFAULT_PUBLIC_RSS_FEEDS, splitCsvUrls(env.RSS_FEED_URLS));
  if (feedUrls.length > 0) providers.push(new RssFeedDiscoveryProvider(feedUrls));
  const sitemapUrls = splitCsvUrls(env.SITEMAP_URLS);
  if (sitemapUrls.length > 0) providers.push(new SitemapDiscoveryProvider(sitemapUrls));
  return providers;
}

export function createSocialDiscoveryProviders(env: {
  YOUTUBE_API_KEY?: string | undefined;
  X_BEARER_TOKEN?: string | undefined;
  REDDIT_ACCESS_TOKEN?: string | undefined;
  REDDIT_CLIENT_ID?: string | undefined;
  REDDIT_CLIENT_SECRET?: string | undefined;
}): DiscoveryProvider[] {
  return [
    new YouTubeDiscoveryProvider(env.YOUTUBE_API_KEY),
    new XDiscoveryProvider(env.X_BEARER_TOKEN),
    // OAuth Reddit when approved credentials exist; free public RSS is always in federated list.
    new RedditDiscoveryProvider(env.REDDIT_ACCESS_TOKEN, env.REDDIT_CLIENT_ID, env.REDDIT_CLIENT_SECRET),
    new FacebookDiscoveryProvider(),
    new TikTokDiscoveryProvider(),
    new LinkedInDiscoveryProvider(),
    // Closed groups — contract-required until authorized access is connected.
    new FacebookGroupDiscoveryProvider(),
    new TelegramDiscoveryProvider(),
    new ZaloDiscoveryProvider(),
    new DiscordDiscoveryProvider()
  ];
}

export function sourceHealthSnapshot(providers: DiscoveryProvider[]): Array<{ id: string; source: SourceType; availability: SourceAvailability }> {
  return providers.map((provider) => ({
    id: provider.id,
    source: provider.source,
    availability: provider.availability
  }));
}
