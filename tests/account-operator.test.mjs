import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import api from "../apps/api-worker/src/index.ts";
import { requireSmokeWindow, smokeRecoveryPlan } from "../scripts/operator-account.mjs";
import { cookieFrom, makeLocalEnv } from "./helpers/local-env.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const OLD_PASSWORD = "correct-horse-battery";
const NEW_PASSWORD = "replacement-horse-battery";
const OPERATOR_SECRET = "operator-test-secret";

function call(env, method, path, body, options = {}) {
  const headers = { origin: "http://127.0.0.1:8788" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (options.cookie) headers.cookie = options.cookie;
  if (options.operatorSecret !== undefined) headers["x-operator-secret"] = options.operatorSecret;
  if (options.ray) headers["cf-ray"] = options.ray;
  if (options.ip) headers["cf-connecting-ip"] = options.ip;
  return api.fetch(new Request(`https://api.local${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env);
}

async function signup(env, email) {
  const response = await call(env, "POST", "/v1/auth/signup", {
    email,
    password: OLD_PASSWORD,
    workspaceName: "Operator Test"
  });
  assert.equal(response.status, 201);
  return { cookie: cookieFrom(response), body: await response.json() };
}

test("account reset and lock fail closed without a super-admin session or operator secret", async () => {
  const env = makeLocalEnv();
  const missing = await call(env, "POST", "/v1/admin/accounts/reset-password", {
    email: "person@example.com",
    password: NEW_PASSWORD
  });
  assert.equal(missing.status, 401);

  const unconfigured = await call(env, "POST", "/v1/admin/accounts/lock", {
    email: "person@example.com"
  }, { operatorSecret: OPERATOR_SECRET });
  assert.equal(unconfigured.status, 503);
  assert.equal((await unconfigured.json()).error, "operator_secret_not_configured");

  const wrong = await call(env, "POST", "/v1/admin/accounts/lock", {
    email: "person@example.com"
  }, { operatorSecret: "wrong-secret" });
  env.OPERATOR_ACCOUNT_SECRET = OPERATOR_SECRET;
  const rejected = await call(env, "POST", "/v1/admin/accounts/lock", {
    email: "person@example.com"
  }, { operatorSecret: "wrong-secret" });
  assert.equal(rejected.status, 401);
  assert.equal((await rejected.json()).error, "invalid_operator_secret");
  assert.equal(wrong.status, 503);
});

test("operator secret resets the password hash and revokes every session", async () => {
  const env = makeLocalEnv({
    SUPER_ADMIN_EMAILS: "collector@example.com",
    OPERATOR_ACCOUNT_SECRET: OPERATOR_SECRET
  });
  const account = await signup(env, "collector@example.com");
  assert.equal(account.body.user.globalRole, "super_admin");
  const second = await call(env, "POST", "/v1/auth/login", {
    email: "collector@example.com",
    password: OLD_PASSWORD
  });
  assert.equal(second.status, 200);
  const secondCookie = cookieFrom(second);

  const asSession = await call(env, "POST", "/v1/admin/accounts/reset-password", {
    email: "collector@example.com",
    password: NEW_PASSWORD
  }, { cookie: account.cookie });
  assert.equal(asSession.status, 403);
  assert.equal((await asSession.json()).error, "operator_secret_required");

  const wrongSecret = await call(env, "POST", "/v1/admin/accounts/reset-password", {
    email: "collector@example.com",
    password: NEW_PASSWORD
  }, { operatorSecret: "nope", cookie: account.cookie });
  assert.equal(wrongSecret.status, 401);

  const reset = await call(env, "POST", "/v1/admin/accounts/reset-password", {
    email: "collector@example.com",
    password: NEW_PASSWORD
  }, { operatorSecret: OPERATOR_SECRET, cookie: account.cookie, ray: "qa-ray-reset" });
  assert.equal(reset.status, 200);
  const body = await reset.json();
  assert.equal(body.email, "collector@example.com");
  assert.equal(body.sessionsRevoked, 2);
  assert.equal(JSON.stringify(body).includes(NEW_PASSWORD), false);
  assert.equal(JSON.stringify(body).includes(OLD_PASSWORD), false);

  const oldSession = await call(env, "GET", "/v1/me", undefined, { cookie: account.cookie });
  const otherSession = await call(env, "GET", "/v1/me", undefined, { cookie: secondCookie });
  assert.equal(oldSession.status, 401);
  assert.equal(otherSession.status, 401);

  const oldPassword = await call(env, "POST", "/v1/auth/login", {
    email: "collector@example.com",
    password: OLD_PASSWORD
  });
  assert.equal(oldPassword.status, 401);
  const newPassword = await call(env, "POST", "/v1/auth/login", {
    email: "collector@example.com",
    password: NEW_PASSWORD
  });
  assert.equal(newPassword.status, 200);

  const audit = await call(env, "GET", "/v1/admin/accounts/audit?email=collector@example.com", undefined, {
    operatorSecret: OPERATOR_SECRET
  });
  assert.equal(audit.status, 200);
  const events = (await audit.json()).events;
  const resetEvent = events.find((event) => event.action === "account.password_reset");
  assert.ok(resetEvent);
  assert.equal(resetEvent.actorUserId, "operator_secret:qa-ray-reset");
  assert.equal(resetEvent.metadata.sessionsRevoked, 2);
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes(NEW_PASSWORD), false);
  assert.equal(serialized.includes(OLD_PASSWORD), false);
  assert.equal(serialized.includes("password_hash"), false);
});

test("lock requires the operator secret for every account", async () => {
  const env = makeLocalEnv({
    SUPER_ADMIN_EMAILS: "ops@example.com",
    OPERATOR_ACCOUNT_SECRET: OPERATOR_SECRET
  });
  const ops = await signup(env, "ops@example.com");
  assert.equal(ops.body.user.globalRole, "super_admin");
  const smoke = await signup(env, "deploy-smoke-1@example.com");

  const asOwner = await call(env, "POST", "/v1/admin/accounts/lock", {
    email: "deploy-smoke-1@example.com"
  }, { cookie: smoke.cookie });
  assert.equal(asOwner.status, 403);
  assert.equal((await asOwner.json()).error, "operator_secret_required");

  const asAdmin = await call(env, "POST", "/v1/admin/accounts/lock", {
    email: "deploy-smoke-1@example.com"
  }, { cookie: ops.cookie, ray: "lock-ray" });
  assert.equal(asAdmin.status, 403);
  assert.equal((await asAdmin.json()).error, "operator_secret_required");

  const stillIn = await call(env, "GET", "/v1/me", undefined, { cookie: smoke.cookie });
  assert.equal(stillIn.status, 200);
  const stillPassword = await call(env, "POST", "/v1/auth/login", {
    email: "deploy-smoke-1@example.com",
    password: OLD_PASSWORD
  });
  assert.equal(stillPassword.status, 200);

  const badStatusSession = await call(env, "POST", "/v1/admin/accounts/lock", {
    email: "ops@example.com",
    status: "active"
  }, { cookie: ops.cookie });
  assert.equal(badStatusSession.status, 403);
  assert.equal((await badStatusSession.json()).error, "operator_secret_required");

  const badStatusSecret = await call(env, "POST", "/v1/admin/accounts/lock", {
    email: "ops@example.com",
    status: "active"
  }, { operatorSecret: OPERATOR_SECRET });
  assert.equal(badStatusSecret.status, 400);
  assert.equal((await badStatusSecret.json()).error, "invalid_status");

  const bySecret = await call(env, "POST", "/v1/admin/accounts/lock", {
    email: "deploy-smoke-1@example.com",
    status: "suspended"
  }, { operatorSecret: OPERATOR_SECRET, ray: "lock-secret-ray" });
  assert.equal(bySecret.status, 200);
  assert.ok((await bySecret.json()).sessionsRevoked >= 1);
  const session = await call(env, "GET", "/v1/me", undefined, { cookie: smoke.cookie });
  assert.equal(session.status, 401);

  const audit = await call(env, "GET", "/v1/admin/accounts/audit?email=deploy-smoke-1@example.com", undefined, {
    operatorSecret: OPERATOR_SECRET
  });
  const events = (await audit.json()).events;
  const denied = events.find((event) => event.actorUserId === `${ops.body.user.id}:lock-ray`);
  assert.equal(denied.action, "account.lock_denied");
  assert.equal(denied.metadata.result, "denied");
  const locked = events.find((event) => event.action === "account.lock");
  assert.equal(locked.actorUserId, "operator_secret:lock-secret-ray");
  assert.equal(JSON.stringify(events).includes(OLD_PASSWORD), false);

  const directory = await call(env, "GET", "/v1/admin/accounts", undefined, { operatorSecret: OPERATOR_SECRET });
  assert.equal(directory.status, 200);
  const emails = (await directory.json()).accounts.map((item) => item.email);
  assert.ok(emails.includes("deploy-smoke-1@example.com"));
  assert.equal(JSON.stringify(emails).includes(OLD_PASSWORD), false);
});

test("super_admin session gets 403 on reset-password and the victim stays signed in", async () => {
  const env = makeLocalEnv({
    SUPER_ADMIN_EMAILS: "collector@example.com",
    OPERATOR_ACCOUNT_SECRET: OPERATOR_SECRET
  });
  const collector = await signup(env, "collector@example.com");
  assert.equal(collector.body.user.globalRole, "super_admin");
  const victim = await signup(env, "victim@example.com");

  const anonymous = await call(env, "POST", "/v1/admin/accounts/reset-password", {
    email: "victim@example.com",
    password: NEW_PASSWORD
  });
  assert.equal(anonymous.status, 401);

  const reset = await call(env, "POST", "/v1/admin/accounts/reset-password", {
    email: "victim@example.com",
    password: NEW_PASSWORD
  }, { cookie: collector.cookie, ray: "qa-ray-1" });
  assert.equal(reset.status, 403);
  assert.equal((await reset.json()).error, "operator_secret_required");

  const victimSession = await call(env, "GET", "/v1/me", undefined, { cookie: victim.cookie });
  assert.equal(victimSession.status, 200);
  const victimLogin = await call(env, "POST", "/v1/auth/login", {
    email: "victim@example.com",
    password: OLD_PASSWORD
  });
  assert.equal(victimLogin.status, 200);

  const audit = await call(env, "GET", "/v1/admin/accounts/audit?email=victim@example.com", undefined, {
    operatorSecret: OPERATOR_SECRET
  });
  assert.equal(audit.status, 200);
  const events = (await audit.json()).events;
  assert.equal(events.filter((event) => event.action === "account.password_reset_denied").length, 1);
  const denied = events.find((event) => event.action === "account.password_reset_denied");
  assert.equal(denied.actorUserId, `${collector.body.user.id}:qa-ray-1`);
  assert.equal(denied.metadata.result, "denied");
  assert.equal(denied.metadata.email, "victim@example.com");
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes(NEW_PASSWORD), false);
  assert.equal(serialized.includes(OLD_PASSWORD), false);
  assert.equal(serialized.includes("password_hash"), false);

  const bySecret = await call(env, "POST", "/v1/admin/accounts/reset-password", {
    email: "victim@example.com",
    password: NEW_PASSWORD
  }, { operatorSecret: OPERATOR_SECRET, ray: "qa-ray-2" });
  assert.equal(bySecret.status, 200);
  const after = await call(env, "GET", "/v1/admin/accounts/audit?email=victim@example.com", undefined, {
    operatorSecret: OPERATOR_SECRET
  });
  const success = (await after.json()).events.find((event) => event.action === "account.password_reset");
  assert.equal(success.actorUserId, "operator_secret:qa-ray-2");
  const victimAfter = await call(env, "GET", "/v1/me", undefined, { cookie: victim.cookie });
  assert.equal(victimAfter.status, 401);
});

test("a normal user's denial spam does not block an operator-secret reset", async () => {
  const env = makeLocalEnv({ OPERATOR_ACCOUNT_SECRET: OPERATOR_SECRET });
  const member = await signup(env, "member@example.com");
  assert.equal(member.body.user.globalRole, "user");
  await signup(env, "victim-rate@example.com");
  for (let attempt = 0; attempt < 9; attempt += 1) {
    const denied = await call(env, "POST", "/v1/admin/accounts/reset-password", {
      email: "victim-rate@example.com",
      password: NEW_PASSWORD
    }, { cookie: member.cookie });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, "operator_secret_required");
  }
  const reset = await call(env, "POST", "/v1/admin/accounts/reset-password", {
    email: "victim-rate@example.com",
    password: NEW_PASSWORD
  }, { operatorSecret: OPERATOR_SECRET, ray: "operator-after-spam" });
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).sessionsRevoked >= 1, true);
  const oldPassword = await call(env, "POST", "/v1/auth/login", {
    email: "victim-rate@example.com",
    password: OLD_PASSWORD
  });
  assert.equal(oldPassword.status, 401);
  const newPassword = await call(env, "POST", "/v1/auth/login", {
    email: "victim-rate@example.com",
    password: NEW_PASSWORD
  });
  assert.equal(newPassword.status, 200);
});

test("anonymous wrong operator secrets are rate limited per IP", async () => {
  const env = makeLocalEnv({ OPERATOR_ACCOUNT_SECRET: OPERATOR_SECRET });
  const ip = "203.0.113.45";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const rejected = await call(env, "POST", "/v1/admin/accounts/lock", {
      email: "person@example.com"
    }, { operatorSecret: "wrong-secret", ip });
    assert.equal(rejected.status, 401);
    assert.equal((await rejected.json()).error, "invalid_operator_secret");
  }
  const limited = await call(env, "POST", "/v1/admin/accounts/lock", {
    email: "person@example.com"
  }, { operatorSecret: "wrong-secret", ip });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, "rate_limited");
  const otherIp = await call(env, "POST", "/v1/admin/accounts/lock", {
    email: "person@example.com"
  }, { operatorSecret: "wrong-secret", ip: "203.0.113.46" });
  assert.equal(otherIp.status, 401);
  const valid = await call(env, "POST", "/v1/admin/accounts/lock", {
    email: "missing-after-guesses@example.com"
  }, { operatorSecret: OPERATOR_SECRET, ip });
  assert.equal(valid.status, 404);
});

test("smoke recovery plan uses registry names and a capped timestamp window", () => {
  const created = Date.parse("2026-10-18T00:00:01.000Z");
  const tenants = [
    { name: "Deploy Smoke", createdAt: "2026-10-18T00:00:01.000Z" },
    { name: "API Prefix Smoke", createdAt: "2026-10-18T00:00:01.500Z" },
    { name: "Collector Workspace", createdAt: "2026-10-18T00:00:01.000Z" },
    { name: "Deploy Smoke", createdAt: "2026-10-17T00:00:00.000Z" }
  ];
  const plan = smokeRecoveryPlan(tenants, {
    runStartMs: created - 5_000,
    runEndMs: created + 5_000,
    behindMs: 2,
    aheadMs: 1
  });
  assert.equal(plan.length, 2);
  assert.equal(plan[0].prefix, "deploy-smoke-");
  assert.deepEqual(plan[0].emails, [
    `deploy-smoke-${created + 1}@example.com`,
    `deploy-smoke-${created}@example.com`,
    `deploy-smoke-${created - 1}@example.com`,
    `deploy-smoke-${created - 2}@example.com`
  ]);
  assert.equal(plan[1].prefix, "deploy-api-prefix-");
  assert.equal(plan[1].emails[0], `deploy-api-prefix-${created + 500 + 1}@example.com`);

  const capped = smokeRecoveryPlan(
    [{ name: "Deploy Smoke", createdAt: new Date(1_000_000).toISOString() }],
    { behindMs: 100_000, aheadMs: 5_000, maxSpanMs: 60_000 }
  );
  assert.equal(capped[0].emails.length, 60_001);
  assert.equal(capped[0].emails[0], "deploy-smoke-1005000@example.com");
  assert.equal(capped[0].emails.at(-1), "deploy-smoke-945000@example.com");
});

test("unknown account and short password do not report success", async () => {
  const env = makeLocalEnv({ OPERATOR_ACCOUNT_SECRET: OPERATOR_SECRET });
  const missing = await call(env, "POST", "/v1/admin/accounts/lock", {
    email: "missing@example.com"
  }, { operatorSecret: OPERATOR_SECRET });
  assert.equal(missing.status, 404);
  const short = await call(env, "POST", "/v1/admin/accounts/reset-password", {
    email: "missing@example.com",
    password: "short"
  }, { operatorSecret: OPERATOR_SECRET });
  assert.equal(short.status, 400);
  assert.equal((await short.json()).error, "password_too_short");
});

test("recover-smoke refuses to run without a valid window", () => {
  assert.throws(() => requireSmokeWindow({}), /Missing SMOKE_RUN_START_MS/);
  assert.throws(() => requireSmokeWindow({ SMOKE_RUN_START_MS: "10" }), /Missing SMOKE_RUN_END_MS/);
  assert.throws(() => requireSmokeWindow({ SMOKE_RUN_START_MS: "later", SMOKE_RUN_END_MS: "20" }), /Invalid SMOKE_RUN_START_MS/);
  assert.throws(() => requireSmokeWindow({ SMOKE_RUN_START_MS: "30", SMOKE_RUN_END_MS: "10" }), /after SMOKE_RUN_END_MS/);
  assert.deepEqual(requireSmokeWindow({ SMOKE_RUN_START_MS: "10", SMOKE_RUN_END_MS: "20" }), { start: 10, end: 20 });

  const env = { ...process.env, OPERATOR_ACCOUNT_SECRET: "present", API_BASE: "http://127.0.0.1:9" };
  delete env.SMOKE_RUN_START_MS;
  delete env.SMOKE_RUN_END_MS;
  const missing = spawnSync(process.execPath, ["scripts/operator-account.mjs", "recover-smoke"], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: 3000
  });
  assert.notEqual(missing.status, 0);
  const output = `${missing.stdout || ""}\n${missing.stderr || ""}`;
  assert.match(output, /SMOKE_RUN_START_MS/);
  assert.equal(output.includes("present"), false);
  assert.doesNotMatch(output, /ECONNREFUSED|fetch failed|ENOTFOUND/);
});

test("operator script exits before the network when required env is missing", () => {
  const base = { ...process.env, TARGET_EMAIL: "person@example.com", ACCOUNT_NEW_PASSWORD: "should-not-appear" };
  delete base.OPERATOR_ACCOUNT_SECRET;
  const missingSecret = spawnSync(process.execPath, ["scripts/operator-account.mjs", "reset-password"], {
    cwd: ROOT,
    env: base,
    encoding: "utf8"
  });
  assert.notEqual(missingSecret.status, 0);
  const secretOutput = `${missingSecret.stdout || ""}\n${missingSecret.stderr || ""}`;
  assert.match(secretOutput, /OPERATOR_ACCOUNT_SECRET/);
  assert.equal(secretOutput.includes("should-not-appear"), false);

  const missingPassword = spawnSync(process.execPath, ["scripts/operator-account.mjs", "reset-password"], {
    cwd: ROOT,
    env: { ...base, OPERATOR_ACCOUNT_SECRET: "present", ACCOUNT_NEW_PASSWORD: "" },
    encoding: "utf8"
  });
  assert.notEqual(missingPassword.status, 0);
  const passwordOutput = `${missingPassword.stdout || ""}\n${missingPassword.stderr || ""}`;
  assert.match(passwordOutput, /ACCOUNT_NEW_PASSWORD/);
  assert.equal(passwordOutput.includes("present"), false);
});
