import test from "node:test";
import assert from "node:assert/strict";
import {
  BraveWebDiscoveryProvider,
  FacebookDiscoveryProvider,
  LinkedInDiscoveryProvider,
  RedditDiscoveryProvider,
  SOURCE_CAPABILITY_DEFAULTS,
  TikTokDiscoveryProvider,
  XDiscoveryProvider,
  YouTubeDiscoveryProvider,
  createFederatedDiscoveryProviders,
  createSocialDiscoveryProviders,
  parseRssOrAtom,
  parseSitemap,
  sourceHealthSnapshot
} from "../packages/source-adapters/src/index.ts";
import { assertPublicHttpUrl } from "../packages/crawler-core/src/index.ts";

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <item>
      <title>First Item</title>
      <link>https://example.com/posts/1</link>
      <description>Hello RSS world</description>
      <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
      <author>alice@example.com</author>
    </item>
    <item>
      <title>Second Item</title>
      <link>https://example.com/posts/2</link>
      <description><![CDATA[CDATA snippet]]></description>
      <pubDate>Tue, 02 Jan 2024 12:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const SAMPLE_ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom</title>
  <entry>
    <title>Atom Entry</title>
    <link href="https://example.com/atom/1" rel="alternate"/>
    <id>urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a</id>
    <updated>2024-03-01T18:30:02Z</updated>
    <published>2024-03-01T18:30:02Z</published>
    <summary>Atom summary text</summary>
    <author><name>Bob</name></author>
  </entry>
</feed>`;

const SAMPLE_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/a</loc>
  </url>
  <url>
    <loc>https://example.com/b</loc>
  </url>
</urlset>`;

test("parseRssOrAtom extracts RSS 2.0 items", () => {
  const results = parseRssOrAtom(SAMPLE_RSS, "https://example.com/feed.xml");
  assert.equal(results.length, 2);
  assert.equal(results[0]?.source, "rss");
  assert.equal(results[0]?.url, "https://example.com/posts/1");
  assert.equal(results[0]?.title, "First Item");
  assert.equal(results[0]?.snippet, "Hello RSS world");
  assert.equal(results[0]?.publishedAt, "Mon, 01 Jan 2024 12:00:00 GMT");
  assert.equal(results[1]?.snippet, "CDATA snippet");
  assert.equal(results[0]?.metadata?.feedUrl, "https://example.com/feed.xml");
});

test("parseRssOrAtom extracts Atom entries", () => {
  const results = parseRssOrAtom(SAMPLE_ATOM, "https://example.com/atom.xml");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.url, "https://example.com/atom/1");
  assert.equal(results[0]?.title, "Atom Entry");
  assert.equal(results[0]?.snippet, "Atom summary text");
  assert.equal(results[0]?.publishedAt, "2024-03-01T18:30:02Z");
  assert.equal(results[0]?.metadata?.format, "atom");
});

test("parseSitemap extracts loc URLs as web source", () => {
  const results = parseSitemap(SAMPLE_SITEMAP);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.url), ["https://example.com/a", "https://example.com/b"]);
  assert.ok(results.every((r) => r.source === "web"));
});

test("federated list includes brave when key set", () => {
  const withKey = createFederatedDiscoveryProviders({ BRAVE_SEARCH_API_KEY: "test-key" });
  assert.ok(withKey.some((p) => p instanceof BraveWebDiscoveryProvider));
  assert.ok(withKey.some((p) => p.id === "brave-web"));
  assert.ok(withKey.some((p) => p.id === "brave-news"));
  assert.ok(withKey.some((p) => p.id === "public-news-rss"));

  const withoutKey = createFederatedDiscoveryProviders({});
  assert.equal(withoutKey.some((p) => p.id === "brave-web"), false);
  assert.ok(withoutKey.some((p) => p.id === "public-news-rss"), "free public news RSS must always be enabled");
  assert.ok(withoutKey.some((p) => p.id === "public-reddit-rss"), "free public Reddit RSS must always be enabled");

  const withFeeds = createFederatedDiscoveryProviders({
    RSS_FEED_URLS: "https://example.com/feed.xml",
    SITEMAP_URLS: "https://example.com/sitemap.xml"
  });
  assert.ok(withFeeds.some((p) => p.id === "rss-feeds"));
  assert.ok(withFeeds.some((p) => p.id === "sitemaps"));
  assert.doesNotThrow(() => assertPublicHttpUrl("https://example.com/feed.xml"));
  assert.doesNotThrow(() => assertPublicHttpUrl("https://example.com/sitemap.xml"));
});

