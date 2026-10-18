/**
 * Operator credentials for deploy and collector bootstrap.
 * Values come only from the environment. This module has no defaults.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function requireCollectorCredentials(env = process.env) {
  const email = String(env.COLLECTOR_EMAIL ?? "").trim().toLowerCase();
  const password = String(env.COLLECTOR_PASSWORD ?? "");
  const missing = [];
  if (!email) missing.push("COLLECTOR_EMAIL");
  if (!password) missing.push("COLLECTOR_PASSWORD");
  if (missing.length) {
    throw new Error(
      `Missing ${missing.join(" and ")}. Export both before npm run bootstrap:collection. Collector credentials are not stored in the repo.`
    );
  }
  if (!EMAIL_RE.test(email)) {
    throw new Error("COLLECTOR_EMAIL is not a valid email address.");
  }
  return { email, password };
}

/** Comma-separated operator allowlist. Empty input is an error; nothing is added implicitly. */
export function resolveSuperAdminEmails(raw) {
  const emails = [...new Set(
    String(raw ?? "")
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean)
  )];
  if (emails.length === 0) {
    throw new Error(
      "SUPER_ADMIN_EMAILS is missing or empty. Set a comma-separated operator allowlist in the environment (GitHub Actions secret SUPER_ADMIN_EMAILS on deploy). This script does not embed a default allowlist."
    );
  }
  const invalid = emails.filter((email) => !EMAIL_RE.test(email));
  if (invalid.length) {
    throw new Error(
      `SUPER_ADMIN_EMAILS has ${invalid.length} invalid email entr${invalid.length === 1 ? "y" : "ies"}.`
    );
  }
  return emails.join(",");
}

/** Signup smoke password. Null means the deploy smoke must not create an account. */
export function deploySmokePassword(env = process.env) {
  const password = String(env.DEPLOY_SMOKE_PASSWORD ?? "");
  return password.length > 0 ? password : null;
}
