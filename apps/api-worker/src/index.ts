import { hasCapability, isSuperAdminEmail, type Capability } from "../../../packages/auth/src/index.ts";
import { normalizeBooleanQuery, parseBooleanQuery } from "../../../packages/boolean-query/src/index.ts";
import { monitorLimitFor } from "../../../packages/auth/src/entitlements.ts";
import { createBillingProvider, planFromPriceId } from "../../../packages/billing/src/index.ts";
import { schedulerShardIndex } from "../../../packages/crawler-core/src/index.ts";
import { SOURCE_CAPABILITY_DEFAULTS } from "../../../packages/source-adapters/src/index.ts";
import type { AuthContext, GlobalRole, MonitorType, WorkspaceRole } from "../../../packages/types/src/index.ts";
import { normalizeMonitorProfile } from "../../../packages/types/src/index.ts";
import { structuredLog } from "../../../packages/observability/src/index.ts";

interface Env {
  USER_DIRECTORY: DurableObjectNamespace;
  TENANT_DIRECTORY: DurableObjectNamespace;
  MONITOR_DO: DurableObjectNamespace;
  SCHEDULER_SHARD: DurableObjectNamespace;
  TENANT_BUDGET?: DurableObjectNamespace;
  CONFIG_KV: KVNamespace;
  RAW_CONTENT: R2Bucket;
  ANALYTICS?: AnalyticsEngineDataset;
  SUPER_ADMIN_EMAILS?: string;
  OPERATOR_ACCOUNT_SECRET?: string;
  ALLOWED_ORIGINS?: string;
  ENVIRONMENT: string;
  SESSION_COOKIE_NAME?: string;
  BILLING_PROVIDER?: string;
  BILLING_WEBHOOK_SECRET?: string;
}

interface RouteContext {
  requestId: string;
  url: URL;
}

type JsonObject = Record<string, unknown>;

const COOKIE_DEFAULT = "reputa_session";

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}

function errorResponse(error: string, status: number, requestId: string, headers: HeadersInit = {}): Response {
  return json({ error, requestId }, status, headers);
}

const CANONICAL_ORIGIN = "https://reputation.orangecloud.vn";

function protectedResourceMetadataUrl(request: Request): string {
  const url = new URL(request.url);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return `${url.origin}/.well-known/oauth-protected-resource`;
  }
  return `${CANONICAL_ORIGIN}/.well-known/oauth-protected-resource`;
}

function expiresInSeconds(expiresAt: string): number {
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((ms - Date.now()) / 1000));
}

interface LoginCredentials {
  email: string;
  password: string;
  oauthPasswordGrant: boolean;
}

async function readLoginCredentials(request: Request): Promise<LoginCredentials> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(await request.text());
    const grant = params.get("grant_type");
    if (grant && grant !== "password") throw new HttpError(400, "unsupported_grant_type");
    const email = (params.get("username") || params.get("email") || "").trim().toLowerCase();
    const password = params.get("password") ?? "";
    if (!email) throw new HttpError(400, "invalid_email");
    if (!password.trim()) throw new HttpError(400, "invalid_password");
    return { email, password, oauthPasswordGrant: true };
  }
  const body = await readJson(request);
  return {
    email: asString(body.email, "email").toLowerCase(),
    password: asString(body.password, "password"),
    oauthPasswordGrant: false
  };
}

async function readJson(request: Request): Promise<JsonObject> {
  try {
    return (await request.json()) as JsonObject;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `invalid_${name}`);
  return value.trim();
}

function parseCookies(request: Request): Map<string, string> {
  const result = new Map<string, string>();
  const header = request.headers.get("cookie") ?? "";
  for (const piece of header.split(";")) {
    const index = piece.indexOf("=");
    if (index <= 0) continue;
    result.set(piece.slice(0, index).trim(), piece.slice(index + 1).trim());
  }
  return result;
}

function sessionCookie(name: string, value: string, expiresAt: string, secure: boolean): string {
  // Secure cookies use SameSite=None so credentialed CORS works across
  // workers.dev dashboard ↔ API hosts (workers.dev is on the public suffix list).
  // Partitioned (CHIPS) keeps the cookie usable when Chrome blocks third-party cookies.
  const sameSite = secure ? "None" : "Lax";
  const partitioned = secure ? " Partitioned;" : "";
  return `${name}=${value}; Path=/; HttpOnly; ${secure ? "Secure; " : ""}SameSite=${sameSite};${partitioned} Expires=${new Date(expiresAt).toUTCString()}`;
}

function clearCookie(name: string, secure: boolean): string {
  const sameSite = secure ? "None" : "Lax";
  const partitioned = secure ? " Partitioned;" : "";
  return `${name}=; Path=/; HttpOnly; ${secure ? "Secure; " : ""}SameSite=${sameSite};${partitioned} Max-Age=0`;
}

function useSecureCookies(env: Env): boolean {
  return env.ENVIRONMENT === "production" || env.ENVIRONMENT === "staging";
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function shardForEmail(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return base64url(new Uint8Array(digest));
}

function userStub(env: Env, shard: string): DurableObjectStub {
  return env.USER_DIRECTORY.get(env.USER_DIRECTORY.idFromName(shard));
}

function tenantStub(env: Env, tenantId: string): DurableObjectStub {
  return env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));
}

function monitorStub(env: Env, tenantId: string, monitorId: string): DurableObjectStub {
  return env.MONITOR_DO.get(env.MONITOR_DO.idFromName(`${tenantId}:${monitorId}`));
}

function sourceHealthSnapshot(): { sources: Array<{ source: string; availability: string; capabilities: Record<string, boolean> }> } {
  return {
    sources: Object.entries(SOURCE_CAPABILITY_DEFAULTS).map(([source, value]) => ({
      source,
      availability: value.availability,
      capabilities: { ...value.capabilities }
    }))
  };
}

async function registerTenant(env: Env, input: { id: string; name: string; plan?: string; ownerUserId?: string }): Promise<void> {
  await env.CONFIG_KV.put(`tenant:registry:${input.id}`, JSON.stringify({
    id: input.id,
    name: input.name,
    plan: input.plan ?? "free",
    ownerUserId: input.ownerUserId ?? null,
    createdAt: new Date().toISOString()
  }));
}

async function schedulerShard(env: Env, tenantId: string): Promise<DurableObjectStub> {
  const index = await schedulerShardIndex(tenantId);
  return env.SCHEDULER_SHARD.get(env.SCHEDULER_SHARD.idFromName(`scheduler-shard:${index}`));
}

