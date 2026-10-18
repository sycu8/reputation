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
 * deploy-api-prefix-<unix-ms>@example.com. Optional window:
 *   SMOKE_RUN_START_MS, SMOKE_RUN_END_MS  (GitHub Actions run bounds)
 *   SMOKE_LOOKBACK_MS (default 15000), SMOKE_AHEAD_MS (default 2000)
 * The span is capped at 60s. Each miss creates an empty user Durable Object.
 * The command does not lock the collector.
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
  console.error(message);
  process.exit(1);
}

function requireEmail(value, name) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(`Missing or invalid ${name}.`);
  return email;
}

async function request(apiBase, secret, method, path, body) {
  let response;
  try {
    response = await fetch(`${apiBase}${path}`, {
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
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

async function post(apiBase, secret, path, body) {
  const result = await request(apiBase, secret, "POST", path, body);
  if (result.status < 200 || result.status >= 300) {
    fail(`${path} failed: HTTP ${result.status} ${result.data.error || "error"}`);
  }
  return result.data;
}

async function recoverSmoke(apiBase, secret) {
  const listed = await request(apiBase, secret, "GET", "/v1/admin/tenants");
  if (listed.status !== 200) {
    fail(`/v1/admin/tenants failed: HTTP ${listed.status} ${listed.data.error || "error"}`);
  }
  const tenants = Array.isArray(listed.data.tenants) ? listed.data.tenants : [];
  const plan = smokeRecoveryPlan(tenants, {
    runStartMs: process.env.SMOKE_RUN_START_MS,
    runEndMs: process.env.SMOKE_RUN_END_MS,
    behindMs: process.env.SMOKE_LOOKBACK_MS,
    aheadMs: process.env.SMOKE_AHEAD_MS
  });
  if (plan.length === 0) {
    console.log("recover-smoke: no Deploy Smoke or API Prefix Smoke registry rows in the run window");
    return;
  }
  const status = process.env.ACCOUNT_LOCK_STATUS || "suspended";
  if (status !== "suspended" && status !== "deleted") fail("ACCOUNT_LOCK_STATUS must be suspended or deleted.");
  for (const group of plan) {
    let locked = false;
    for (const email of group.emails) {
      const result = await request(apiBase, secret, "POST", "/v1/admin/accounts/lock", { email, status });
      if (result.status === 404) continue;
      if (result.status === 200) {
        console.log(`locked email=${result.data.email} status=${result.data.status} sessionsRevoked=${result.data.sessionsRevoked}`);
        locked = true;
        break;
      }
      fail(`/v1/admin/accounts/lock failed: HTTP ${result.status} ${result.data.error || "error"}`);
    }
    if (!locked) {
      console.log(`recover-smoke: no account found for ${group.name} createdAt=${group.createdAt} probed=${group.emails.length}`);
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
    await recoverSmoke(apiBase, secret);
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
  main().catch((error) => fail(error instanceof Error ? error.message : "operator_account_failed"));
}
