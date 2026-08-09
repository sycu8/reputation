import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateBooleanAst,
  normalizeBooleanQuery,
  parseBooleanQuery,
  tokenize
} from "../packages/boolean-query/src/index.ts";
import { assertPublicHttpUrl, excerptForStorage, htmlToPlainText, normalizeUrl, readableContentText, unwrapBrowserRunPayload } from "../packages/crawler-core/src/index.ts";

test("Boolean parser honors NOT > AND > OR and implicit AND", () => {
  const ast = parseBooleanQuery('"Acme Corp" refund OR complaint NOT school');
  assert.equal(ast.type, "or");
  assert.equal(evaluateBooleanAst(ast, "Acme Corp issued a refund today"), true);
  assert.equal(evaluateBooleanAst(ast, "complaint about Acme but school event"), false);
  assert.equal(evaluateBooleanAst(ast, "completely unrelated"), false);
});

test("Boolean parser supports nested Vietnamese phrases deterministically", () => {
  const raw = '("ABC Việt Nam" OR ABC) AND ("hoàn tiền" OR refund) NOT "ABC School"';
  const normalized = normalizeBooleanQuery(raw);
  const reparsed = parseBooleanQuery(normalized);
  assert.equal(evaluateBooleanAst(reparsed, "Khách hàng ABC Việt Nam phản ánh chưa được hoàn tiền"), true);
  assert.equal(evaluateBooleanAst(reparsed, "ABC School thông báo hoàn tiền học phí"), false);
  assert.ok(tokenize(raw).length > 5);
});

test("Boolean parser rejects malformed syntax", () => {
  assert.throws(() => parseBooleanQuery('"unterminated'), /Unterminated/);
  assert.throws(() => parseBooleanQuery("(ABC OR DEF"), /Missing closing/);
  assert.throws(() => parseBooleanQuery("AND ABC"), /Unexpected/);
});

test("URL normalization removes tracking and SSRF guard blocks private literals", () => {
  assert.equal(
    normalizeUrl("https://Example.com:443/path/?utm_source=x&b=2&a=1#section"),
    "https://example.com/path?a=1&b=2"
  );
  assert.throws(() => assertPublicHttpUrl("http://127.0.0.1/admin"), /ssrf_blocked/);
  assert.throws(() => assertPublicHttpUrl("http://10.0.0.4/"), /ssrf_blocked/);
  assert.doesNotThrow(() => assertPublicHttpUrl("https://example.com/page"));
});

test("Browser Run JSON envelopes unwrap into readable plain text", () => {
  const envelope = JSON.stringify({
    success: true,
    result: "<html><head><title>HN Hiring</title></head><body><h1>Who is hiring?</h1><p>Cloudflare is hiring.\nRemote OK.</p></body></html>",
    meta: { title: "HN Hiring — Who is Hiring?", status: 200 }
  });
  const unwrapped = unwrapBrowserRunPayload(envelope);
  assert.equal(unwrapped.title, "HN Hiring — Who is Hiring?");
  assert.match(unwrapped.body, /Who is hiring/);
  const plain = htmlToPlainText(unwrapped.body);
  assert.equal(plain.title, "HN Hiring");
  assert.match(plain.text, /Cloudflare is hiring/);
  assert.doesNotMatch(plain.text, /success/);
  assert.doesNotMatch(readableContentText(envelope), /\\n/);
  assert.doesNotMatch(readableContentText(envelope), /"success"/);
  const excerpt = excerptForStorage(envelope, 80);
  assert.ok(excerpt.length <= 80);
  assert.doesNotMatch(excerpt, /\{"success"/);
});

test("readableContentText recovers truncated Browser Run blobs", () => {
  const truncated = '{"success":true,"result":" \\n \\n HN Hiring — Who is Hiring?\\nCloudflare revenue grew.\\n';
  const text = readableContentText(truncated);
  assert.match(text, /HN Hiring/);
  assert.match(text, /Cloudflare revenue/);
  assert.doesNotMatch(text, /success/);
});