async function upsertSchedulerMonitor(
  env: Env,
  input: {
    tenantId: string;
    monitorId: string;
    priority?: string;
    status: string;
    nextScanAt?: string;
    scanIntervalSec?: number;
  }
): Promise<void> {
  await doJson(await schedulerShard(env, input.tenantId), "/internal/upsert", {
    method: "POST",
    body: JSON.stringify({
      tenantId: input.tenantId,
      monitorId: input.monitorId,
      priority: input.priority ?? "normal",
      status: input.status,
      nextScanAt: input.nextScanAt,
      scanIntervalSec: input.scanIntervalSec
    })
  });
}

async function removeSchedulerMonitor(env: Env, tenantId: string, monitorId: string): Promise<void> {
  await doJson(await schedulerShard(env, tenantId), "/internal/remove", {
    method: "POST",
    body: JSON.stringify({ tenantId, monitorId })
  });
}

async function doJson<T>(stub: DurableObjectStub, path: string, init?: RequestInit): Promise<T> {
  const response = await stub.fetch(`https://do.internal${path}`, init);
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new HttpError(response.status, body.error ?? "state_error");
  return body;
}

class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;

  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

async function resolveAuth(request: Request, env: Env): Promise<AuthContext> {
  const cookieName = env.SESSION_COOKIE_NAME ?? COOKIE_DEFAULT;
  let raw = parseCookies(request).get(cookieName) ?? null;
  if (!raw) {
    const header = request.headers.get("authorization") || request.headers.get("Authorization") || "";
    const match = header.match(/^Bearer\s+(\S+)/i);
    if (match?.[1]) raw = match[1];
  }
  if (!raw) throw new HttpError(401, "authentication_required");
  const [userShard, sessionId, sessionSecret] = raw.split(".");
  if (!userShard || !sessionId || !sessionSecret) throw new HttpError(401, "invalid_session");
  const verified = await doJson<{ userId: string; email: string; globalRole: GlobalRole; sessionId: string }>(
    userStub(env, userShard),
    "/internal/session/verify",
    { method: "POST", body: JSON.stringify({ sessionId, sessionSecret }) }
  );
  const globalRole = await syncSuperAdminRole(env, userShard, verified.email, verified.globalRole);
  return { userId: verified.userId, userShard, email: verified.email, globalRole, sessionId: verified.sessionId };
}

/** Keep stored global_role aligned with SUPER_ADMIN_EMAILS allowlist (promote/demote). */
async function syncSuperAdminRole(
  env: Env,
  userShard: string,
  email: string,
  current: GlobalRole
): Promise<GlobalRole> {
  if (!env.SUPER_ADMIN_EMAILS?.trim()) return current;
  const desired: GlobalRole = isSuperAdminEmail(email, env.SUPER_ADMIN_EMAILS) ? "super_admin" : "user";
  if (desired === current) return current;
  const updated = await doJson<{ globalRole: GlobalRole }>(
    userStub(env, userShard),
    "/internal/global-role",
    { method: "POST", body: JSON.stringify({ globalRole: desired }) }
  );
  return updated.globalRole;
}

async function requireWorkspaceCapability(
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  capability: Capability
): Promise<WorkspaceRole> {
  try {
    const result = await doJson<{ membership: { userId: string; role: WorkspaceRole } }>(
      tenantStub(env, workspaceId),
      `/internal/memberships/${encodeURIComponent(auth.userId)}`
    );
    if (!hasCapability(result.membership.role, capability, auth.globalRole)) throw new HttpError(403, "forbidden");
    return result.membership.role;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      if (auth.globalRole === "super_admin") return "owner";
      throw new HttpError(403, "forbidden");
    }
    throw error;
  }
}

function pathMatch(pathname: string, pattern: RegExp): RegExpMatchArray | null {
  return pathname.match(pattern);
}

/** Workers route `hostname/api/*` keeps the `/api` prefix; normalize to app paths. */
export function normalizeApiPathname(pathname: string): string {
  if (pathname === "/api") return "/";
  if (pathname.startsWith("/api/")) return pathname.slice(4) || "/";
  return pathname;
}

function requestUrlForRouting(request: Request): URL {
  const url = new URL(request.url);
  url.pathname = normalizeApiPathname(url.pathname);
  return url;
}

async function signup(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const email = asString(body.email, "email").toLowerCase();
  const password = asString(body.password, "password");
  const workspaceName = typeof body.workspaceName === "string" && body.workspaceName.trim() ? body.workspaceName.trim() : `${email.split("@")[0]}'s workspace`;
  const shard = await shardForEmail(email);
  const globalRole: GlobalRole = isSuperAdminEmail(email, env.SUPER_ADMIN_EMAILS) ? "super_admin" : "user";
  const account = await doJson<{ userId: string; email: string; globalRole: GlobalRole; sessionId: string; sessionSecret: string; expiresAt: string }>(
    userStub(env, shard),
    "/internal/signup",
    { method: "POST", body: JSON.stringify({ email, password, globalRole }) }
  );
  const workspaceId = crypto.randomUUID();
  await doJson(tenantStub(env, workspaceId), "/internal/init", {
    method: "POST",
    body: JSON.stringify({ id: workspaceId, name: workspaceName, ownerUserId: account.userId, plan: "free" })
  });
  await doJson(userStub(env, shard), "/internal/memberships", {
    method: "POST",
    body: JSON.stringify({ workspaceId, workspaceName, role: "owner" })
  });
  await registerTenant(env, { id: workspaceId, name: workspaceName, plan: "free", ownerUserId: account.userId });
  const cookieName = env.SESSION_COOKIE_NAME ?? COOKIE_DEFAULT;
  const cookieValue = `${shard}.${account.sessionId}.${account.sessionSecret}`;
  await rememberAccount(env, { email: account.email, userId: account.userId, status: "active" });
  return json(
    {
      user: { id: account.userId, email: account.email, globalRole: account.globalRole },
      workspace: { id: workspaceId, name: workspaceName, role: "owner" },
      session: { token: cookieValue, expiresAt: account.expiresAt },
      access_token: cookieValue,
      token_type: "Bearer",
      expires_in: expiresInSeconds(account.expiresAt)
    },
    201,
    { "set-cookie": sessionCookie(cookieName, cookieValue, account.expiresAt, useSecureCookies(env)) }
  );
}

