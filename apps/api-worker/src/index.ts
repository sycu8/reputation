import { hasCapability, isSuperAdminEmail, type Capability } from "../../../packages/auth/src/index.ts";
import { normalizeBooleanQuery, parseBooleanQuery } from "../../../packages/boolean-query/src/index.ts";
import { monitorLimitFor } from "../../../packages/auth/src/entitlements.ts";
import { createBillingProvider, planFromPriceId } from "../../../packages/billing/src/index.ts";
import { schedulerShardIndex } from "../../../packages/crawler-core/src/index.ts";
import { SOURCE_CAPABILITY_DEFAULTS } from "../../../packages/source-adapters/src/index.ts";
import type { AuthContext, GlobalRole, MonitorType, WorkspaceRole } from "../../../packages/types/src/index.ts";
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

function errorResponse(error: string, status: number, requestId: string): Response {
  return json({ error, requestId }, status);
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

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
  return json(
    {
      user: { id: account.userId, email: account.email, globalRole: account.globalRole },
      workspace: { id: workspaceId, name: workspaceName, role: "owner" },
      session: { token: cookieValue, expiresAt: account.expiresAt }
    },
    201,
    { "set-cookie": sessionCookie(cookieName, cookieValue, account.expiresAt, useSecureCookies(env)) }
  );
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const email = asString(body.email, "email").toLowerCase();
  const password = asString(body.password, "password");
  const shard = await shardForEmail(email);
  const account = await doJson<{ userId: string; email: string; globalRole: GlobalRole; sessionId: string; sessionSecret: string; expiresAt: string }>(
    userStub(env, shard),
    "/internal/login",
    { method: "POST", body: JSON.stringify({ email, password }) }
  );
  const globalRole = await syncSuperAdminRole(env, shard, account.email, account.globalRole);
  const cookieValue = `${shard}.${account.sessionId}.${account.sessionSecret}`;
  return json(
    {
      user: { id: account.userId, email: account.email, globalRole },
      session: { token: cookieValue, expiresAt: account.expiresAt }
    },
    200,
    { "set-cookie": sessionCookie(env.SESSION_COOKIE_NAME ?? COOKIE_DEFAULT, cookieValue, account.expiresAt, useSecureCookies(env)) }
  );
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

  await doJson(tenantStub(env, workspaceId), "/internal/monitors", {
    method: "POST",
    body: JSON.stringify({ actorUserId: auth.userId, monitorId, name, type, status: "active", priority, nextScanAt })
  });
  try {
    const data = await doJson(monitorStub(env, workspaceId, monitorId), "/internal/init", {
      method: "POST",
      body: JSON.stringify({ id: monitorId, tenantId: workspaceId, name, type, scanIntervalSec, alertThreshold, defaultLanguage, nextScanAt })
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
      nextScanAt: updated.monitor.nextScanAt
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

async function listAdminTenants(auth: AuthContext, env: Env): Promise<Response> {
  if (auth.globalRole !== "super_admin") throw new HttpError(403, "forbidden");
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
  if (request.method === "GET" && pathname === "/v1/admin/tenants") return listAdminTenants(auth, env);
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
      return withCors(errorResponse(httpError.message, httpError.status, requestId), request, env);
    }
  }
};
