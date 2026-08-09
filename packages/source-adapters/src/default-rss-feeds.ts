/**
 * Always-on public RSS/Atom feeds for federated discovery.
 * Curated for tech news, startups, engineering blogs, security, and VN tech press.
 * Env `RSS_FEED_URLS` is merged on top (deduped) — never scrape behind logins.
 */
export const DEFAULT_PUBLIC_RSS_FEEDS: readonly string[] = [
  // General / world news (tech-relevant context)
  "https://feeds.bbci.co.uk/news/rss.xml",
  "https://feeds.bbci.co.uk/news/technology/rss.xml",
  "https://www.theguardian.com/world/rss",
  "https://www.theguardian.com/technology/rss",
  "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml",

  // Famous tech press
  "https://techcrunch.com/feed/",
  "https://feeds.feedburner.com/TechCrunch/",
  "https://techcrunch.com/category/startups/feed/",
  "https://www.theverge.com/rss/index.xml",
  "https://feeds.arstechnica.com/arstechnica/index",
  "https://arstechnica.com/feed/",
  "https://www.wired.com/feed/rss",
  "https://www.wired.com/feed/category/business/latest/rss",
  "https://www.engadget.com/rss.xml",
  "https://www.theregister.com/headlines.atom",
  "https://www.zdnet.com/news/rss.xml",
  "https://www.cnet.com/rss/news/",
  "https://www.technologyreview.com/feed/",
  "https://venturebeat.com/feed/",
  "https://www.thenextweb.com/feed",
  "https://gizmodo.com/rss",
  "https://www.digitaltrends.com/feed/",
  "https://www.androidauthority.com/feed/",
  "https://9to5mac.com/feed/",
  "https://www.macrumors.com/macrumors.xml",

  // Startup / VC / product
  "https://news.crunchbase.com/feed/",
  "https://sifted.eu/feed/",
  "https://www.eu-startups.com/feed/",
  "https://tech.eu/feed/",
  "https://www.techinasia.com/rss",
  "https://www.betakit.com/feed/",
  "https://www.geekwire.com/feed/",
  "https://www.startupdaily.net/feed/",
  "https://blog.ycombinator.com/feed/",
  "https://www.producthunt.com/feed",
  "https://www.fastcompany.com/latest/rss",
  "https://www.inc.com/rss/",
  "https://hnrss.org/frontpage",
  "https://news.ycombinator.com/rss",

  // Engineering / developer blogs
  "https://blog.cloudflare.com/rss/",
  "https://github.blog/feed/",
  "https://stackoverflow.blog/feed/",
  "https://thenewstack.io/feed/",
  "https://www.infoq.com/feed",
  "https://www.smashingmagazine.com/feed/",
  "https://css-tricks.com/feed/",
  "https://openai.com/blog/rss.xml",
  "https://blog.google/rss/",
  "https://aws.amazon.com/blogs/aws/feed/",
  "https://devblogs.microsoft.com/feed/",
  "https://engineering.fb.com/feed/",
  "https://netflixtechblog.com/feed",
  "https://stripe.com/blog/feed.rss",
  "https://simonwillison.net/atom/everything/",
  "https://martinfowler.com/feed.atom",

  // Security
  "https://www.bleepingcomputer.com/feed/",
  "https://www.securityweek.com/feed/",
  "https://krebsonsecurity.com/feed/",
  "https://www.darkreading.com/rss.xml",

  // Vietnam tech / business press
  "https://vnexpress.net/rss/tin-moi-nhat.rss",
  "https://vnexpress.net/rss/kinh-doanh.rss",
  "https://vnexpress.net/rss/so-hoa.rss",
  "https://thanhnien.vn/rss/home.rss",
  "https://tuoitre.vn/rss/tin-moi-nhat.rss",
  "https://vietnamnet.vn/rss/cong-nghe.rss",
  "https://ictnews.vietnamnet.vn/rss/home.rss",
  "https://cafef.vn/thi-truong.rss"
];

/** Publisher site: clusters for query-scoped news RSS (Bing / Google News). */
export const TECH_STARTUP_SITE_CLAUSES: readonly string[] = [
  "(site:techcrunch.com OR site:theverge.com OR site:wired.com OR site:arstechnica.com OR site:engadget.com OR site:thenextweb.com OR site:venturebeat.com OR site:zdnet.com)",
  "(site:technologyreview.com OR site:cnet.com OR site:theregister.com OR site:bleepingcomputer.com OR site:github.blog OR site:producthunt.com)",
  "(site:techinasia.com OR site:sifted.eu OR site:crunchbase.com OR site:geekwire.com OR site:betakit.com OR site:tech.eu OR site:eu-startups.com)",
  "(site:ycombinator.com OR site:news.ycombinator.com OR site:fastcompany.com OR site:inc.com OR site:startupdaily.net)",
  "(site:vnexpress.net OR site:vietnamnet.vn OR site:ictnews.vietnamnet.vn OR site:thanhnien.vn OR site:tuoitre.vn OR site:cafef.vn)"
];

export function mergeRssFeedUrls(...groups: Array<readonly string[] | string[] | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    if (!group) continue;
    for (const raw of group) {
      const url = String(raw || "").trim();
      if (!url) continue;
      const key = url.toLowerCase().replace(/\/+$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(url);
    }
  }
  return out;
}