async function login(request: Request, env: Env): Promise<Response> {
  const credentials = await readLoginCredentials(request);
  try {
    const shard = await shardForEmail(credentials.email);
    const account = await doJson<{ userId: string; email: string; globalRole: GlobalRole; sessionId: string; sessionSecret: string; expiresAt: string }>(
      userStub(env, shard),
      "/internal/login",
      { method: "POST", body: JSON.stringify({ email: credentials.email, password: credentials.password }) }
    );
    const globalRole = await syncSuperAdminRole(env, shard, account.email, account.globalRole);
    const cookieValue = `${shard}.${account.sessionId}.${account.sessionSecret}`;
    return json(
      {
        user: { id: account.userId, email: account.email, globalRole },
        session: { token: cookieValue, expiresAt: account.expiresAt },
        access_token: cookieValue,
        token_type: "Bearer",
        expires_in: expiresInSeconds(account.expiresAt)
      },
      200,
      { "set-cookie": sessionCookie(env.SESSION_COOKIE_NAME ?? COOKIE_DEFAULT, cookieValue, account.expiresAt, useSecureCookies(env)) }
    );
  } catch (error) {
    if (credentials.oauthPasswordGrant && error instanceof HttpError && error.status === 401) {
      throw new HttpError(400, "invalid_grant");
    }
    throw error;
  }
}

async function logout(request: Request, env: Env): Promise<Response> {
  const auth = await resolveAuth(request, env);
  await doJson(userStub(env, auth.userShard), "/internal/session/revoke", {
    method: "POST",
    body: JSON.stringify({ sessionId: auth.sessionId })
  });
  return json({ ok: true }, 200, { "set-cookie": clearCookie(env.SESSION_COOKIE_NAME ?? COOKIE_DEFAULT, useSecureCookies(env)) });
}

async function listWorkspaces(auth: AuthContext, env: Env): Promise<Response> {
  const data = await doJson<{ memberships: Array<{ workspaceId: string; workspaceName: string; role: WorkspaceRole }> }>(
    userStub(env, auth.userShard),
    "/internal/memberships"
  );
  return json(data);
}

async function createWorkspace(request: Request, auth: AuthContext, env: Env): Promise<Response> {
  const body = await readJson(request);
  const name = asString(body.name, "workspace_name");
  const workspaceId = crypto.randomUUID();
  await doJson(tenantStub(env, workspaceId), "/internal/init", {
    method: "POST",
    body: JSON.stringify({ id: workspaceId, name, ownerUserId: auth.userId, plan: "free" })
  });
  await doJson(userStub(env, auth.userShard), "/internal/memberships", {
    method: "POST",
    body: JSON.stringify({ workspaceId, workspaceName: name, role: "owner" })
  });
  await registerTenant(env, { id: workspaceId, name, plan: "free", ownerUserId: auth.userId });
  return json({ workspace: { id: workspaceId, name, role: "owner", plan: "free" } }, 201);
}

async function workspaceDetails(auth: AuthContext, env: Env, workspaceId: string): Promise<Response> {
  await requireWorkspaceCapability(env, auth, workspaceId, "workspace.read");
  const data = await doJson<{ workspace: { id: string; name: string; plan: string; status: string } }>(tenantStub(env, workspaceId), "/internal/workspace");
  return json(data);
}

async function listMonitors(auth: AuthContext, env: Env, workspaceId: string): Promise<Response> {
  await requireWorkspaceCapability(env, auth, workspaceId, "monitor.read");
  const data = await doJson<{ monitors: Array<Record<string, unknown>> }>(tenantStub(env, workspaceId), "/internal/monitors");
  return json(data);
}

function validateMonitorType(value: unknown): MonitorType {
  if (value === "person" || value === "company" || value === "brand" || value === "product") return value;
  throw new HttpError(400, "invalid_monitor_type");
}

async function createMonitor(request: Request, auth: AuthContext, env: Env, workspaceId: string): Promise<Response> {
  await requireWorkspaceCapability(env, auth, workspaceId, "monitor.create");
  const workspace = await doJson<{ workspace: { id: string; name: string; plan: string; status: string } }>(tenantStub(env, workspaceId), "/internal/workspace");
  const directory = await doJson<{ monitors: Array<{ status?: string }> }>(tenantStub(env, workspaceId), "/internal/monitors");
  const limit = monitorLimitFor(workspace.workspace.plan, auth.globalRole === "super_admin");
  const activeCount = directory.monitors.filter((item) => item.status !== "archived").length;
  if (!limit.unlimited && activeCount >= (limit.value ?? 0)) throw new HttpError(402, "monitor_plan_limit_reached");

  const body = await readJson(request);
  const monitorId = crypto.randomUUID();
  const name = asString(body.name, "monitor_name");
  const type = validateMonitorType(body.type);
  const requestedInterval = typeof body.scanIntervalSec === "number" ? body.scanIntervalSec : 900;
  const scanIntervalSec = auth.globalRole === "super_admin" ? Math.max(60, Math.floor(requestedInterval)) : Math.max(300, Math.floor(requestedInterval));
  const alertThreshold = typeof body.alertThreshold === "number" ? body.alertThreshold : 60;
  const defaultLanguage = typeof body.defaultLanguage === "string" ? body.defaultLanguage : "vi";
  const priority = typeof body.priority === "string" && body.priority.trim() ? body.priority.trim() : "normal";
  const nextScanAt = new Date().toISOString();
  const profile = normalizeMonitorProfile(body.profile);

  await doJson(tenantStub(env, workspaceId), "/internal/monitors", {
    method: "POST",
    body: JSON.stringify({ actorUserId: auth.userId, monitorId, name, type, status: "active", priority, nextScanAt, profile })
  });
  try {
    const data = await doJson(monitorStub(env, workspaceId, monitorId), "/internal/init", {
      method: "POST",
      body: JSON.stringify({ id: monitorId, tenantId: workspaceId, name, type, scanIntervalSec, alertThreshold, defaultLanguage, nextScanAt, profile })
    });
    await upsertSchedulerMonitor(env, {
      tenantId: workspaceId,
      monitorId,
      priority,
      status: "active",
      nextScanAt,
      scanIntervalSec
    });
    return json(data, 201);
  } catch (error) {
    await doJson(tenantStub(env, workspaceId), `/internal/monitors/${monitorId}`, {
      method: "DELETE",
      body: JSON.stringify({ actorUserId: auth.userId })
    });
    try {
      await removeSchedulerMonitor(env, workspaceId, monitorId);
    } catch {
      // best-effort cleanup if init failed before/after shard upsert
    }
    throw error;
  }
}

async function getMonitor(auth: AuthContext, env: Env, workspaceId: string, monitorId: string): Promise<Response> {
  await requireWorkspaceCapability(env, auth, workspaceId, "monitor.read");
  const data = await doJson(monitorStub(env, workspaceId, monitorId), "/internal/monitor");
  return json(data);
}

