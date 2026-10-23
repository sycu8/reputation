import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import api from "../apps/api-worker/src/index.ts";
import { applyDiscoveryHeaders, CANONICAL_HOST, DISCOVERY_LINK } from "../apps/dashboard/src/discovery-headers.ts";
import { apiBaseForHost, handleMcp } from "../apps/dashboard/src/mcp.ts";
import { apiCall, makeLocalEnv } from "./helpers/local-env.mjs";

const root = new URL("../apps/dashboard/public/", import.meta.url);

function readPublic(path) {
  return readFileSync(new URL(path, root), "utf8");
}

test("robots.txt publishes crawl rules, AI user-agents, content signals, and the sitemap", () => {
  const robots = readPublic("robots.txt");
  assert.match(robots, /User-agent: \*/);
  assert.match(robots, /Allow: \//);
  assert.match(robots, /Disallow: \/app\//);
  assert.match(robots, /Disallow: \/api\//);
  for (const agent of ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot", "GPTBot", "ClaudeBot", "Google-Extended"]) {
    assert.match(robots, new RegExp(`User-agent: ${agent}`));
  }
  assert.match(robots, /Content-Signal: ai-train=no, search=yes, ai-input=no/);
  assert.match(robots, /Sitemap: https:\/\/reputation\.orangecloud\.vn\/sitemap\.xml/);
  assert.match(robots, /Agentmap: https:\/\/reputation\.orangecloud\.vn\/\.well-known\/ai-catalog\.json/);
  assert.equal(robots.includes("\0"), false);
});

test("sitemap lists canonical public URLs", () => {
  const xml = readPublic("sitemap.xml");
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  for (const loc of [
    "https://reputation.orangecloud.vn/",
    "https://reputation.orangecloud.vn/docs/",
    "https://reputation.orangecloud.vn/auth.md"
  ]) {
    assert.match(xml, new RegExp(`<loc>${loc.replaceAll("/", "\\/")}<\\/loc>`));
  }
  assert.doesNotMatch(xml, /\/app\//);
});

test("api catalog is a linkset with service-desc, service-doc, and status", () => {
  const catalog = JSON.parse(readPublic(".well-known/api-catalog"));
  assert.ok(Array.isArray(catalog.linkset));
  const entry = catalog.linkset[0];
  assert.equal(entry.anchor, "https://reputation.orangecloud.vn/api");
  assert.equal(entry["service-desc"][0].href, "https://reputation.orangecloud.vn/openapi.json");
  assert.equal(entry["service-doc"][0].href, "https://reputation.orangecloud.vn/docs/");
  assert.equal(entry.status[0].href, "https://reputation.orangecloud.vn/api/health");
  const spec = JSON.parse(readPublic("openapi.json"));
  assert.equal(spec.openapi, "3.1.0");
  assert.equal(spec.paths["/health"].get.operationId, "getHealth");
  assert.equal(spec.paths["/v1/auth/login"].post.operationId, "login");
});

test("oauth discovery, protected resource metadata, and auth.md agree", () => {
  const authorization = JSON.parse(readPublic(".well-known/oauth-authorization-server"));
  const openid = JSON.parse(readPublic(".well-known/openid-configuration"));
  const resource = JSON.parse(readPublic(".well-known/oauth-protected-resource"));
  const jwks = JSON.parse(readPublic(".well-known/jwks.json"));
  assert.deepEqual(authorization, openid);
  assert.equal(authorization.issuer, "https://reputation.orangecloud.vn");
  assert.equal(resource.authorization_servers[0], authorization.issuer);
  assert.equal(resource.resource, "https://reputation.orangecloud.vn/api");
  assert.ok(resource.bearer_methods_supported.includes("header"));
  assert.equal(authorization.token_endpoint, "https://reputation.orangecloud.vn/api/v1/auth/login");
  assert.ok(authorization.grant_types_supported.includes("password"));
  assert.equal(authorization.agent_auth.skill, "https://reputation.orangecloud.vn/auth.md");
  assert.equal(authorization.agent_auth.register_uri, "https://reputation.orangecloud.vn/api/v1/auth/signup");
  assert.deepEqual(authorization.agent_auth.identity_types_supported, ["verified_email"]);
  assert.ok(authorization.agent_auth.verified_email.credential_types_supported.includes("session_bearer"));
  assert.equal(authorization.agent_auth.verified_email.claim_uri, "https://reputation.orangecloud.vn/app/");
  assert.deepEqual(jwks.keys, []);
  const authMd = readPublic("auth.md");
  assert.match(authMd, /^# auth\.md\b/m);
  assert.match(authMd, /register/i);
  assert.match(authMd, /\/v1\/auth\/signup/);
});

test("mcp server card, skills index digests, and ARD manifest", () => {
  const card = JSON.parse(readPublic(".well-known/mcp/server-card.json"));
  assert.equal(card.serverInfo.name, "PulseWatch");
  assert.equal(card.serverInfo.version, "0.1.0");
  assert.equal(card.transport.endpoint, "https://reputation.orangecloud.vn/mcp");
  assert.ok(card.capabilities.tools);
  assert.ok(card.capabilities.resources);
  assert.ok(card.capabilities.prompts);

  const index = JSON.parse(readPublic(".well-known/agent-skills/index.json"));
  assert.equal(index.$schema, "https://schemas.agentskills.io/discovery/0.2.0/schema.json");
  assert.ok(index.skills.length >= 1);
  for (const skill of index.skills) {
    assert.match(skill.name, /^[a-z0-9-]+$/);
    assert.equal(skill.type, "skill-md");
    assert.ok(skill.description);
    assert.match(skill.digest, /^sha256:[a-f0-9]{64}$/);
    const relative = skill.url.replace("https://reputation.orangecloud.vn/", "");
    const bytes = readFileSync(new URL(relative, root));
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.equal(skill.digest, `sha256:${digest}`);
  }

  const ard = JSON.parse(readPublic(".well-known/ai-catalog.json"));
  assert.equal(ard.specVersion, "1.0");
  assert.equal(ard.host.displayName, "PulseWatch by OrangeCloud");
  assert.ok(ard.host.identifier);
  assert.ok(ard.entries.length >= 1);
  for (const entry of ard.entries) {
    assert.match(entry.identifier, /^urn:air:reputation\.orangecloud\.vn:/);
    assert.ok(entry.displayName);
    assert.ok(entry.type.includes("/"));
    assert.ok(entry.url);
    assert.equal(entry.data, undefined);
    assert.ok(entry.representativeQueries.length >= 2);
    assert.ok(entry.representativeQueries.length <= 5);
  }
});

test("homepage link header and webmcp registration", () => {
  const html = readPublic("index.html");
  assert.match(html, /rel="api-catalog"/);
  assert.match(html, /toolname="validate_listening_query"/);
  assert.match(html, /tooldescription=/);
  assert.match(html, /toolparamdescription=/);
  assert.match(html, /src="\/webmcp\.js"/);
  const headers = readPublic("_headers");
  assert.match(headers, /rel="api-catalog"/);

  const response = applyDiscoveryHeaders("/", new Response("<html></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" }
  }));
  assert.equal(response.headers.get("link"), DISCOVERY_LINK);
  const catalog = applyDiscoveryHeaders("/.well-known/api-catalog", new Response("{}", { status: 200 }));
  assert.equal(catalog.headers.get("content-type"), "application/linkset+json");
  const manifest = applyDiscoveryHeaders("/.well-known/ai-catalog.json", new Response("{}", { status: 200 }));
  assert.equal(manifest.headers.get("access-control-allow-origin"), "*");

  const calls = [];
  const context = {
    document: {
      modelContext: {
        registerTool(tool, options) {
          calls.push({ name: tool.name, options });
          return Promise.resolve({ name: tool.name });
        }
      }
    },
    navigator: {},
    location: { hostname: "reputation.orangecloud.vn", origin: "https://reputation.orangecloud.vn", port: "", protocol: "https:" },
    fetch: async () => new Response("{}", { status: 200 }),
    AbortController,
    addEventListener() {}
  };
  context.window = context;
  vm.runInNewContext(readPublic("webmcp.js"), context);
  const names = calls.map((call) => call.name).sort();
  assert.deepEqual(names, ["open_pulsewatch_app", "pulsewatch_product_summary", "validate_listening_query"]);
  assert.ok(calls.every((call) => call.options.signal));
});

test("mcp endpoint lists tools and validates a query", async () => {
  assert.equal(apiBaseForHost("reputation.orangecloud.vn", "https://reputation.orangecloud.vn"), "https://reputation.orangecloud.vn/api");
  const init = await handleMcp(new Request("https://reputation.orangecloud.vn/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })
  }));
  assert.equal(init.status, 200);
  assert.match(init.headers.get("content-type") || "", /application\/json/);
  const initBody = await init.json();
  assert.equal(initBody.result.serverInfo.name, "PulseWatch");

  const listed = await handleMcp(new Request("https://reputation.orangecloud.vn/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
  }));
  const tools = (await listed.json()).result.tools.map((tool) => tool.name);
  assert.deepEqual(tools, ["pulsewatch_product_summary", "pulsewatch_validate_query"]);

  const validated = await handleMcp(new Request("https://reputation.orangecloud.vn/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "pulsewatch_validate_query", arguments: { rawQuery: "acme AND outage" } }
    })
  }), async (url, initRequest) => {
    assert.equal(url, "https://reputation.orangecloud.vn/api/v1/queries/validate");
    assert.equal(initRequest?.method, "POST");
    return new Response(JSON.stringify({ valid: true }), { status: 200 });
  });
  const toolBody = await validated.json();
  assert.equal(toolBody.result.isError, false);
  assert.match(toolBody.result.content[0].text, /"valid":true/);
});