test("public news RSS resolves Bing apiclick to publisher URLs", async () => {
  const { PublicNewsRssDiscoveryProvider, resolvePublicNewsUrl } = await import("../packages/source-adapters/src/index.ts");
  const nested = resolvePublicNewsUrl(
    "http://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fwww.forbes.com%2fsites%2fexample%2fcloudflare%2f&c=1&mkt=en-us"
  );
  assert.equal(nested, "https://www.forbes.com/sites/example/cloudflare/");
  assert.equal(resolvePublicNewsUrl("https://news.google.com/rss/articles/ABC"), "https://news.google.com/rss/articles/ABC");

  const provider = new PublicNewsRssDiscoveryProvider();
  let results = [];
  try {
    results = await provider.discover({
      query: "Cloudflare",
      ast: { type: "term", value: "Cloudflare", phrase: false },
      limit: 10
    });
  } catch (error) {
    console.warn("public news live probe skipped:", error instanceof Error ? error.message : error);
    return;
  }
  if (!results.length) {
    console.warn("public news live probe returned 0 candidates — skipping strict asserts");
    return;
  }
  assert.ok(results.every((item) => item.source === "news"));
  assert.ok(results.every((item) => /^https?:\/\//i.test(item.url)));
  assert.ok(results.every((item) => !/news\.google\.com/i.test(item.url)));
});

test("public Reddit RSS keeps post permalinks and simplifies queries", async () => {
  const {
    PublicRedditRssDiscoveryProvider,
    resolveRedditPublicUrl,
    simplifyPublicSearchQuery
  } = await import("../packages/source-adapters/src/index.ts");

  assert.equal(
    resolveRedditPublicUrl("https://www.reddit.com/r/Cloudflare/comments/abc123/hello_world/"),
    "https://www.reddit.com/r/Cloudflare/comments/abc123/hello_world/"
  );
  assert.equal(resolveRedditPublicUrl("https://www.reddit.com/r/CloudFlare/"), null);
  assert.equal(simplifyPublicSearchQuery("\"AI agent\" OR ChatGPT"), "\"AI agent\" OR ChatGPT");
  assert.equal(simplifyPublicSearchQuery("Cloudflare OR Workers"), "Cloudflare OR Workers");

  const provider = new PublicRedditRssDiscoveryProvider();
  assert.equal(provider.availability, "public-web");
  let results = [];
  try {
    results = await provider.discover({
      query: "Cloudflare",
      ast: { type: "term", value: "Cloudflare", phrase: false },
      limit: 8
    });
  } catch (error) {
    console.warn("public reddit live probe skipped:", error instanceof Error ? error.message : error);
    return;
  }
  if (!results.length) {
    console.warn("public reddit live probe returned 0 candidates — skipping strict asserts");
    return;
  }
  assert.ok(results.every((item) => item.source === "reddit"));
  assert.ok(results.every((item) => /reddit\.com\/r\/[^/]+\/comments\//i.test(item.url)));
});

test("social stubs return empty without credentials", async () => {
  const providers = createSocialDiscoveryProviders({});
  const input = { query: "Acme", ast: { type: "term", value: "Acme", phrase: false }, limit: 10 };
  for (const provider of providers) {
    const results = await provider.discover(input);
    assert.deepEqual(results, []);
  }
  assert.deepEqual(await new FacebookDiscoveryProvider().discover(input), []);
  assert.deepEqual(await new TikTokDiscoveryProvider().discover(input), []);
  assert.deepEqual(await new LinkedInDiscoveryProvider().discover(input), []);
});

test("youtube/x/reddit providers report correct availability", () => {
  const youtube = new YouTubeDiscoveryProvider(undefined);
  const x = new XDiscoveryProvider(undefined);
  const reddit = new RedditDiscoveryProvider(undefined);
  assert.equal(youtube.availability, SOURCE_CAPABILITY_DEFAULTS.youtube.availability);
  assert.equal(youtube.availability, "native-api");
  assert.equal(x.availability, SOURCE_CAPABILITY_DEFAULTS.x.availability);
  assert.equal(x.availability, "native-api");
  assert.equal(reddit.availability, SOURCE_CAPABILITY_DEFAULTS.reddit.availability);
  assert.equal(reddit.availability, "contract-required");

  assert.equal(new FacebookDiscoveryProvider().availability, "degraded");
  assert.equal(new TikTokDiscoveryProvider().availability, "degraded");
  assert.equal(new LinkedInDiscoveryProvider().availability, "degraded");

  const snapshot = sourceHealthSnapshot([youtube, x, reddit]);
  assert.deepEqual(snapshot, [
    { id: "youtube", source: "youtube", availability: "native-api" },
    { id: "x", source: "x", availability: "native-api" },
    { id: "reddit", source: "reddit", availability: "contract-required" }
  ]);
});