async function updateMonitor(request: Request, auth: AuthContext, env: Env, workspaceId: string, monitorId: string): Promise<Response> {
  await requireWorkspaceCapability(env, auth, workspaceId, "monitor.update");
  const body = await readJson(request);
  const updated = await doJson<{
    monitor: {
      name: string;
      type: string;
      status: string;
      scanIntervalSec: number;
      nextScanAt: string | null;
      profile?: Record<string, unknown>;
    };
  }>(monitorStub(env, workspaceId, monitorId), "/internal/monitor", {
    method: "PATCH",
    body: JSON.stringify(body)
  });
  const priority = typeof body.priority === "string" && body.priority.trim() ? body.priority.trim() : undefined;
  await doJson(tenantStub(env, workspaceId), `/internal/monitors/${monitorId}`, {
    method: "PATCH",
    body: JSON.stringify({
      actorUserId: auth.userId,
      name: updated.monitor.name,
      type: updated.monitor.type,
      status: updated.monitor.status,
      ...(priority ? { priority } : {}),
      nextScanAt: updated.monitor.nextScanAt,
      ...(updated.monitor.profile ? { profile: updated.monitor.profile } : body.profile !== undefined ? { profile: normalizeMonitorProfile(body.profile) } : {})
    })
  });
  if (updated.monitor.status === "paused" || updated.monitor.status === "archived") {
    await removeSchedulerMonitor(env, workspaceId, monitorId);
  } else {
    const directory = await doJson<{ monitors: Array<{ monitor_id?: string; priority?: string }> }>(
      tenantStub(env, workspaceId),
      "/internal/monitors"
    );
    const entry = directory.monitors.find((item) => item.monitor_id === monitorId);
    await upsertSchedulerMonitor(env, {
      tenantId: workspaceId,
      monitorId,
      priority: priority ?? entry?.priority ?? "normal",
      status: "active",
      nextScanAt: updated.monitor.nextScanAt ?? new Date().toISOString(),
      scanIntervalSec: updated.monitor.scanIntervalSec
    });
  }
  return json(updated);
}

async function deleteMonitor(auth: AuthContext, env: Env, workspaceId: string, monitorId: string): Promise<Response> {
  await requireWorkspaceCapability(env, auth, workspaceId, "monitor.delete");
  await doJson(monitorStub(env, workspaceId, monitorId), "/internal/monitor", { method: "DELETE" });
  await doJson(tenantStub(env, workspaceId), `/internal/monitors/${monitorId}`, {
    method: "DELETE",
    body: JSON.stringify({ actorUserId: auth.userId })
  });
  await removeSchedulerMonitor(env, workspaceId, monitorId);
  return json({ ok: true });
}

async function listQueries(auth: AuthContext, env: Env, workspaceId: string, monitorId: string): Promise<Response> {
  await requireWorkspaceCapability(env, auth, workspaceId, "query.read");
  const data = await doJson(monitorStub(env, workspaceId, monitorId), "/internal/queries");
  return json(data);
}

async function createQuery(request: Request, auth: AuthContext, env: Env, workspaceId: string, monitorId: string): Promise<Response> {
  await requireWorkspaceCapability(env, auth, workspaceId, "query.create");
  const body = await readJson(request);
  const rawQuery = asString(body.rawQuery, "raw_query");
  let ast;
  let normalizedQuery;
  try {
    ast = parseBooleanQuery(rawQuery);
    normalizedQuery = normalizeBooleanQuery(rawQuery);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "invalid_boolean_query");
  }
  const data = await doJson(monitorStub(env, workspaceId, monitorId), "/internal/queries", {
    method: "POST",
    body: JSON.stringify({ rawQuery, normalizedQuery, astJson: JSON.stringify(ast), enabled: body.enabled !== false })
  });
  return json(data, 201);
}

async function updateQuery(request: Request, auth: AuthContext, env: Env, workspaceId: string, monitorId: string, queryId: string): Promise<Response> {
  await requireWorkspaceCapability(env, auth, workspaceId, "query.update");
  const body = await readJson(request);
  const patch = { ...body };
  if (typeof body.rawQuery === "string") {
    try {
      const ast = parseBooleanQuery(body.rawQuery);
      patch.normalizedQuery = normalizeBooleanQuery(body.rawQuery);
      patch.astJson = JSON.stringify(ast);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "invalid_boolean_query");
    }
  }
  const data = await doJson(monitorStub(env, workspaceId, monitorId), `/internal/queries/${queryId}`, {
    method: "PATCH",
    body: JSON.stringify(patch)
  });
  return json(data);
}

async function deleteQuery(auth: AuthContext, env: Env, workspaceId: string, monitorId: string, queryId: string): Promise<Response> {
  await requireWorkspaceCapability(env, auth, workspaceId, "query.delete");
  const data = await doJson(monitorStub(env, workspaceId, monitorId), `/internal/queries/${queryId}`, { method: "DELETE" });
  return json(data);
}

function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const allowed = (env.ALLOWED_ORIGINS ?? "http://localhost:8788").split(",").map((item) => item.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

function withCors(response: Response, request: Request, env: Env): Response {
  const origin = allowedOrigin(request, env);
  if (!origin) return response;
  response.headers.set("access-control-allow-origin", origin);
  response.headers.set("access-control-allow-credentials", "true");
  response.headers.set("vary", "Origin");
  return response;
}

function corsPreflight(request: Request, env: Env): Response {
  const origin = allowedOrigin(request, env);
  if (!origin) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-max-age": "600",
      "vary": "Origin"
    }
  });
}

async function listMentions(request: Request, auth: AuthContext, env: Env, workspaceId: string, monitorId: string): Promise<Response> {
  await requireWorkspaceCapability(env, auth, workspaceId, "monitor.read");
  const input = new URL(request.url);
  const params = new URLSearchParams();
  for (const key of ["limit", "sentiment", "minSeverity", "source", "from", "to"]) {
    const value = input.searchParams.get(key);
    if (value) params.set(key, value);
  }
  const suffix = params.size ? `?${params.toString()}` : "";
  const data = await doJson(monitorStub(env, workspaceId, monitorId), `/internal/mentions${suffix}`);
  return json(data);
}

async function getMentionDetail(auth: AuthContext, env: Env, workspaceId: string, monitorId: string, mentionId: string): Promise<Response> {
  await requireWorkspaceCapability(env, auth, workspaceId, "monitor.read");
  const data = await doJson(monitorStub(env, workspaceId, monitorId), `/internal/mentions/${encodeURIComponent(mentionId)}`);
  return json(data);
}

