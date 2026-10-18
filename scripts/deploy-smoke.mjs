/**
 * Production signup smoke.
 * Skips account creation when no password is provided.
 * On success, revokes the session via /v1/auth/logout.
 * The API has no delete-account route, so the smoke stays off unless
 * DEPLOY_SMOKE_PASSWORD is set.
 */

export function logoutEndpoint(endpoint) {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/\/signup$/, "/logout");
  return url.toString();
}

export async function runSignupSmoke({
  endpoint,
  origin,
  email,
  password,
  workspaceName = "Deploy Smoke",
  fetchImpl = fetch,
  timeoutMs = 20000
}) {
  if (!password) {
    return { skipped: true, reason: "DEPLOY_SMOKE_PASSWORD is not set" };
  }
  const signup = await fetchImpl(endpoint, {
    method: "POST",
    headers: { Origin: origin, "content-type": "application/json" },
    body: JSON.stringify({ email, password, workspaceName }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const setCookie = signup.headers.get("set-cookie") || "";
  const raw = await signup.text();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  const result = {
    skipped: false,
    status: signup.status,
    setCookie,
    errorText: signup.status === 201 ? "" : raw.slice(0, 500),
    cleanup: { attempted: false, status: null }
  };
  if (signup.status !== 201) return result;
  const token = payload.session?.token || payload.access_token || "";
  if (!token) {
    result.cleanup = { attempted: false, status: null, reason: "signup response had no session token" };
    return result;
  }
  const logout = await fetchImpl(logoutEndpoint(endpoint), {
    method: "POST",
    headers: {
      Origin: origin,
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  result.cleanup = { attempted: true, status: logout.status };
  return result;
}