test("llms.txt is plain text, pages expose JSON-LD and hreflang, and non-canonical hosts are noindex", () => {
  const llms = readPublic("llms.txt");
  assert.match(llms, /^# PulseWatch\n/);
  assert.match(llms, /https:\/\/orangecloud\.vn\/#person/);
  assert.doesNotMatch(llms, /<!doctype html>/i);
  assert.doesNotMatch(llms, /<html/i);
  assert.doesNotMatch(llms, /Jump back into your workspace/);
  assert.doesNotMatch(llms, /Welcome back\. Continue monitoring/);
  const llmsResponse = applyDiscoveryHeaders("/llms.txt", new Response(llms, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" }
  }), "reputation.orangecloud.vn");
  assert.equal(llmsResponse.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(llmsResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(llmsResponse.headers.get("x-robots-tag"), null);
  assert.equal(CANONICAL_HOST, "reputation.orangecloud.vn");

  const workersDev = applyDiscoveryHeaders("/", new Response("<html></html>", { status: 200 }), "reputa-dashboard-production.sycu-lee.workers.dev");
  assert.equal(workersDev.headers.get("x-robots-tag"), "noindex, nofollow");
  const local = applyDiscoveryHeaders("/vi/", new Response("<html></html>", { status: 200 }), "127.0.0.1");
  assert.equal(local.headers.get("x-robots-tag"), "noindex, nofollow");

  const wrangler = readFileSync(new URL("../apps/dashboard/wrangler.jsonc", import.meta.url), "utf8");
  assert.equal(wrangler.match(/"workers_dev": false/g)?.length, 3);
  assert.match(wrangler, /\/llms\.txt/);

  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /\[https:\/\/reputation\.orangecloud\.vn\]\(https:\/\/reputation\.orangecloud\.vn\)/);

  for (const page of ["index.html", "vi/index.html"]) {
    const html = readPublic(page);
    assert.match(html, /hreflang="en"/);
    assert.match(html, /hreflang="vi"/);
    assert.match(html, /hreflang="x-default"/);
    assert.match(html, /https:\/\/orangecloud\.vn\//);
    assert.match(html, /https:\/\/ready\.orangecloud\.vn\//);
    assert.match(html, /https:\/\/onboarding\.orangecloud\.vn\//);
    assert.match(html, /https:\/\/wcstat\.orangecloud\.vn\//);
    const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(match);
    const graph = JSON.parse(match[1])["@graph"];
    const types = graph.map((node) => node["@type"]);
    assert.ok(types.includes("SoftwareApplication"));
    assert.ok(types.includes("Organization"));
    assert.ok(types.includes("FAQPage"));
    assert.ok(graph.some((node) => node["@id"] === "https://orangecloud.vn/#person"));
    const visible = html.replace(/<script[\s\S]*?<\/script>/gi, "");
    const faq = graph.find((node) => node["@type"] === "FAQPage");
    assert.equal(faq.mainEntity.length, 6);
    const languages = new Set(faq.mainEntity.map((question) => question.inLanguage));
    assert.deepEqual(languages, new Set(["vi", "en"]));
    for (const question of faq.mainEntity) {
      assert.ok(visible.includes(question.name));
      assert.ok(visible.includes(question.acceptedAnswer.text));
    }
  }

  const vi = readPublic("vi/index.html");
  assert.match(vi, /<html lang="vi">/);
  assert.doesNotMatch(vi, /Jump back into your workspace/);
  assert.doesNotMatch(vi, /Welcome back\. Continue monitoring/);
  assert.doesNotMatch(vi, /View profile/);
  const englishFaq = readPublic("index.html").slice(readPublic("index.html").indexOf('id="faq"'));
  assert.doesNotMatch(englishFaq, /Jump back into your workspace/);
  assert.doesNotMatch(englishFaq, /Welcome back\. Continue monitoring/);

  for (const page of ["docs/index.html", "app/index.html"]) {
    const html = readPublic(page);
    assert.match(html, /https:\/\/orangecloud\.vn\//);
    assert.match(html, /https:\/\/ready\.orangecloud\.vn\//);
    assert.match(html, /https:\/\/onboarding\.orangecloud\.vn\//);
    assert.match(html, /https:\/\/wcstat\.orangecloud\.vn\//);
  }
  assert.match(readPublic("sitemap.xml"), /https:\/\/reputation\.orangecloud\.vn\/vi\//);
  assert.match(readPublic("sitemap.xml"), /https:\/\/reputation\.orangecloud\.vn\/llms\.txt/);
  assert.match(readPublic("_headers"), /\/llms\.txt[\s\S]*text\/plain/);
});

test("unauthenticated API responses advertise protected resource metadata", async () => {
  const env = makeLocalEnv();
  const missing = await apiCall(api, env, "GET", "/v1/me");
  assert.equal(missing.status, 401);
  const challenge = missing.headers.get("www-authenticate") || "";
  assert.match(challenge, /resource_metadata="https:\/\/reputation\.orangecloud\.vn\/\.well-known\/oauth-protected-resource"/);
});

test("password grant login returns a bearer session token", async () => {
  const env = makeLocalEnv();
  const email = "agent-discovery@example.com";
  const password = "choose-a-long-passphrase";
  const signup = await apiCall(api, env, "POST", "/v1/auth/signup", {
    email,
    password,
    workspaceName: "Agent Discovery"
  });
  assert.equal(signup.status, 201);
  const created = await signup.json();
  assert.equal(created.access_token, created.session.token);
  assert.equal(created.token_type, "Bearer");

  const form = await api.fetch(new Request("https://api.local/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", username: email, password }).toString()
  }), env);
  assert.equal(form.status, 200);
  const token = await form.json();
  assert.equal(token.token_type, "Bearer");
  assert.ok(token.access_token);

  const me = await api.fetch(new Request("https://api.local/v1/me", {
    headers: { authorization: `Bearer ${token.access_token}` }
  }), env);
  assert.equal(me.status, 200);
});