async function addMentionFeedback(request: Request, auth: AuthContext, env: Env, workspaceId: string, monitorId: string, mentionId: string): Promise<Response> {
  await requireWorkspaceCapability(env, auth, workspaceId, "monitor.update");
  const body = await readJson(request);
  const action = asString(body.action, "feedback_action");
  const data = await doJson(monitorStub(env, workspaceId, monitorId), "/internal/feedback", {
    method: "POST",
    body: JSON.stringify({ mentionId, userId: auth.userId, action })
  });
  return json(data);
}

async function listAlerts(request: Request, auth: AuthContext, env: Env, workspaceId: string, monitorId: string): Promise<Response> {
  await requireWorkspaceCapability(env, auth, workspaceId, "monitor.read");
  const input = new URL(request.url);
  const params = new URLSearchParams();
  for (const key of ["limit", "from", "to", "minSeverity", "severity", "state"]) {
    const value = input.searchParams.get(key);
    if (value) params.set(key, value);
  }
  const suffix = params.size ? `?${params.toString()}` : "";
  const data = await doJson(monitorStub(env, workspaceId, monitorId), `/internal/alerts${suffix}`);
  return json(data);
}

async function patchAlert(request: Request, auth: AuthContext, env: Env, workspaceId: string, monitorId: string, alertId: string): Promise<Response> {
  await requireWorkspaceCapability(env, auth, workspaceId, "monitor.update");
  const body = await readJson(request);
  const state = asString(body.state, "alert_state");
  const data = await doJson(monitorStub(env, workspaceId, monitorId), `/internal/alerts/${encodeURIComponent(alertId)}`, {
    method: "PATCH",
    body: JSON.stringify({ state })
  });
  return json(data);
}

async function createBillingCheckout(request: Request, auth: AuthContext, env: Env, workspaceId: string): Promise<Response> {
  const role = await requireWorkspaceCapability(env, auth, workspaceId, "workspace.update");
  if (role !== "owner" && role !== "admin" && auth.globalRole !== "super_admin") throw new HttpError(403, "forbidden");
  const body = await readJson(request);
  const plan = asString(body.plan, "plan");
  if (!["starter", "pro", "business"].includes(plan)) throw new HttpError(400, "invalid_plan");
  const successUrl = asString(body.successUrl, "success_url");
  const cancelUrl = asString(body.cancelUrl, "cancel_url");
  const provider = createBillingProvider(env.BILLING_PROVIDER ?? "stub");
  const checkout = await provider.createCheckout({ tenantId: workspaceId, plan, successUrl, cancelUrl });
  return json({ checkout, provider: env.BILLING_PROVIDER ?? "stub" });
}

async function billingWebhook(request: Request, env: Env): Promise<Response> {
  const secret = env.BILLING_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(503, "billing_webhook_not_configured");
  const provider = createBillingProvider(env.BILLING_PROVIDER ?? "stub");
  let event;
  try {
    event = await provider.verifyWebhook(request, secret);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "invalid_billing_webhook");
  }

  const eventKey = `billing:event:${event.eventId}`;
  const existing = await env.CONFIG_KV.get(eventKey);
  if (existing) {
    return json({ ok: true, duplicate: true, eventId: event.eventId });
  }

  let plan = event.plan ?? null;
  if (!plan && event.raw && typeof event.raw === "object") {
    const raw = event.raw as Record<string, unknown>;
    const data = typeof raw.data === "object" && raw.data !== null ? raw.data as Record<string, unknown> : raw;
    plan = planFromPriceId(typeof data.priceId === "string" ? data.priceId : typeof raw.priceId === "string" ? raw.priceId : null);
  }
  if (event.tenantId && plan) {
    await doJson(tenantStub(env, event.tenantId), "/internal/workspace/plan", {
      method: "PATCH",
      body: JSON.stringify({ plan, actorUserId: "billing_webhook" })
    });
    const registryRaw = await env.CONFIG_KV.get(`tenant:registry:${event.tenantId}`);
    if (registryRaw) {
      try {
        const registry = JSON.parse(registryRaw) as Record<string, unknown>;
        await env.CONFIG_KV.put(`tenant:registry:${event.tenantId}`, JSON.stringify({
          ...registry,
          plan,
          updatedAt: new Date().toISOString()
        }));
      } catch {
        // ignore corrupt registry entries
      }
    }
  }

  await env.CONFIG_KV.put(eventKey, JSON.stringify({
    eventId: event.eventId,
    type: event.type,
    tenantId: event.tenantId ?? null,
    plan,
    status: event.status ?? null,
    processedAt: new Date().toISOString()
  }));
  return json({ ok: true, duplicate: false, eventId: event.eventId, plan });
}

const ACCOUNT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

const OPERATOR_SIGNATURE_WINDOW_MS = 60_000;
const seenOperatorNonces = new Map<string, number>();

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256Base64Url(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64url(new Uint8Array(signed));
}

function operatorSignedPath(request: Request): string {
  const url = new URL(request.url);
  return `${normalizeApiPathname(url.pathname)}${url.search}`;
}

async function operatorBodyHash(request: Request): Promise<string> {
  if (request.method === "GET" || request.method === "HEAD") return sha256Hex(new ArrayBuffer(0));
  return sha256Hex(await request.clone().arrayBuffer());
}

function operatorCanonical(method: string, path: string, timestamp: string, nonce: string, bodyHash: string): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

function operatorAttempt(request: Request): boolean {
  return request.headers.has("x-operator-secret")
    || request.headers.has("x-operator-timestamp")
    || request.headers.has("x-operator-nonce")
    || request.headers.has("x-operator-signature");
}

const OPERATOR_NONCE_CACHE_LIMIT = 2048;

function pruneExpiredOperatorNonces(now: number): void {
  for (const [key, seenAt] of seenOperatorNonces) {
    if (now - seenAt >= OPERATOR_SIGNATURE_WINDOW_MS) seenOperatorNonces.delete(key);
  }
}

function operatorNonceRetryAfter(now: number): number {
  let oldest = now;
  for (const seenAt of seenOperatorNonces.values()) {
    if (seenAt < oldest) oldest = seenAt;
  }
  return Math.min(60, Math.max(1, Math.ceil((OPERATOR_SIGNATURE_WINDOW_MS - (now - oldest)) / 1000)));
}

/**
 * Stores a nonce for the signature window. Expired entries are the only ones removed.
 * A cache that is still full of in-window nonces is not evicted; the caller fails closed.
 */
