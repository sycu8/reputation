import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import api from "../apps/api-worker/src/index.ts";
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
  }, { operatorSecret: OPERATOR_SECRET, cookie: account.cookie });
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
  assert.equal(events[0].action, "account.password_reset");
  assert.equal(events[0].actorUserId, "operator_secret");
  assert.equal(events[0].metadata.sessionsRevoked, 2);
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes(NEW_PASSWORD), false);
  assert.equal(serialized.includes(OLD_PASSWORD), false);
  assert.equal(serialized.includes("password_hash"), false);
});

test("super-admin can lock a normal account and cannot lock an allowlisted account", async () => {
  const env = makeLocalEnv({
    SUPER_ADMIN_EMAILS: "ops@example.com",
    OPERATOR_ACCOUNT_SECRET: OPERATOR_SECRET
  });
  const ops = await signup(env, "ops@example.com");
  assert.equal(ops.body.user.globalRole, "super_admin");
  const smoke = await signup(env, "deploy-smoke-1@example.com");
  const denied = await call(env, "POST", "/v1/admin/accounts/lock", {
    email: "deploy-smoke-1@example.com"
  }, { cookie: smoke.cookie });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, "forbidden");
  const smokeLogin = await call(env, "POST", "/v1/auth/login", {
    email: "deploy-smoke-1@example.com",
    password: OLD_PASSWORD
  });
  const smokeCookie = cookieFrom(smokeLogin);

  const locked = await call(env, "POST", "/v1/admin/accounts/lock", {
    email: "deploy-smoke-1@example.com"
  }, { cookie: ops.cookie });
  assert.equal(locked.status, 200);
  const lockBody = await locked.json();
  assert.equal(lockBody.status, "suspended");
  assert.ok(lockBody.sessionsRevoked >= 1);

  const session = await call(env, "GET", "/v1/me", undefined, { cookie: smokeCookie });
  assert.equal(session.status, 401);
  const login = await call(env, "POST", "/v1/auth/login", {
    email: "deploy-smoke-1@example.com",
    password: OLD_PASSWORD
  });
  assert.equal(login.status, 401);

  const relock = await call(env, "POST", "/v1/admin/accounts/lock", {
    email: "ops@example.com",
    status: "active"
  }, { cookie: ops.cookie });
  assert.equal(relock.status, 400);

  const allowlisted = await call(env, "POST", "/v1/admin/accounts/lock", {
    email: "ops@example.com"
  }, { cookie: ops.cookie });
  assert.equal(allowlisted.status, 403);

  const bySecret = await call(env, "POST", "/v1/admin/accounts/lock", {
    email: "ops@example.com",
    status: "suspended"
  }, { operatorSecret: OPERATOR_SECRET });
  assert.equal(bySecret.status, 200);
  assert.equal((await bySecret.json()).sessionsRevoked >= 1, true);
  const opsSession = await call(env, "GET", "/v1/me", undefined, { cookie: ops.cookie });
  assert.equal(opsSession.status, 401);

  const directory = await call(env, "GET", "/v1/admin/accounts", undefined, { operatorSecret: OPERATOR_SECRET });
  assert.equal(directory.status, 200);
  const emails = (await directory.json()).accounts.map((item) => item.email);
  assert.ok(emails.includes("deploy-smoke-1@example.com"));
  assert.equal(JSON.stringify(emails).includes(OLD_PASSWORD), false);
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
