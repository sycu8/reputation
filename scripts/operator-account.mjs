#!/usr/bin/env node
/**
 * Reset a password, lock an account, or recover deploy smoke accounts.
 *
 * Required env:
 *   OPERATOR_ACCOUNT_SECRET
 *   TARGET_EMAIL            (reset-password, or a single lock)
 *
 * Reset also requires ACCOUNT_NEW_PASSWORD.
 * Lock accepts TARGET_EMAIL or comma-separated TARGET_EMAILS.
 * Optional: API_BASE, ACCOUNT_LOCK_STATUS=suspended|deleted
 *
 * recover-smoke reads GET /v1/admin/tenants and locks the first existing
 * address for each "Deploy Smoke" / "API Prefix Smoke" row. Signup bodies
 * were never logged. The email is deploy-smoke-<unix-ms>@example.com or
 * deploy-api-prefix-<unix-ms>@example.com. Required window, both finite
 * unix milliseconds with start <= end:
 *   SMOKE_RUN_START_MS, SMOKE_RUN_END_MS  (GitHub Actions run bounds)
 * The command exits before any request when either bound is missing or invalid.
 * Optional: SMOKE_LOOKBACK_MS (default 15000), SMOKE_AHEAD_MS (default 2000).
 * The probe span is capped at 60s. Each miss creates an empty user Durable Object.
 * After listing tenants it prints the planned lock-request count and sends nothing
 * until RECOVER_SMOKE_CONFIRM=yes. The command does not lock the collector.
 * A 429 response includes Retry-After. The script waits that long (at most 60s)
 * and retries up to 3 times. It does not print the operator secret.
 * Generate OPERATOR_ACCOUNT_SECRET with: openssl rand -base64 32
 *
 * The new password and the operator secret are read from the environment
 * only and are never printed.
 *
 *   node scripts/operator-account.mjs reset-password
 *   node scripts/operator-account.mjs lock
 *   node scripts/operator-account.mjs recover-smoke
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SMOKE_NAMES = {
  "Deploy Smoke": "deploy-smoke-",
  "API Prefix Smoke": "deploy-api-prefix-"
};

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function boundError(name, detail) {
  return new Error(`${detail} ${name}. recover-smoke refuses to run without a valid GitHub Actions window (unix milliseconds, start <= end).`);
}

/** Both bounds are required. Missing or non-finite values throw before any network call. */
export function requireSmokeWindow(env) {
  const start = parseWindowBound(env?.SMOKE_RUN_START_MS, "SMOKE_RUN_START_MS");
  const end = parseWindowBound(env?.SMOKE_RUN_END_MS, "SMOKE_RUN_END_MS");
  if (start > end) {
    throw new Error("SMOKE_RUN_START_MS is after SMOKE_RUN_END_MS. recover-smoke refuses to run.");
  }
  return { start, end };
}

function parseWindowBound(value, name) {
  if (value == null || String(value).trim() === "") throw boundError(name, "Missing");
  const number = Number(value);
  if (!Number.isFinite(number)) throw boundError(name, "Invalid");
  return number;
}

/** Candidates around registry createdAt. Newest first. Stops are applied by the caller. */
export function smokeRecoveryPlan(tenants, options = {}) {
  const behindMs = Math.max(0, finiteOr(options.behindMs, 15_000));
  const aheadMs = Math.max(0, finiteOr(options.aheadMs, 2_000));
  const maxSpanMs = Math.max(1, finiteOr(options.maxSpanMs, 60_000));
  const runStartMs = options.runStartMs == null ? null : finiteOr(options.runStartMs, NaN);
  const runEndMs = options.runEndMs == null ? null : finiteOr(options.runEndMs, NaN);
  const plans = [];
  for (const tenant of tenants ?? []) {
    const prefix = SMOKE_NAMES[tenant?.name];
    if (!prefix) continue;
    const created = Date.parse(tenant.createdAt);
    if (!Number.isFinite(created)) continue;
    if (runStartMs != null && created < runStartMs) continue;
    if (runEndMs != null && created > runEndMs) continue;
    let start = created - behindMs;
    const end = created + aheadMs;
    if (end - start > maxSpanMs) start = end - maxSpanMs;
    const emails = [];
    for (let ms = end; ms >= start; ms -= 1) emails.push(`${prefix}${ms}@example.com`);
    plans.push({
      name: tenant.name,
      createdAt: tenant.createdAt,
      prefix,
      emails
    });
  }
  return plans;
}

function fail(message) {
  throw new Error(message);
}

const MAX_OPERATOR_RETRIES = 3;

/** Seconds from Retry-After, capped at 60s. Missing or invalid values wait 1s. */
export function retryDelayMs(header) {
  if (header == null || String(header).trim() === "") return 1000;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return 1000;
  return Math.min(Math.ceil(seconds * 1000), 60_000);
}

function defaultSleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function operatorRequest(apiBase, secret, method, path, body, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? ((line) => console.log(line));
  let response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetchImpl(`${apiBase}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-operator-secret": secret
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      fail(`${path} failed: ${error instanceof Error ? error.message : "network_error"}`);
    }
    if (response.status === 429 && attempt < MAX_OPERATOR_RETRIES) {
      const delay = retryDelayMs(response.headers.get("retry-after"));
      log(`operator-account: waiting ${delay}ms after HTTP 429`);
      await response.arrayBuffer().catch(() => {});
      await sleep(delay);
      continue;
    }
    break;
  }
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

function requireEmail(value, name) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(`Missing or invalid ${name}.`);
  return email;
}

async function post(apiBase, secret, path, body) {
  const result = await operatorRequest(apiBase, secret, "POST", path, body);
  if (result.status < 200 || result.status >= 300) {
    fail(`${path} failed: HTTP ${result.status} ${result.data.error || "error"}`);
  }
  return result.data;
}

export async function recoverSmoke({ apiBase, secret, windowBounds, env = process.env, fetchImpl, sleep, log = console.log }) {
  const deps = { fetchImpl, sleep, log };
  const listed = await operatorRequest(apiBase, secret, "GET", "/v1/admin/tenants", undefined, deps);
  if (listed.status !== 200) {
    fail(`/v1/admin/tenants failed: HTTP ${listed.status} ${listed.data.error || "error"}`);
  }
  const tenants = Array.isArray(listed.data.tenants) ? listed.data.tenants : [];
  const plan = smokeRecoveryPlan(tenants, {
    runStartMs: windowBounds.start,
    runEndMs: windowBounds.end,
    behindMs: env.SMOKE_LOOKBACK_MS,
    aheadMs: env.SMOKE_AHEAD_MS
  });
  const planned = plan.reduce((sum, group) => sum + group.emails.length, 0);
  log(`recover-smoke: planned lock requests=${planned} registryRows=${plan.length}`);
  if (planned === 0) {
    log("recover-smoke: no Deploy Smoke or API Prefix Smoke registry rows in the run window");
    return;
  }
  if (String(env.RECOVER_SMOKE_CONFIRM ?? "").trim() !== "yes") {
    fail(`Set RECOVER_SMOKE_CONFIRM=yes to send ${planned} lock requests. Nothing was locked.`);
  }
  const status = env.ACCOUNT_LOCK_STATUS || "suspended";
  if (status !== "suspended" && status !== "deleted") fail("ACCOUNT_LOCK_STATUS must be suspended or deleted.");
  for (const group of plan) {
    let locked = false;
    for (const email of group.emails) {
      const result = await operatorRequest(apiBase, secret, "POST", "/v1/admin/accounts/lock", { email, status }, deps);
      if (result.status === 404) continue;
      if (result.status === 200) {
        log(`locked email=${result.data.email} status=${result.data.status} sessionsRevoked=${result.data.sessionsRevoked}`);
        locked = true;
        break;
      }
      fail(`/v1/admin/accounts/lock failed: HTTP ${result.status} ${result.data.error || "error"}`);
    }
    if (!locked) {
      log(`recover-smoke: no account found for ${group.name} createdAt=${group.createdAt} probed=${group.emails.length}`);
    }
  }
}

async function main() {
  const apiBase = (process.env.API_BASE || "https://reputa-api-production.sycu-lee.workers.dev").replace(/\/$/, "");
  const secret = String(process.env.OPERATOR_ACCOUNT_SECRET ?? "").trim();
  const command = process.argv[2];
  if (!secret) {
    fail("Missing OPERATOR_ACCOUNT_SECRET. Account reset and lock fail closed until it is set. The value is not stored in the repo.");
  }
  if (command !== "reset-password" && command !== "lock" && command !== "recover-smoke") {
    fail("Usage: node scripts/operator-account.mjs <reset-password|lock|recover-smoke>");
  }
  if (command === "recover-smoke") {
    let windowBounds;
    try {
      windowBounds = requireSmokeWindow(process.env);
    } catch (error) {
      fail(error instanceof Error ? error.message : "invalid_smoke_window");
    }
    await recoverSmoke({ apiBase, secret, windowBounds });
    return;
  }
  if (command === "reset-password") {
    const email = requireEmail(process.env.TARGET_EMAIL, "TARGET_EMAIL");
    const password = String(process.env.ACCOUNT_NEW_PASSWORD ?? "");
    if (!password) fail("Missing ACCOUNT_NEW_PASSWORD. Export the new password in the environment. It is not stored in the repo.");
    const result = await post(apiBase, secret, "/v1/admin/accounts/reset-password", { email, password });
    console.log(`password reset ok email=${result.email} status=${result.status} sessionsRevoked=${result.sessionsRevoked}`);
    return;
  }
  const raw = process.env.TARGET_EMAILS || process.env.TARGET_EMAIL || "";
  const emails = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (emails.length === 0) fail("Missing TARGET_EMAIL or TARGET_EMAILS.");
  const status = process.env.ACCOUNT_LOCK_STATUS || "suspended";
  if (status !== "suspended" && status !== "deleted") fail("ACCOUNT_LOCK_STATUS must be suspended or deleted.");
  for (const email of emails.map((value) => requireEmail(value, "TARGET_EMAIL"))) {
    const result = await post(apiBase, secret, "/v1/admin/accounts/lock", { email, status });
    console.log(`locked email=${result.email} status=${result.status} sessionsRevoked=${result.sessionsRevoked}`);
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "operator_account_failed");
    process.exit(1);
  });
}