function rememberOperatorNonce(nonce: string, now: number): "ok" | "replay" | "full" {
  pruneExpiredOperatorNonces(now);
  if (seenOperatorNonces.has(nonce)) return "replay";
  if (seenOperatorNonces.size >= OPERATOR_NONCE_CACHE_LIMIT) return "full";
  seenOperatorNonces.set(nonce, now);
  return "ok";
}

function requestRay(request: Request): string {
  const ray = request.headers.get("cf-ray")?.trim() ?? "";
  return ray || "no-request-id";
}

type OperatorGate =
  | { ok: true; actor: string }
  | { ok: false; status: number; error: string; sessionActor?: string; retryAfter?: number };

async function optionalSessionActor(request: Request, env: Env, ray: string): Promise<string | undefined> {
  const hasSession = Boolean(request.headers.get("cookie") || request.headers.get("authorization") || request.headers.get("Authorization"));
  if (!hasSession) return undefined;
  try {
    const auth = await resolveAuth(request, env);
    return `${auth.userId}:${ray}`;
  } catch {
    return undefined;
  }
}

const SECRET_GUESS_LIMIT = 8;
const SECRET_GUESS_WINDOW_MS = 60_000;
const secretGuesses = new Map<string, number[]>();

function clientIp(request: Request): string {
  const value = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  return value.slice(0, 128);
}

/**
 * Per-isolate memory only. The check runs before the HMAC is compared. A timestamp is
 * stored only after that check fails, with or without a cookie. Valid signatures are
 * not recorded. A session with no operator headers is not counted.
 */
function recentSecretFailures(request: Request): number[] {
  const ip = clientIp(request);
  const now = Date.now();
  const recent = (secretGuesses.get(ip) ?? []).filter((ts) => now - ts < SECRET_GUESS_WINDOW_MS);
  if (recent.length === 0) secretGuesses.delete(ip);
  else secretGuesses.set(ip, recent);
  return recent;
}

function secretGuessBlocked(request: Request): { blocked: boolean; retryAfter: number } {
  const recent = recentSecretFailures(request);
  if (recent.length < SECRET_GUESS_LIMIT) return { blocked: false, retryAfter: 0 };
  const oldest = recent[0] ?? Date.now();
  const retryAfter = Math.min(
    60,
    Math.max(1, Math.ceil((SECRET_GUESS_WINDOW_MS - (Date.now() - oldest)) / 1000))
  );
  return { blocked: true, retryAfter };
}

function recordFailedSecretGuess(request: Request): void {
  const ip = clientIp(request);
  const recent = recentSecretFailures(request);
  recent.push(Date.now());
  secretGuesses.set(ip, recent);
  if (secretGuesses.size > 1024) {
    const oldest = secretGuesses.keys().next().value;
    if (oldest !== undefined) secretGuesses.delete(oldest);
  }
}

function operatorGateError(gate: Extract<OperatorGate, { ok: false }>): HttpError {
  if (gate.retryAfter === undefined) return new HttpError(gate.status, gate.error);
  return new HttpError(gate.status, gate.error, { "Retry-After": String(gate.retryAfter) });
}

async function rejectOperatorAttempt(request: Request, env: Env, ray: string): Promise<OperatorGate> {
  recordFailedSecretGuess(request);
  const sessionActor = await optionalSessionActor(request, env, ray);
  if (!sessionActor) return { ok: false, status: 401, error: "invalid_operator_secret" };
  return { ok: false, status: 401, error: "invalid_operator_secret", sessionActor };
}

/**
 * Password reset and lock accept an HMAC over method, path, timestamp, nonce, and body hash.
 * The raw secret is not a header. A session alone is 403. No operator headers and no session is 401.
 */
async function requireOperatorSecret(request: Request, env: Env): Promise<OperatorGate> {
  const ray = requestRay(request);
  if (!operatorAttempt(request)) {
    const sessionActor = await optionalSessionActor(request, env, ray);
    if (!sessionActor) return { ok: false, status: 401, error: "authentication_required" };
    return { ok: false, status: 403, error: "operator_secret_required", sessionActor };
  }
  const expected = env.OPERATOR_ACCOUNT_SECRET?.trim() ?? "";
  if (!expected) {
    const sessionActor = await optionalSessionActor(request, env, ray);
    if (!sessionActor) return { ok: false, status: 503, error: "operator_secret_not_configured" };
    return { ok: false, status: 503, error: "operator_secret_not_configured", sessionActor };
  }
  const limit = secretGuessBlocked(request);
  if (limit.blocked) return { ok: false, status: 429, error: "rate_limited", retryAfter: limit.retryAfter };
  // Presence only. The application does not read the value. Cloudflare invocation logs can still store this header.
  if (request.headers.has("x-operator-secret")) return rejectOperatorAttempt(request, env, ray);
  const timestamp = request.headers.get("x-operator-timestamp")?.trim() ?? "";
  const nonce = request.headers.get("x-operator-nonce")?.trim() ?? "";
  const signature = request.headers.get("x-operator-signature")?.trim() ?? "";
  const parsedAt = /^\d{1,16}$/.test(timestamp) ? Number(timestamp) : NaN;
  const freshTimestamp = Number.isInteger(parsedAt) && Math.abs(Date.now() - parsedAt) <= OPERATOR_SIGNATURE_WINDOW_MS;
  const nonceOk = /^[A-Za-z0-9_-]{16,128}$/.test(nonce);
  const signatureOk = /^[A-Za-z0-9_-]{43}$/.test(signature);
  if (!freshTimestamp || !nonceOk || !signatureOk) return rejectOperatorAttempt(request, env, ray);
  const bodyHash = await operatorBodyHash(request);
  const expectedSignature = await hmacSha256Base64Url(
    expected,
    operatorCanonical(request.method, operatorSignedPath(request), timestamp, nonce, bodyHash)
  );
  if (!constantTimeEqual(expectedSignature, signature)) return rejectOperatorAttempt(request, env, ray);
  const now = Date.now();
  const nonceState = rememberOperatorNonce(nonce, now);
  if (nonceState === "replay") return rejectOperatorAttempt(request, env, ray);
  if (nonceState === "full") {
    return { ok: false, status: 429, error: "rate_limited", retryAfter: operatorNonceRetryAfter(now) };
  }
  return { ok: true, actor: `operator_secret:${ray}` };
}

/** Read paths: operator signature, or a super_admin session. Mutations do not use this. */
async function requireAccountReader(request: Request, env: Env): Promise<void> {
  if (operatorAttempt(request)) {
    const gate = await requireOperatorSecret(request, env);
    if (!gate.ok) throw operatorGateError(gate);
    return;
  }
  const auth = await resolveAuth(request, env);
  if (auth.globalRole !== "super_admin") throw new HttpError(403, "forbidden");
}

