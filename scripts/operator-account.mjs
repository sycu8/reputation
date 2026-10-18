#!/usr/bin/env node
/**
 * Reset a password or lock an account on a deployed API.
 *
 * Required env:
 *   OPERATOR_ACCOUNT_SECRET
 *   TARGET_EMAIL            (reset-password, or a single lock)
 *
 * Reset also requires ACCOUNT_NEW_PASSWORD.
 * Lock accepts TARGET_EMAIL or comma-separated TARGET_EMAILS.
 * Optional: API_BASE, ACCOUNT_LOCK_STATUS=suspended|deleted
 *
 * The new password is read from the environment only and is never printed.
 *
 *   node scripts/operator-account.mjs reset-password
 *   node scripts/operator-account.mjs lock
 */
const API_BASE = (process.env.API_BASE || "https://reputa-api-production.sycu-lee.workers.dev").replace(/\/$/, "");
const SECRET = process.env.OPERATOR_ACCOUNT_SECRET ?? "";
const command = process.argv[2];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function requireEmail(value, name) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(`Missing or invalid ${name}.`);
  return email;
}

if (!String(SECRET).trim()) {
  fail("Missing OPERATOR_ACCOUNT_SECRET. Account reset and lock fail closed until it is set. The value is not stored in the repo.");
}
if (command !== "reset-password" && command !== "lock") {
  fail("Usage: node scripts/operator-account.mjs <reset-password|lock>");
}

async function post(path, body) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-operator-secret": SECRET
      },
      body: JSON.stringify(body)
    });
  } catch (error) {
    fail(`${path} failed: ${error instanceof Error ? error.message : "network_error"}`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    fail(`${path} failed: HTTP ${response.status} ${data.error || "error"}`);
  }
  return data;
}

async function main() {
  if (command === "reset-password") {
    const email = requireEmail(process.env.TARGET_EMAIL, "TARGET_EMAIL");
    const password = String(process.env.ACCOUNT_NEW_PASSWORD ?? "");
    if (!password) fail("Missing ACCOUNT_NEW_PASSWORD. Export the new password in the environment. It is not stored in the repo.");
    const result = await post("/v1/admin/accounts/reset-password", { email, password });
    console.log(`password reset ok email=${result.email} status=${result.status} sessionsRevoked=${result.sessionsRevoked}`);
    return;
  }
  const raw = process.env.TARGET_EMAILS || process.env.TARGET_EMAIL || "";
  const emails = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (emails.length === 0) fail("Missing TARGET_EMAIL or TARGET_EMAILS.");
  const status = process.env.ACCOUNT_LOCK_STATUS || "suspended";
  if (status !== "suspended" && status !== "deleted") fail("ACCOUNT_LOCK_STATUS must be suspended or deleted.");
  for (const email of emails.map((value) => requireEmail(value, "TARGET_EMAIL"))) {
    const result = await post("/v1/admin/accounts/lock", { email, status });
    console.log(`locked email=${result.email} status=${result.status} sessionsRevoked=${result.sessionsRevoked}`);
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : "operator_account_failed"));
