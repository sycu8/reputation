#!/usr/bin/env node
/**
 * Local QA stack: seeded API on :8787 + static dashboard on :8788.
 * Production-like settings, sanitized fixtures only.
 */
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import api from "../apps/api-worker/src/index.ts";
import { buildSeededEnv, QA_PASSWORD } from "./seed-local-qa.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const DASHBOARD_DIR = join(ROOT, "apps/dashboard/public");
const API_PORT = Number(process.env.QA_API_PORT || 8787);
const WEB_PORT = Number(process.env.QA_WEB_PORT || 8788);
const MENTIONS = Number(process.env.QA_MENTIONS_PER_MONITOR || 40);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json"
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, headers);
  res.end(payload);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

async function main() {
  console.log(`Seeding local QA world (mentions/monitor=${MENTIONS})…`);
  const world = await buildSeededEnv({
    mentionsPerMonitor: MENTIONS,
    envOverrides: {
      ALLOWED_ORIGINS: `http://127.0.0.1:${WEB_PORT},http://localhost:${WEB_PORT},http://127.0.0.1:${API_PORT},http://localhost:${API_PORT}`,
      ENVIRONMENT: "local-qa"
    }
  });
  const { env } = world;
  console.log("Seed stats:", world.stats);

  const apiServer = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || `127.0.0.1:${API_PORT}`;
      const url = new URL(req.url || "/", `http://${host}`);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bodyBuf = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value == null) continue;
        if (Array.isArray(value)) for (const item of value) headers.append(key, item);
        else headers.set(key, value);
      }
      if (!headers.has("origin") && req.headers.referer) {
        try { headers.set("origin", new URL(String(req.headers.referer)).origin); } catch { /* ignore */ }
      }
      const method = req.method || "GET";
      const request = new Request(url, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : bodyBuf
      });
      const response = await api.fetch(request, env);
      const responseHeaders = {};
      response.headers.forEach((value, key) => {
        // Node requires set-cookie carefully; flatten for local QA
        if (key.toLowerCase() === "set-cookie") {
          responseHeaders["set-cookie"] = value;
        } else {
          responseHeaders[key] = value;
        }
      });
      const buf = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, responseHeaders);
      res.end(buf);
    } catch (error) {
      send(res, 500, { error: "local_api_crash", message: error instanceof Error ? error.message : String(error) }, { "content-type": "application/json" });
    }
  });

  const webServer = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", `http://127.0.0.1:${WEB_PORT}`);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === "/") pathname = "/index.html";
      if (pathname === "/app" || pathname === "/app/") pathname = "/app/index.html";
      const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
      const filePath = join(DASHBOARD_DIR, safe);
      if (!filePath.startsWith(DASHBOARD_DIR) || !existsSync(filePath)) {
        // Directory index or SPA/marketing fallback
        const asDirIndex = join(DASHBOARD_DIR, safe, "index.html");
        if (existsSync(asDirIndex) && asDirIndex.startsWith(DASHBOARD_DIR)) {
          const index = readFileSync(asDirIndex);
          return send(res, 200, index, { "content-type": "text/html; charset=utf-8" });
        }
        const index = readFileSync(join(DASHBOARD_DIR, "index.html"));
        return send(res, 200, index, { "content-type": "text/html; charset=utf-8" });
      }
      const data = readFileSync(filePath);
      send(res, 200, data, { "content-type": TYPES[extname(filePath)] || "application/octet-stream" });
    } catch (error) {
      send(res, 500, String(error), { "content-type": "text/plain" });
    }
  });

  await new Promise((resolvePromise) => apiServer.listen(API_PORT, "127.0.0.1", resolvePromise));
  await new Promise((resolvePromise) => webServer.listen(WEB_PORT, "127.0.0.1", resolvePromise));

  const manifest = {
    api: `http://127.0.0.1:${API_PORT}`,
    dashboard: `http://127.0.0.1:${WEB_PORT}`,
    password: QA_PASSWORD,
    accounts: {
      owner: world.accounts.owner.email,
      viewer: world.accounts.viewer.email,
      competitor: world.accounts.competitor.email,
      ops: world.accounts.ops.email
    },
    workspaceId: world.accounts.owner.workspaceId,
    monitors: world.monitors,
    stats: world.stats,
    note: "Set dashboard Settings → API base URL to the api URL above before login."
  };
  console.log(JSON.stringify(manifest, null, 2));
  console.log(`\nLocal QA ready.\n  Dashboard: ${manifest.dashboard}\n  API:       ${manifest.api}\n  Owner:     ${manifest.accounts.owner} / ${QA_PASSWORD}`);

  // Keep process alive
  process.on("SIGINT", () => {
    apiServer.close();
    webServer.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