async function auditDenial(env: Env, email: unknown, actor: string, action: "account.password_reset_denied" | "account.lock_denied"): Promise<void> {
  if (typeof email !== "string" || !ACCOUNT_EMAIL_RE.test(email.trim().toLowerCase())) return;
  const normalized = email.trim().toLowerCase();
  try {
    await doJson(userStub(env, await shardForEmail(normalized)), "/internal/account/audit-denied", {
      method: "POST",
      body: JSON.stringify({ email: normalized, actorUserId: actor, action })
    });
  } catch {
    // Missing account, or this actor's denial-audit cap. The caller still returns its auth error.
  }
}

function accountEmail(value: unknown): string {
  const email = asString(value, "email").toLowerCase();
  if (!ACCOUNT_EMAIL_RE.test(email)) throw new HttpError(400, "invalid_email");
  return email;
}

async function rememberAccount(env: Env, record: { email: string; userId: string; status: string }): Promise<void> {
  await env.CONFIG_KV.put(`account:directory:${record.email}`, JSON.stringify({
    email: record.email,
    userId: record.userId,
    status: record.status,
    updatedAt: new Date().toISOString()
  }));
}

async function resetAccountPassword(request: Request, env: Env): Promise<Response> {
  const gate = await requireOperatorSecret(request, env);
  const body = await readJson(request);
  if (!gate.ok) {
    if (gate.sessionActor) await auditDenial(env, body.email, gate.sessionActor, "account.password_reset_denied");
    throw operatorGateError(gate);
  }
  const email = accountEmail(body.email);
  const password = asString(body.password, "password");
  if (password.length < 10) throw new HttpError(400, "password_too_short");
  const result = await doJson<{ userId: string; email: string; status: string; sessionsRevoked: number }>(
    userStub(env, await shardForEmail(email)),
    "/internal/account/reset-password",
    { method: "POST", body: JSON.stringify({ email, password, actorUserId: gate.actor }) }
  );
  await rememberAccount(env, { email: result.email, userId: result.userId, status: result.status });
  return json({
    ok: true,
    email: result.email,
    userId: result.userId,
    status: result.status,
    sessionsRevoked: result.sessionsRevoked
  });
}

async function lockAccount(request: Request, env: Env): Promise<Response> {
  const gate = await requireOperatorSecret(request, env);
  const body = await readJson(request);
  if (!gate.ok) {
    if (gate.sessionActor) await auditDenial(env, body.email, gate.sessionActor, "account.lock_denied");
    throw operatorGateError(gate);
  }
  const email = accountEmail(body.email);
  const status = typeof body.status === "string" && body.status.trim() ? body.status.trim() : "suspended";
  if (status !== "suspended" && status !== "deleted") throw new HttpError(400, "invalid_status");
  const result = await doJson<{ userId: string; email: string; status: string; sessionsRevoked: number }>(
    userStub(env, await shardForEmail(email)),
    "/internal/account/lock",
    { method: "POST", body: JSON.stringify({ email, status, actorUserId: gate.actor }) }
  );
  await rememberAccount(env, { email: result.email, userId: result.userId, status: result.status });
  return json({
    ok: true,
    email: result.email,
    userId: result.userId,
    status: result.status,
    sessionsRevoked: result.sessionsRevoked
  });
}

const AUDIT_ACTIONS = new Set([
  "mutations",
  "account.password_reset",
  "account.lock",
  "account.password_reset_denied",
  "account.lock_denied"
]);

async function listAccountAudit(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const email = accountEmail(url.searchParams.get("email"));
  const action = url.searchParams.get("action");
  if (action && !AUDIT_ACTIONS.has(action)) throw new HttpError(400, "invalid_audit_action");
  await requireAccountReader(request, env);
  const query = action ? `?action=${encodeURIComponent(action)}` : "";
  const audit = await doJson(userStub(env, await shardForEmail(email)), `/internal/account/audit${query}`);
  return json(audit);
}

async function listAccountDirectory(request: Request, env: Env): Promise<Response> {
  await requireAccountReader(request, env);
  const listed = await env.CONFIG_KV.list({ prefix: "account:directory:" });
  const accounts = [];
  for (const key of listed.keys) {
    const raw = await env.CONFIG_KV.get(key.name);
    if (!raw) continue;
    try {
      const record = JSON.parse(raw) as { email?: string; userId?: string; status?: string; updatedAt?: string };
      accounts.push({
        email: record.email ?? null,
        userId: record.userId ?? null,
        status: record.status ?? null,
        updatedAt: record.updatedAt ?? null
      });
    } catch {
      accounts.push({ email: key.name.slice("account:directory:".length), userId: null, status: null, updatedAt: null });
    }
  }
  return json({
    accounts,
    note: "Accounts created, reset, or locked after this directory was added. Older accounts are absent until one of those operations."
  });
}

async function listAdminTenants(request: Request, env: Env): Promise<Response> {
  await requireAccountReader(request, env);
  const listed = await env.CONFIG_KV.list({ prefix: "tenant:registry:" });
  const tenants = [];
  for (const key of listed.keys) {
    const raw = await env.CONFIG_KV.get(key.name);
    if (!raw) continue;
    try {
      tenants.push(JSON.parse(raw));
    } catch {
      tenants.push({ id: key.name.replace(/^tenant:registry:/, ""), raw });
    }
  }
  return json({ tenants, note: "Listed from CONFIG_KV tenant registry keys written on workspace create." });
}

