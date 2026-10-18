/**
 * Operator request signature. The raw OPERATOR_ACCOUNT_SECRET is an HMAC key.
 * It is never placed in a header, a query string, or a log line.
 *
 * Canonical string, UTF-8, no trailing newline:
 *   METHOD \n pathname+search \n timestamp \n nonce \n hex SHA-256 of the body
 * GET and HEAD sign an empty body. The signature is base64url HMAC-SHA256.
 * The server accepts timestamps within 60 seconds and rejects a reused nonce.
 * The signed path drops one leading /api prefix, matching the API worker's
 * normalizeApiPathname, so a custom-domain /api base and a workers.dev base match.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";

export const OPERATOR_SIGNATURE_WINDOW_MS = 60_000;

/** Same rule as apps/api-worker normalizeApiPathname. */
export function normalizeOperatorPath(pathname) {
  if (pathname === "/api") return "/";
  if (pathname.startsWith("/api/")) return pathname.slice(4) || "/";
  return pathname;
}

export function operatorSignedPath(path) {
  const url = new URL(path, "https://operator.local");
  return `${normalizeOperatorPath(url.pathname)}${url.search}`;
}

export function operatorBodyHash(body) {
  return createHash("sha256").update(body ?? "").digest("hex");
}

export function operatorCanonical(method, path, timestamp, nonce, bodyHash) {
  return `${String(method).toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

export function signOperatorRequest({ secret, method, path, body = "", timestamp = Date.now(), nonce = randomBytes(16).toString("base64url") }) {
  const signedPath = operatorSignedPath(path);
  const bodyText = body == null ? "" : String(body);
  const ts = String(timestamp);
  const signature = createHmac("sha256", String(secret))
    .update(operatorCanonical(method, signedPath, ts, nonce, operatorBodyHash(bodyText)))
    .digest("base64url");
  return {
    timestamp: ts,
    nonce,
    signature,
    headers: {
      "x-operator-timestamp": ts,
      "x-operator-nonce": nonce,
      "x-operator-signature": signature
    }
  };
}
