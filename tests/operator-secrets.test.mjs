import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deploySmokePassword, requireCollectorCredentials, resolveSuperAdminEmails } from "../scripts/operator-env.mjs";
import { logoutEndpoint, runSignupSmoke } from "../scripts/deploy-smoke.mjs";

const ROOT = resolve(import.meta.dirname, "..");

test("collector credentials are required and are not echoed", () => {
  assert.throws(
    () => requireCollectorCredentials({}),
    (error) => {
      assert.match(error.message, /COLLECTOR_EMAIL/);
      assert.match(error.message, /COLLECTOR_PASSWORD/);
      return true;
    }
  );
  assert.throws(
    () => requireCollectorCredentials({ COLLECTOR_EMAIL: "ops@example.com" }),
    (error) => {
      assert.match(error.message, /COLLECTOR_PASSWORD/);
      assert.doesNotMatch(error.message, /COLLECTOR_EMAIL and/);
      return true;
    }
  );
  assert.throws(
    () => requireCollectorCredentials({ COLLECTOR_PASSWORD: "not-a-real-secret" }),
    (error) => {
      assert.match(error.message, /COLLECTOR_EMAIL/);
      assert.equal(error.message.includes("not-a-real-secret"), false);
      return true;
    }
  );
  assert.deepEqual(
    requireCollectorCredentials({
      COLLECTOR_EMAIL: " Ops@Example.com ",
      COLLECTOR_PASSWORD: "from-the-environment"
    }),
    { email: "ops@example.com", password: "from-the-environment" }
  );
});

test("super-admin allowlist comes only from the provided value", () => {
  assert.throws(() => resolveSuperAdminEmails(""), /SUPER_ADMIN_EMAILS is missing/);
  assert.throws(() => resolveSuperAdminEmails("   "), /SUPER_ADMIN_EMAILS is missing/);
  assert.throws(() => resolveSuperAdminEmails("not-an-email"), /invalid email/);
  assert.equal(
    resolveSuperAdminEmails(" Owner@Example.com, ops@example.com ,owner@example.com "),
    "owner@example.com,ops@example.com"
  );
});

test("deploy smoke password is optional", () => {
  assert.equal(deploySmokePassword({}), null);
  assert.equal(deploySmokePassword({ DEPLOY_SMOKE_PASSWORD: "" }), null);
  assert.equal(deploySmokePassword({ DEPLOY_SMOKE_PASSWORD: "from-env" }), "from-env");
});

test("signup smoke skips account creation when the password is unset", async () => {
  let called = false;
  const result = await runSignupSmoke({
    endpoint: "https://example.test/v1/auth/signup",
    origin: "https://dash.example.test",
    email: "smoke@example.com",
    password: "",
    fetchImpl: async () => {
      called = true;
      throw new Error("fetch should not run");
    }
  });
  assert.equal(result.skipped, true);
  assert.equal(called, false);
});

test("signup smoke uses the env password and revokes the session", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({
      url: String(url),
      method: init.method,
      body: init.body,
      authorization: init.headers.authorization
    });
    if (String(url).endsWith("/signup")) {
      return new Response(JSON.stringify({ session: { token: "shard.sid.secret" } }), {
        status: 201,
        headers: { "set-cookie": "reputa_session=abc; SameSite=None; Secure" }
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const result = await runSignupSmoke({
    endpoint: "https://example.test/api/v1/auth/signup",
    origin: "https://dash.example.test",
    email: "smoke@example.com",
    password: "from-env",
    workspaceName: "Deploy Smoke",
    fetchImpl
  });
  assert.equal(result.skipped, false);
  assert.equal(result.status, 201);
  assert.match(result.setCookie, /SameSite=None/);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].body).password, "from-env");
  assert.equal(calls[1].url, logoutEndpoint("https://example.test/api/v1/auth/signup"));
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].authorization, "Bearer shard.sid.secret");
  assert.deepEqual(result.cleanup, { attempted: true, status: 200 });
});

test("signup smoke does not call logout when signup fails", async () => {
  let calls = 0;
  const result = await runSignupSmoke({
    endpoint: "https://example.test/v1/auth/signup",
    origin: "https://dash.example.test",
    email: "smoke@example.com",
    password: "from-env",
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "nope" }), { status: 400 });
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 400);
  assert.equal(result.cleanup.attempted, false);
  assert.match(result.errorText, /nope/);
});

test("bootstrap exits before any network call when collector env is missing", () => {
  const env = { ...process.env };
  delete env.COLLECTOR_EMAIL;
  delete env.COLLECTOR_PASSWORD;
  const result = spawnSync(process.execPath, ["scripts/bootstrap-production-collection.mjs"], {
    cwd: ROOT,
    env,
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  assert.match(output, /COLLECTOR_EMAIL/);
  assert.match(output, /COLLECTOR_PASSWORD/);
  assert.doesNotMatch(output, /@/);
});

test("tracked operator files do not embed collector or smoke passwords", () => {
  const files = [
    "BUILD_STATUS.md",
    "scripts/bootstrap-production-collection.mjs",
    "scripts/deploy-cloudspace.mjs",
    "scripts/operator-env.mjs",
    "scripts/deploy-smoke.mjs",
    "docs/AUTH_BILLING_SUPERADMIN.md",
    "docs/DEPLOYMENT_CLOUDSPACE.md",
    "docs/SECRETS_AND_PROVIDER_ACCESS.md",
    ".github/workflows/deploy-cloudspace.yml"
  ];
  const forbidden = [
    /COLLECTOR_EMAIL\s*\|\|/,
    /COLLECTOR_PASSWORD\s*\|\|/,
    /\bpassword\s*[:=]\s*["'][^"']+["']/i,
    /\|\s*Password\s*\|\s*`[^`]+`/,
    /\|\s*Email\s*\|\s*`[^`]+@[^`]+`/
  ];
  for (const file of files) {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${file} matched ${pattern}`);
    }
  }
  const deploy = readFileSync(resolve(ROOT, "scripts/deploy-cloudspace.mjs"), "utf8");
  assert.match(deploy, /resolveSuperAdminEmails\(process\.env\.SUPER_ADMIN_EMAILS\)/);
  assert.match(deploy, /deploySmokePassword\(/);
  assert.doesNotMatch(deploy, /const required = \[/);
});