async function route(request: Request, env: Env, context: RouteContext): Promise<Response> {
  const { pathname } = context.url;
  if (request.method === "GET" && pathname === "/health") return json({ service: "api", status: "ok", environment: env.ENVIRONMENT, requestId: context.requestId });
  if (request.method === "GET" && pathname === "/v1/source-health") return json(sourceHealthSnapshot());
  if (request.method === "POST" && pathname === "/v1/auth/signup") return signup(request, env);
  if (request.method === "POST" && pathname === "/v1/auth/login") return login(request, env);
  if (request.method === "POST" && pathname === "/v1/billing/webhook") return billingWebhook(request, env);
  if (request.method === "POST" && pathname === "/v1/queries/validate") {
    const body = await readJson(request);
    const rawQuery = asString(body.rawQuery, "raw_query");
    try {
      const ast = parseBooleanQuery(rawQuery);
      return json({ valid: true, normalizedQuery: normalizeBooleanQuery(rawQuery), ast });
    } catch (error) {
      return json({ valid: false, error: error instanceof Error ? error.message : "invalid_boolean_query" }, 400);
    }
  }

  if (
    pathname === "/v1/admin/accounts/reset-password"
    || pathname === "/v1/admin/accounts/lock"
    || pathname === "/v1/admin/accounts/audit"
    || pathname === "/v1/admin/accounts"
  ) {
    if (request.method === "POST" && pathname === "/v1/admin/accounts/reset-password") return resetAccountPassword(request, env);
    if (request.method === "POST" && pathname === "/v1/admin/accounts/lock") return lockAccount(request, env);
    if (request.method === "GET" && pathname === "/v1/admin/accounts/audit") return listAccountAudit(request, env);
    if (request.method === "GET" && pathname === "/v1/admin/accounts") return listAccountDirectory(request, env);
    throw new HttpError(405, "method_not_allowed");
  }

  if (request.method === "GET" && pathname === "/v1/admin/tenants") return listAdminTenants(request, env);

  // Known public paths with wrong method used to fall through to resolveAuth →
  // misleading authentication_required (e.g. GET /v1/auth/login).
  if (
    pathname === "/health"
    || pathname === "/v1/source-health"
    || pathname === "/v1/auth/signup"
    || pathname === "/v1/auth/login"
    || pathname === "/v1/billing/webhook"
    || pathname === "/v1/queries/validate"
  ) {
    throw new HttpError(405, "method_not_allowed");
  }

  const auth = await resolveAuth(request, env);
  if (request.method === "POST" && pathname === "/v1/auth/logout") return logout(request, env);
  if (request.method === "GET" && pathname === "/v1/me") return json({ user: { id: auth.userId, email: auth.email, globalRole: auth.globalRole } });
  if (request.method === "GET" && pathname === "/v1/workspaces") return listWorkspaces(auth, env);
  if (request.method === "POST" && pathname === "/v1/workspaces") return createWorkspace(request, auth, env);
  if (request.method === "GET" && pathname === "/v1/admin/source-health") {
    if (auth.globalRole !== "super_admin") throw new HttpError(403, "forbidden");
    return json(sourceHealthSnapshot());
  }

  let match = pathMatch(pathname, /^\/v1\/workspaces\/([^/]+)$/);
  if (match && request.method === "GET") return workspaceDetails(auth, env, match[1] ?? "");

  match = pathMatch(pathname, /^\/v1\/workspaces\/([^/]+)\/monitors$/);
  if (match && request.method === "GET") return listMonitors(auth, env, match[1] ?? "");
  if (match && request.method === "POST") return createMonitor(request, auth, env, match[1] ?? "");

  match = pathMatch(pathname, /^\/v1\/workspaces\/([^/]+)\/monitors\/([^/]+)$/);
  if (match && request.method === "GET") return getMonitor(auth, env, match[1] ?? "", match[2] ?? "");
  if (match && request.method === "PATCH") return updateMonitor(request, auth, env, match[1] ?? "", match[2] ?? "");
  if (match && request.method === "DELETE") return deleteMonitor(auth, env, match[1] ?? "", match[2] ?? "");

  match = pathMatch(pathname, /^\/v1\/workspaces\/([^/]+)\/monitors\/([^/]+)\/queries$/);
  if (match && request.method === "GET") return listQueries(auth, env, match[1] ?? "", match[2] ?? "");
  if (match && request.method === "POST") return createQuery(request, auth, env, match[1] ?? "", match[2] ?? "");

  match = pathMatch(pathname, /^\/v1\/workspaces\/([^/]+)\/monitors\/([^/]+)\/queries\/([^/]+)$/);
  if (match && request.method === "PATCH") return updateQuery(request, auth, env, match[1] ?? "", match[2] ?? "", match[3] ?? "");
  if (match && request.method === "DELETE") return deleteQuery(auth, env, match[1] ?? "", match[2] ?? "", match[3] ?? "");
  match = pathMatch(pathname, /^\/v1\/workspaces\/([^/]+)\/monitors\/([^/]+)\/mentions$/);
  if (match && request.method === "GET") return listMentions(request, auth, env, match[1] ?? "", match[2] ?? "");

  match = pathMatch(pathname, /^\/v1\/workspaces\/([^/]+)\/monitors\/([^/]+)\/mentions\/([^/]+)$/);
  if (match && request.method === "GET") return getMentionDetail(auth, env, match[1] ?? "", match[2] ?? "", match[3] ?? "");

  match = pathMatch(pathname, /^\/v1\/workspaces\/([^/]+)\/monitors\/([^/]+)\/mentions\/([^/]+)\/feedback$/);
  if (match && request.method === "POST") return addMentionFeedback(request, auth, env, match[1] ?? "", match[2] ?? "", match[3] ?? "");

  match = pathMatch(pathname, /^\/v1\/workspaces\/([^/]+)\/monitors\/([^/]+)\/alerts$/);
  if (match && request.method === "GET") return listAlerts(request, auth, env, match[1] ?? "", match[2] ?? "");

  match = pathMatch(pathname, /^\/v1\/workspaces\/([^/]+)\/monitors\/([^/]+)\/alerts\/([^/]+)$/);
  if (match && request.method === "PATCH") return patchAlert(request, auth, env, match[1] ?? "", match[2] ?? "", match[3] ?? "");

  match = pathMatch(pathname, /^\/v1\/workspaces\/([^/]+)\/billing\/checkout$/);
  if (match && request.method === "POST") return createBillingCheckout(request, auth, env, match[1] ?? "");

  return errorResponse("not_found", 404, context.requestId);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    const context: RouteContext = { requestId, url: requestUrlForRouting(request) };
    try {
      if (request.method === "OPTIONS") return corsPreflight(request, env);
      const response = await route(request, env, context);
      response.headers.set("x-request-id", requestId);
      return withCors(response, request, env);
    } catch (error) {
      const httpError = error instanceof HttpError ? error : new HttpError(500, "internal_error");
      structuredLog(httpError.status >= 500 ? "error" : "warn", httpError.message, { requestId, route: context.url.pathname }, {
        status: httpError.status,
        errorType: error instanceof Error ? error.name : "unknown"
      });
      const headers: Record<string, string> = { ...httpError.headers };
      if (httpError.status === 401) {
        headers["WWW-Authenticate"] = `Bearer realm="PulseWatch", resource_metadata="${protectedResourceMetadataUrl(request)}"`;
      }
      return withCors(errorResponse(httpError.message, httpError.status, requestId, headers), request, env);
    }
  }
};
