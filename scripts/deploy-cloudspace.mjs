#!/usr/bin/env node
/**
 * Provision + deploy Reputation Orangecloud to Cloudflare account Cloudspace.
 *
 * Required env:
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_ACCOUNT_ID=4c15704ef706b9c8954cd6f9feb678d8
 *
 * Optional:
 *   DEPLOY_ENV=production|staging|dev  (default production)
 *   SKIP_ROUTES=1                      (skip DNS/route changes)
 *   SUPER_ADMIN_EMAILS=a@b.com
 *   BRAVE_SEARCH_API_KEY=...
 *   TELEGRAM_BOT_TOKEN=...
 *   BILLING_WEBHOOK_SECRET=...
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "4c15704ef706b9c8954cd6f9feb678d8";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const DEPLOY_ENV = process.env.DEPLOY_ENV || "production";
const SUFFIX = DEPLOY_ENV === "production" ? "production" : DEPLOY_ENV === "staging" ? "staging" : "dev";
const STATE_SCRIPT = `reputa-state-${SUFFIX === "dev" ? "dev" : SUFFIX}`;
const HOSTNAME = "reputation.orangecloud.vn";
const ZONE_NAME = "orangecloud.vn";
const RESOURCES_PATH = resolve(ROOT, `.deploy/resources-${SUFFIX}.json`);

function die(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: TOKEN,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID
    },
    ...opts
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0 && !opts.allowFail) {
    die(`${cmd} ${args.join(" ")} failed with exit ${result.status}`);
  }
  return result;
}

async function cf(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...(init.headers || {})
    }
  });
  const body = await response.json();
  if (!body.success) {
    const msg = (body.errors || []).map((e) => e.message).join("; ") || `HTTP ${response.status}`;
    throw new Error(`Cloudflare API ${path}: ${msg}`);
  }
  return body.result;
}

function wranglerEnvArgs() {
  if (SUFFIX === "dev") return [];
  return ["--env", SUFFIX];
}

async function ensureKv(title) {
  const list = await cf(`/accounts/${ACCOUNT_ID}/storage/kv/namespaces?per_page=1000`);
  const existing = (list || []).find((item) => item.title === title);
  if (existing) {
    console.log(`KV reuse: ${title} -> ${existing.id}`);
    return existing.id;
  }
  const created = await cf(`/accounts/${ACCOUNT_ID}/storage/kv/namespaces`, {
    method: "POST",
    body: JSON.stringify({ title })
  });
  console.log(`KV create: ${title} -> ${created.id}`);
  return created.id;
}

async function ensureR2(name) {
  try {
    await cf(`/accounts/${ACCOUNT_ID}/r2/buckets/${name}`);
    console.log(`R2 reuse: ${name}`);
    return name;
  } catch {
    await cf(`/accounts/${ACCOUNT_ID}/r2/buckets`, {
      method: "POST",
      body: JSON.stringify({ name })
    });
    console.log(`R2 create: ${name}`);
    return name;
  }
}

async function ensureQueue(name) {
  const list = await cf(`/accounts/${ACCOUNT_ID}/queues`);
  const existing = (list || []).find((item) => item.queue_name === name || item.name === name);
  if (existing) {
    console.log(`Queue reuse: ${name}`);
    return name;
  }
  await cf(`/accounts/${ACCOUNT_ID}/queues`, {
    method: "POST",
    body: JSON.stringify({ queue_name: name })
  });
  console.log(`Queue create: ${name}`);
  return name;
}

function patchKvIds(resources) {
  const replacements = [
    // production placeholders
    ["00000000000000000000000000000021", resources.kv.config],
    ["00000000000000000000000000000011", resources.kv.config], // staging reuse path if deploying staging with same file set carefully
    ["00000000000000000000000000000001", resources.kv.config],
    ["00000000000000000000000000000002", resources.kv.crawlCache],
    ["00000000000000000000000000000003", resources.kv.notify]
  ];

  const files = [
    "apps/api-worker/wrangler.jsonc",
    "workers/scheduler/wrangler.jsonc",
    "workers/crawler-fetch/wrangler.jsonc",
    "workers/crawler-browser/wrangler.jsonc",
    "workers/alerts/wrangler.jsonc"
  ];

  for (const rel of files) {
    const path = resolve(ROOT, rel);
    let text = readFileSync(path, "utf8");
    const before = text;
    for (const [from, to] of replacements) {
      if (!to) continue;
      text = text.split(from).join(to);
    }
    if (text !== before) {
      writeFileSync(path, text);
      console.log(`Patched KV IDs in ${rel}`);
    }
  }
}

async function verifyZone() {
  const zones = await cf(`/zones?name=${encodeURIComponent(ZONE_NAME)}`);
  const zone = (zones || [])[0];
  if (!zone) {
    console.warn(`Zone ${ZONE_NAME} not found in this account. Skipping routes.`);
    return null;
  }
  if (zone.account?.id && zone.account.id !== ACCOUNT_ID) {
    die(`Zone ${ZONE_NAME} belongs to account ${zone.account.id}, not Cloudspace ${ACCOUNT_ID}. Stopping route step only.`);
  }
  console.log(`Zone OK: ${ZONE_NAME} (${zone.id}) in Cloudspace`);
  return zone;
}

async function putSecret(configPath, name, value) {
  if (!value) return;
  console.log(`Setting secret ${name} for ${configPath}`);
  const args = ["wrangler", "secret", "put", name, "--config", configPath, ...wranglerEnvArgs()];
  const result = spawnSync("npx", args, {
    cwd: ROOT,
    encoding: "utf8",
    input: value,
    env: { ...process.env, CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID }
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) die(`secret put ${name} failed`);
}

async function main() {
  if (!TOKEN) {
    die(
      "CLOUDFLARE_API_TOKEN is missing. Create an API token for Cloudspace with Workers/KV/R2/Queues/DO/AI/Browser/DNS permissions, then re-run:\n\n  export CLOUDFLARE_API_TOKEN='...'\n  export CLOUDFLARE_ACCOUNT_ID='4c15704ef706b9c8954cd6f9feb678d8'\n  npm run deploy:cloudspace"
    );
  }

  console.log(`Deploy target: Cloudspace ${ACCOUNT_ID}, env=${SUFFIX}`);
  run("npx", ["wrangler", "whoami"]);

  const tokenStatus = await cf(`/accounts/${ACCOUNT_ID}`);
  console.log(`Account: ${tokenStatus.name || ACCOUNT_ID}`);

  mkdirSync(resolve(ROOT, ".deploy"), { recursive: true });

  const resources = existsSync(RESOURCES_PATH)
    ? JSON.parse(readFileSync(RESOURCES_PATH, "utf8"))
    : { kv: {}, r2: {}, queues: [] };

  resources.kv.config = resources.kv.config || await ensureKv(`reputa-config-${SUFFIX}`);
  resources.kv.crawlCache = resources.kv.crawlCache || await ensureKv(`reputa-crawl-cache-${SUFFIX}`);
  resources.kv.notify = resources.kv.notify || await ensureKv(`reputa-notify-${SUFFIX}`);
  resources.r2.raw = await ensureR2(`reputa-raw-content-${SUFFIX === "dev" ? "dev" : SUFFIX}`);
  resources.r2.reports = await ensureR2(`reputa-reports-${SUFFIX === "dev" ? "dev" : SUFFIX}`);

  const queueNames = [
    `reputa-discovery-normal-${SUFFIX === "dev" ? "dev" : SUFFIX}`,
    `reputa-discovery-priority-${SUFFIX === "dev" ? "dev" : SUFFIX}`,
    `reputa-discovery-dlq-${SUFFIX === "dev" ? "dev" : SUFFIX}`,
    `reputa-crawl-static-${SUFFIX === "dev" ? "dev" : SUFFIX}`,
    `reputa-crawl-browser-${SUFFIX === "dev" ? "dev" : SUFFIX}`,
    `reputa-crawl-dlq-${SUFFIX === "dev" ? "dev" : SUFFIX}`,
    `reputa-process-content-${SUFFIX === "dev" ? "dev" : SUFFIX}`,
    `reputa-process-dlq-${SUFFIX === "dev" ? "dev" : SUFFIX}`,
    `reputa-ai-normal-${SUFFIX === "dev" ? "dev" : SUFFIX}`,
    `reputa-ai-priority-${SUFFIX === "dev" ? "dev" : SUFFIX}`,
    `reputa-ai-dlq-${SUFFIX === "dev" ? "dev" : SUFFIX}`,
    `reputa-alerts-${SUFFIX === "dev" ? "dev" : SUFFIX}`,
    `reputa-alerts-dlq-${SUFFIX === "dev" ? "dev" : SUFFIX}`,
    `reputa-reports-${SUFFIX === "dev" ? "dev" : SUFFIX}`,
    `reputa-reports-dlq-${SUFFIX === "dev" ? "dev" : SUFFIX}`
  ];
  for (const name of queueNames) await ensureQueue(name);
  resources.queues = queueNames;
  writeFileSync(RESOURCES_PATH, JSON.stringify(resources, null, 2));
  patchKvIds(resources);

  const restoreConfigs = () => {
    run("git", ["checkout", "--",
      "apps/api-worker/wrangler.jsonc",
      "workers/scheduler/wrangler.jsonc",
      "workers/crawler-fetch/wrangler.jsonc",
      "workers/crawler-browser/wrangler.jsonc",
      "workers/alerts/wrangler.jsonc"
    ], { allowFail: true });
  };

  try {
  // Deploy order per docs/DEPLOYMENT_CLOUDSPACE.md
  const workers = [
    ["workers/state/wrangler.jsonc", true],
    ["workers/scheduler/wrangler.jsonc", true],
    ["workers/discovery/wrangler.jsonc", true],
    ["workers/crawler-fetch/wrangler.jsonc", true],
    ["workers/crawler-browser/wrangler.jsonc", true],
    ["workers/processor/wrangler.jsonc", true],
    ["workers/ai-classifier/wrangler.jsonc", true],
    ["workers/alerts/wrangler.jsonc", true],
    ["workers/reports/wrangler.jsonc", true],
    ["apps/api-worker/wrangler.jsonc", true],
    ["apps/dashboard/wrangler.jsonc", true]
  ];

  for (const [config] of workers) {
    run("npx", ["wrangler", "deploy", "--config", config, ...wranglerEnvArgs()]);
  }

  await putSecret("apps/api-worker/wrangler.jsonc", "SUPER_ADMIN_EMAILS", process.env.SUPER_ADMIN_EMAILS);
  await putSecret("apps/api-worker/wrangler.jsonc", "BILLING_WEBHOOK_SECRET", process.env.BILLING_WEBHOOK_SECRET);
  await putSecret("workers/discovery/wrangler.jsonc", "BRAVE_SEARCH_API_KEY", process.env.BRAVE_SEARCH_API_KEY);
  await putSecret("workers/alerts/wrangler.jsonc", "TELEGRAM_BOT_TOKEN", process.env.TELEGRAM_BOT_TOKEN);

  const zone = process.env.SKIP_ROUTES === "1" ? null : await verifyZone();
  if (zone && SUFFIX === "production") {
    // Ensure proxied DNS for the custom hostname so Workers routes can serve traffic.
    // Token may lack Zone DNS write — warn and continue so Workers deploy still succeeds.
    try {
      const dnsName = HOSTNAME;
      const dnsList = await cf(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(dnsName)}&per_page=100`);
      const existingDns = (dnsList || []).find((item) => item.name === dnsName || item.name === `${dnsName}.`);
      if (!existingDns) {
        await cf(`/zones/${zone.id}/dns_records`, {
          method: "POST",
          body: JSON.stringify({
            type: "AAAA",
            name: "reputation",
            content: "100::",
            proxied: true,
            ttl: 1,
            comment: "PulseWatch workers route placeholder"
          })
        });
        console.log(`DNS created: ${dnsName} AAAA 100:: (proxied)`);
      } else if (!existingDns.proxied) {
        await cf(`/zones/${zone.id}/dns_records/${existingDns.id}`, {
          method: "PATCH",
          body: JSON.stringify({ proxied: true })
        });
        console.log(`DNS proxied enabled: ${dnsName} (${existingDns.type})`);
      } else {
        console.log(`DNS reuse: ${dnsName} ${existingDns.type} ${existingDns.content} (proxied)`);
      }
    } catch (error) {
      console.warn(`DNS step skipped (add Zone.DNS edit to the API token, or create proxied AAAA 100:: for ${HOSTNAME} manually): ${error instanceof Error ? error.message : error}`);
    }

    // Prefer Workers routes on the zone hostname
    try {
      const routes = [
        { pattern: `${HOSTNAME}/api/*`, script: "reputa-api-production" },
        { pattern: `${HOSTNAME}/*`, script: "reputa-dashboard-production" }
      ];
      for (const route of routes) {
        const existing = await cf(`/zones/${zone.id}/workers/routes`);
        const found = (existing || []).find((item) => item.pattern === route.pattern);
        if (found) {
          await cf(`/zones/${zone.id}/workers/routes/${found.id}`, {
            method: "PUT",
            body: JSON.stringify({ pattern: route.pattern, script: route.script })
          });
          console.log(`Route updated: ${route.pattern} -> ${route.script}`);
        } else {
          await cf(`/zones/${zone.id}/workers/routes`, {
            method: "POST",
            body: JSON.stringify({ pattern: route.pattern, script: route.script })
          });
          console.log(`Route created: ${route.pattern} -> ${route.script}`);
        }
      }
    } catch (error) {
      console.warn(`Workers route step skipped: ${error instanceof Error ? error.message : error}`);
    }
  }

  // Smoke tests — resolve workers.dev subdomain for this account
  let workersSubdomain = "sycu-lee";
  try {
    const sub = await cf(`/accounts/${ACCOUNT_ID}/workers/subdomain`);
    if (sub?.subdomain) workersSubdomain = sub.subdomain;
  } catch {
    console.warn("Could not resolve workers subdomain; using fallback sycu-lee");
  }
  const workersHost = `reputa-api-${SUFFIX === "dev" ? "dev" : SUFFIX}.${workersSubdomain}.workers.dev`;

  const apiCandidates = SUFFIX === "production"
    ? [`https://${workersHost}/health`, `https://${HOSTNAME}/api/health`]
    : [`https://${workersHost}/health`];

  for (const url of apiCandidates) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      const text = await response.text();
      console.log(`Smoke ${url} -> ${response.status} ${text.slice(0, 200)}`);
    } catch (error) {
      console.warn(`Smoke failed ${url}: ${error instanceof Error ? error.message : error}`);
    }
  }

  console.log("\nDeploy finished. Resource inventory:", RESOURCES_PATH);
  } finally {
    restoreConfigs();
  }
}

main().catch((error) => die(error instanceof Error ? error.message : String(error)));
