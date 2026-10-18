import test from "node:test";
import assert from "node:assert/strict";
import {
  batchCrawlJobs,
  CRAWL_QUEUE_MESSAGE_MAX_BYTES,
  crawlMessageBytes,
  fitCrawlJob
} from "../workers/discovery/src/messages.ts";
import { compactDiscoveryText, parseRssOrAtom, RssFeedDiscoveryProvider } from "../packages/source-adapters/src/index.ts";

test("full RSS article bodies are compacted before they can be queued", () => {
  const article = `<p>${"negative mention of Acme. ".repeat(8000)}</p>`;
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><item>
    <title>Acme review</title>
    <link>https://example.com/reviews/acme</link>
    <content:encoded><![CDATA[${article}]]></content:encoded>
  </item></channel></rss>`;
  const results = parseRssOrAtom(xml, "https://example.com/feed.xml");
  assert.equal(results.length, 1);
  assert.ok((results[0]?.snippet?.length ?? 0) <= 4_000);
  assert.match(results[0]?.snippet ?? "", /negative mention of Acme/);
  assert.equal(results[0]?.snippet?.includes("<p>"), false);
});

test("crawl messages larger than the queue limit are shrunk to fit", () => {
  const job = {
    schemaVersion: 1,
    jobId: "j",
    traceId: "t",
    priority: "normal",
    createdAt: "2026-10-18T00:00:00.000Z",
    attempt: 0,
    payload: {
      source: "rss",
      url: "https://example.com/post",
      discoveryKey: "k",
      title: "T".repeat(500),
      snippet: "S".repeat(250_542)
    }
  };
  const fitted = fitCrawlJob(job);
  assert.ok(crawlMessageBytes(fitted) <= CRAWL_QUEUE_MESSAGE_MAX_BYTES);
  assert.ok((fitted.payload.snippet?.length ?? 0) <= 4_000);
  assert.equal(fitted.payload.url, job.payload.url);
});

test("crawl sends are split into bounded batches", () => {
  const jobs = Array.from({ length: 60 }, (_, index) => ({
    id: index,
    payload: { url: `https://example.com/${index}`, blob: "x".repeat(10_000) }
  }));
  const batches = batchCrawlJobs(jobs);
  assert.ok(batches.length > 1);
  assert.ok(batches.every((batch) => batch.length <= 50));
  assert.ok(batches.every((batch) => crawlMessageBytes(batch) <= 200_000));
  assert.equal(batches.flat().length, jobs.length);
});

test("static RSS catalog is fetched once for every query on the same provider", async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(`<?xml version="1.0"?><rss version="2.0"><channel><item>
      <title>Acme ships</title>
      <link>https://example.com/acme</link>
      <description>Acme launch notes</description>
    </item></channel></rss>`, { status: 200, headers: { "content-type": "application/rss+xml" } });
  };
  try {
    const provider = new RssFeedDiscoveryProvider(["https://example.com/feed.xml", "https://example.com/feed-2.xml"]);
    const input = { query: "Acme", ast: { type: "term", value: "Acme", phrase: false }, limit: 10 };
    const first = await provider.discover(input);
    const second = await provider.discover({ ...input, query: "Acme OR launch" });
    assert.equal(calls, 2);
    assert.equal(first.length, 2);
    assert.equal(second.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("compactDiscoveryText collapses markup", () => {
  assert.equal(compactDiscoveryText("<p>Hello&nbsp;<b>world</b></p>", 100), "Hello world");
});
