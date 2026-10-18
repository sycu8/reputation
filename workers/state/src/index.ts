import { advanceNextScanAt, browserPoolCap, BROWSER_POOL_LEASE_TTL_MS, claimLeaseUntil, isClaimable } from "../../../packages/crawler-core/src/index.ts";
import { hammingDistance64, simHashFromHex } from "../../../packages/dedupe/src/index.ts";
import { structuredLog } from "../../../packages/observability/src/index.ts";
import type { GlobalRole, MonitorProfile, MonitorRecord, MonitorStatus, MonitorType, QueryRecord, WorkspaceRole } from "../../../packages/types/src/index.ts";
import { normalizeMonitorProfile, parseMonitorProfileJson } from "../../../packages/types/src/index.ts";

interface Env {
  BROWSER_POOL_DO?: DurableObjectNamespace;
  BROWSER_POOL_RESET_TOKEN?: string;
  BROWSER_POOL_MAX?: string;
  /** Test override for the per-tenant park cap. Production leaves this unset (1024). */
  DOMAIN_PARK_CAP?: string;
  /** Test clock for park expiry. Production leaves this unset. */
  nowMs?: () => number;
}

function hasColumn(sql: SqlStorage, table: string, column: string): boolean {
  const cols = rows(sql.exec<{ name: string }>(`PRAGMA table_info(${table})`));
  return cols.some((item) => item.name === column);
}

function ensureColumn(sql: SqlStorage, table: string, column: string, definition: string): void {
  if (!hasColumn(sql, table, column)) {
    sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

type Json = Record<string, unknown>;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function readJson(request: Request): Promise<Json> {
  try {
    return (await request.json()) as Json;
  } catch {
    throw new Error("invalid_json");
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromB64url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return b64url(new Uint8Array(digest));
}

// Cloudflare Workers Web Crypto rejects PBKDF2 iteration counts above 100_000.
const PASSWORD_ITERATIONS = 100_000;
const MAX_PASSWORD_ITERATIONS = 100_000;

async function derivePassword(password: string, salt: Uint8Array, iterations = PASSWORD_ITERATIONS): Promise<string> {
  if (!Number.isFinite(iterations) || iterations < 1) throw new Error("invalid_password_iterations");
  if (iterations > MAX_PASSWORD_ITERATIONS) {
    throw new Error("password_iterations_unsupported_on_workers");
  }
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const saltBuffer = salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer;
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBuffer, iterations },
    material,
    256
  );
  return b64url(new Uint8Array(bits));
}

function constantTimeEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i += 1) diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

function randomSecret(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return b64url(value);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`invalid_${field}`);
  return value.trim();
}

function rows<T>(cursor: SqlStorageCursor<T>): T[] {
  return cursor.toArray();
}

abstract class SqliteObject {
  protected readonly state: DurableObjectState;
  protected readonly env: Env;
  protected readonly sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
  }
}

export class UserDirectoryDO extends SqliteObject {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS user_account (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_iterations INTEGER NOT NULL,
      global_role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      last_seen_at TEXT NOT NULL,
      auth_strength TEXT NOT NULL DEFAULT 'password'
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS memberships (
      workspace_id TEXT PRIMARY KEY,
      workspace_name TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY, actor_user_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL,
      target_id TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_audit_events_time ON audit_events(created_at DESC)`);
    this.sql.exec(`INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('version', '1')`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/internal/signup") return await this.signup(request);
      if (request.method === "POST" && url.pathname === "/internal/login") return await this.login(request);
      if (request.method === "POST" && url.pathname === "/internal/session/verify") return await this.verifySession(request);
      if (request.method === "POST" && url.pathname === "/internal/session/revoke") return await this.revokeSession(request);
      if (request.method === "POST" && url.pathname === "/internal/global-role") return await this.setGlobalRole(request);
      if (request.method === "POST" && url.pathname === "/internal/memberships") return await this.upsertMembership(request);
      if (request.method === "GET" && url.pathname === "/internal/memberships") return this.listMemberships();
      if (request.method === "POST" && url.pathname === "/internal/account/reset-password") return await this.resetPassword(request);
      if (request.method === "POST" && url.pathname === "/internal/account/lock") return await this.lockAccount(request);
      if (request.method === "POST" && url.pathname === "/internal/account/audit-denied") return await this.auditDenied(request);
      if (request.method === "GET" && url.pathname === "/internal/account/audit") return this.listAccountAudit(request);
      return json({ error: "not_found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal_error";
      return json({ error: message }, message.startsWith("invalid_") ? 400 : 500);
    }
  }

  private async signup(request: Request): Promise<Response> {
    const body = await readJson(request);
    const email = asString(body.email, "email").toLowerCase();
    const password = asString(body.password, "password");
    const globalRole = body.globalRole === "super_admin" ? "super_admin" : "user";
    if (password.length < 10) return json({ error: "password_too_short" }, 400);

    const existing = rows(this.sql.exec<{ id: string }>(`SELECT id FROM user_account LIMIT 1`));
    if (existing.length) return json({ error: "account_exists" }, 409);

    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    const passwordHash = await derivePassword(password, salt);
    const userId = crypto.randomUUID();
    const ts = nowIso();
    this.sql.exec(
      `INSERT INTO user_account(id,email,password_hash,password_salt,password_iterations,global_role,status,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      userId, email, passwordHash, b64url(salt), PASSWORD_ITERATIONS, globalRole, "active", ts, ts
    );
    const session = await this.createSession();
    return json({ userId, email, globalRole, ...session }, 201);
  }

  private async login(request: Request): Promise<Response> {
    const body = await readJson(request);
    const email = asString(body.email, "email").toLowerCase();
    const password = asString(body.password, "password");
    const records = rows(this.sql.exec<{
      id: string; email: string; password_hash: string; password_salt: string;
      password_iterations: number; global_role: GlobalRole; status: string;
    }>(`SELECT id,email,password_hash,password_salt,password_iterations,global_role,status FROM user_account LIMIT 1`));
    const account = records[0];
    if (!account || account.email !== email || account.status !== "active") return json({ error: "invalid_credentials" }, 401);
    const derived = await derivePassword(password, fromB64url(account.password_salt), account.password_iterations);
    if (!constantTimeEqual(derived, account.password_hash)) return json({ error: "invalid_credentials" }, 401);
    const session = await this.createSession();
    return json({ userId: account.id, email: account.email, globalRole: account.global_role, ...session });
  }

  private async createSession(): Promise<{ sessionId: string; sessionSecret: string; expiresAt: string }> {
    const sessionId = crypto.randomUUID();
    const sessionSecret = randomSecret();
    const secretHash = await sha256(sessionSecret);
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    this.sql.exec(
      `INSERT INTO sessions(id,secret_hash,created_at,expires_at,last_seen_at,auth_strength) VALUES(?,?,?,?,?,?)`,
      sessionId, secretHash, createdAt, expiresAt, createdAt, "password"
    );
    return { sessionId, sessionSecret, expiresAt };
  }

  private async verifySession(request: Request): Promise<Response> {
    const body = await readJson(request);
    const sessionId = asString(body.sessionId, "session_id");
    const sessionSecret = asString(body.sessionSecret, "session_secret");
    const sessions = rows(this.sql.exec<{
      id: string; secret_hash: string; expires_at: string; revoked_at: string | null;
    }>(`SELECT id,secret_hash,expires_at,revoked_at FROM sessions WHERE id = ? LIMIT 1`, sessionId));
    const session = sessions[0];
    if (!session || session.revoked_at || Date.parse(session.expires_at) <= Date.now()) return json({ error: "invalid_session" }, 401);
    if (!constantTimeEqual(await sha256(sessionSecret), session.secret_hash)) return json({ error: "invalid_session" }, 401);
    const accounts = rows(this.sql.exec<{ id: string; email: string; global_role: GlobalRole; status: string }>(
      `SELECT id,email,global_role,status FROM user_account LIMIT 1`
    ));
    const account = accounts[0];
    if (!account || account.status !== "active") return json({ error: "invalid_session" }, 401);
    this.sql.exec(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`, nowIso(), sessionId);
    return json({ userId: account.id, email: account.email, globalRole: account.global_role, sessionId });
  }

  private async revokeSession(request: Request): Promise<Response> {
    const body = await readJson(request);
    const sessionId = asString(body.sessionId, "session_id");
    this.sql.exec(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, nowIso(), sessionId);
    return json({ ok: true });
  }

  private async setGlobalRole(request: Request): Promise<Response> {
    const body = await readJson(request);
    const globalRole = body.globalRole === "super_admin" ? "super_admin" : "user";
    const accounts = rows(this.sql.exec<{ id: string; email: string; global_role: GlobalRole; status: string }>(
      `SELECT id,email,global_role,status FROM user_account LIMIT 1`
    ));
    const account = accounts[0];
    if (!account || account.status !== "active") return json({ error: "account_not_found" }, 404);
    if (account.global_role !== globalRole) {
      this.sql.exec(`UPDATE user_account SET global_role = ?, updated_at = ? WHERE id = ?`, globalRole, nowIso(), account.id);
    }
    return json({ userId: account.id, email: account.email, globalRole });
  }

  private async upsertMembership(request: Request): Promise<Response> {
    const body = await readJson(request);
    const workspaceId = asString(body.workspaceId, "workspace_id");
    const workspaceName = asString(body.workspaceName, "workspace_name");
    const role = asString(body.role, "role") as WorkspaceRole;
    const ts = nowIso();
    this.sql.exec(
      `INSERT INTO memberships(workspace_id,workspace_name,role,created_at,updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(workspace_id) DO UPDATE SET workspace_name=excluded.workspace_name, role=excluded.role, updated_at=excluded.updated_at`,
      workspaceId, workspaceName, role, ts, ts
    );
    return json({ ok: true });
  }

  private listMemberships(): Response {
    const memberships = rows(this.sql.exec<{ workspace_id: string; workspace_name: string; role: WorkspaceRole }>(
      `SELECT workspace_id,workspace_name,role FROM memberships ORDER BY created_at ASC`
    )).map((item) => ({ workspaceId: item.workspace_id, workspaceName: item.workspace_name, role: item.role }));
    return json({ memberships });
  }

  private loadAccount(email: string): { id: string; email: string; global_role: GlobalRole; status: string } | null {
    const account = rows(this.sql.exec<{ id: string; email: string; global_role: GlobalRole; status: string }>(
      `SELECT id,email,global_role,status FROM user_account LIMIT 1`
    ))[0];
    if (!account || account.email !== email) return null;
    return account;
  }

  private revokeOpenSessions(): number {
    const open = rows(this.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL`
    ))[0];
    const sessionsRevoked = Number(open?.n ?? 0);
    if (sessionsRevoked > 0) {
      this.sql.exec(`UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL`, nowIso());
    }
    return sessionsRevoked;
  }

  private auditAccount(actorUserId: string, action: string, targetId: string, metadata: Record<string, unknown>): void {
    this.sql.exec(
      `INSERT INTO audit_events(id,actor_user_id,action,target_type,target_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)`,
      crypto.randomUUID(), actorUserId, action, "user", targetId, JSON.stringify(metadata), nowIso()
    );
  }

  /**
   * Caps denial audit writes for one user on this account.
   * The stored actor is `{userId}:{cf-ray}`; the cap uses userId only, because every
   * production request has a distinct cf-ray. Password reset and lock do not consult it.
   */
  private recentDenialsForUser(actorUserId: string): number {
    const userId = actorUserId.split(":", 1)[0] ?? actorUserId;
    const since = new Date(Date.now() - 60_000).toISOString();
    const row = rows(this.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events
       WHERE created_at >= ?
         AND action IN ('account.password_reset_denied','account.lock_denied')
         AND (actor_user_id = ? OR substr(actor_user_id, 1, length(?) + 1) = (? || ':'))`,
      since,
      userId,
      userId,
      userId
    ))[0];
    return Number(row?.n ?? 0);
  }

  private async resetPassword(request: Request): Promise<Response> {
    const body = await readJson(request);
    const email = asString(body.email, "email").toLowerCase();
    const password = asString(body.password, "password");
    const actorUserId = asString(body.actorUserId, "actor_user_id");
    if (password.length < 10) return json({ error: "password_too_short" }, 400);
    const account = this.loadAccount(email);
    if (!account) return json({ error: "account_not_found" }, 404);
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    const passwordHash = await derivePassword(password, salt);
    const updatedAt = nowIso();
    const sessionsRevoked = await this.state.storage.transaction(async () => {
      this.sql.exec(
        `UPDATE user_account SET password_hash=?, password_salt=?, password_iterations=?, updated_at=? WHERE id=?`,
        passwordHash, b64url(salt), PASSWORD_ITERATIONS, updatedAt, account.id
      );
      const revoked = this.revokeOpenSessions();
      this.auditAccount(actorUserId, "account.password_reset", account.id, {
        email: account.email,
        sessionsRevoked: revoked
      });
      return revoked;
    });
    return json({
      ok: true,
      userId: account.id,
      email: account.email,
      status: account.status,
      sessionsRevoked
    });
  }

  private async lockAccount(request: Request): Promise<Response> {
    const body = await readJson(request);
    const email = asString(body.email, "email").toLowerCase();
    const actorUserId = asString(body.actorUserId, "actor_user_id");
    const requested = typeof body.status === "string" ? body.status.trim() : "";
    const status = requested || "suspended";
    if (status !== "suspended" && status !== "deleted") return json({ error: "invalid_status" }, 400);
    const account = this.loadAccount(email);
    if (!account) return json({ error: "account_not_found" }, 404);
    const updatedAt = nowIso();
    const sessionsRevoked = await this.state.storage.transaction(async () => {
      this.sql.exec(`UPDATE user_account SET status=?, updated_at=? WHERE id=?`, status, updatedAt, account.id);
      const revoked = this.revokeOpenSessions();
      this.auditAccount(actorUserId, "account.lock", account.id, {
        email: account.email,
        status,
        sessionsRevoked: revoked
      });
      return revoked;
    });
    return json({ ok: true, userId: account.id, email: account.email, status, sessionsRevoked });
  }

  private async auditDenied(request: Request): Promise<Response> {
    const body = await readJson(request);
    const email = asString(body.email, "email").toLowerCase();
    const actorUserId = asString(body.actorUserId, "actor_user_id");
    const action = body.action === "account.lock_denied" ? "account.lock_denied" : "account.password_reset_denied";
    const account = this.loadAccount(email);
    if (!account) return json({ error: "account_not_found" }, 404);
    if (this.recentDenialsForUser(actorUserId) >= 8) return json({ error: "rate_limited" }, 429);
    this.auditAccount(actorUserId, action, account.id, { email: account.email, result: "denied" });
    return json({ ok: true });
  }

  private listAccountAudit(request: Request): Response {
    const requested = new URL(request.url).searchParams.get("action");
    if (requested && requested !== "mutations" && requested !== "account.password_reset" && requested !== "account.lock" && requested !== "account.password_reset_denied" && requested !== "account.lock_denied") {
      return json({ error: "invalid_audit_action" }, 400);
    }
    const events = this.selectAuditEvents(requested);
    if (requested) return json({ action: requested, events });
    return json({
      events,
      mutations: this.selectAuditEvents("mutations")
    });
  }

  /** Reset and lock are queried on their own so denial rows cannot push them out of the newest 50. */
  private selectAuditEvents(action: string | null): Array<{
    id: string;
    actorUserId: string;
    action: string;
    targetType: string;
    targetId: string;
    metadata: Record<string, unknown>;
    createdAt: string;
  }> {
    const query = action === "mutations"
      ? `SELECT id,actor_user_id,action,target_type,target_id,metadata_json,created_at FROM audit_events WHERE action IN ('account.password_reset','account.lock') ORDER BY created_at DESC LIMIT 50`
      : action
        ? `SELECT id,actor_user_id,action,target_type,target_id,metadata_json,created_at FROM audit_events WHERE action = ? ORDER BY created_at DESC LIMIT 50`
        : `SELECT id,actor_user_id,action,target_type,target_id,metadata_json,created_at FROM audit_events ORDER BY created_at DESC LIMIT 50`;
    const events = rows(this.sql.exec<{
      id: string;
      actor_user_id: string;
      action: string;
      target_type: string;
      target_id: string;
      metadata_json: string;
      created_at: string;
    }>(query, ...(action && action !== "mutations" ? [action] : [])));
    return events.map((event) => ({
      id: event.id,
      actorUserId: event.actor_user_id,
      action: event.action,
      targetType: event.target_type,
      targetId: event.target_id,
      metadata: JSON.parse(event.metadata_json) as Record<string, unknown>,
      createdAt: event.created_at
    }));
  }
}

export class TenantDirectoryDO extends SqliteObject {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS memberships (
      user_id TEXT PRIMARY KEY, role TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS monitor_directory (
      monitor_id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal', next_scan_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    ensureColumn(this.sql, "monitor_directory", "profile_json", "TEXT");
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_monitor_directory_next_scan ON monitor_directory(next_scan_at, status)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY, actor_user_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL,
      target_id TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_audit_events_time ON audit_events(created_at DESC)`);
    this.sql.exec(`INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('version', '1')`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/internal/init") return await this.initTenant(request);
      if (request.method === "GET" && url.pathname === "/internal/workspace") return this.getWorkspace();
      if (request.method === "GET" && url.pathname.startsWith("/internal/memberships/")) return this.getMembership(url.pathname.split("/").pop() ?? "");
      if (request.method === "POST" && url.pathname === "/internal/memberships") return await this.upsertMembership(request);
      if (request.method === "GET" && url.pathname === "/internal/monitors") return this.listMonitors();
      if (request.method === "POST" && url.pathname === "/internal/monitors") return await this.createMonitorEntry(request);
      if (request.method === "PATCH" && url.pathname.startsWith("/internal/monitors/")) return await this.updateMonitorEntry(request, url.pathname.split("/").pop() ?? "");
      if (request.method === "DELETE" && url.pathname.startsWith("/internal/monitors/")) return await this.deleteMonitorEntry(request, url.pathname.split("/").pop() ?? "");
      if (request.method === "GET" && url.pathname === "/internal/audit") return this.listAudit();
      if (request.method === "PATCH" && url.pathname === "/internal/workspace/plan") return await this.patchPlan(request);
      return json({ error: "not_found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal_error";
      return json({ error: message }, message.startsWith("invalid_") ? 400 : 500);
    }
  }

  private async initTenant(request: Request): Promise<Response> {
    const body = await readJson(request);
    const id = asString(body.id, "tenant_id");
    const name = asString(body.name, "tenant_name");
    const ownerUserId = asString(body.ownerUserId, "owner_user_id");
    const ts = nowIso();
    const plan = typeof body.plan === "string" && body.plan.trim() ? body.plan.trim() : "free";
    const allowedPlans = new Set(["free", "starter", "pro", "business"]);
    if (!allowedPlans.has(plan)) return json({ error: "invalid_plan" }, 400);
    this.sql.exec(`INSERT OR IGNORE INTO tenants(id,name,plan,status,created_at,updated_at) VALUES(?,?,?,?,?,?)`, id, name, plan, "active", ts, ts);
    this.sql.exec(
      `INSERT INTO memberships(user_id,role,created_at,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET role=excluded.role, updated_at=excluded.updated_at`,
      ownerUserId, "owner", ts, ts
    );
    this.audit(ownerUserId, "workspace.create", "workspace", id, { name, plan });
    return json({ id, name, plan, status: "active" }, 201);
  }

  private getWorkspace(): Response {
    const workspace = rows(this.sql.exec<{ id: string; name: string; plan: string; status: string; created_at: string; updated_at: string }>(
      `SELECT id,name,plan,status,created_at,updated_at FROM tenants LIMIT 1`
    ))[0];
    return workspace ? json({ workspace }) : json({ error: "workspace_not_initialized" }, 404);
  }

  private getMembership(userId: string): Response {
    if (!userId) return json({ error: "invalid_user_id" }, 400);
    const membership = rows(this.sql.exec<{ user_id: string; role: WorkspaceRole }>(
      `SELECT user_id,role FROM memberships WHERE user_id = ? LIMIT 1`, userId
    ))[0];
    return membership ? json({ membership: { userId: membership.user_id, role: membership.role } }) : json({ error: "membership_not_found" }, 404);
  }

  private async upsertMembership(request: Request): Promise<Response> {
    const body = await readJson(request);
    const actorUserId = asString(body.actorUserId, "actor_user_id");
    const userId = asString(body.userId, "user_id");
    const role = asString(body.role, "role");
    const ts = nowIso();
    this.sql.exec(
      `INSERT INTO memberships(user_id,role,created_at,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET role=excluded.role, updated_at=excluded.updated_at`,
      userId, role, ts, ts
    );
    this.audit(actorUserId, "membership.upsert", "membership", userId, { role });
    return json({ ok: true });
  }

  private listMonitors(): Response {
    const monitors = rows(this.sql.exec<Record<string, unknown>>(
      `SELECT monitor_id,name,type,status,priority,next_scan_at,profile_json,created_at,updated_at FROM monitor_directory ORDER BY created_at DESC`
    )).map((row) => ({
      monitor_id: row.monitor_id,
      name: row.name,
      type: row.type,
      status: row.status,
      priority: row.priority,
      next_scan_at: row.next_scan_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      profile: parseMonitorProfileJson(typeof row.profile_json === "string" ? row.profile_json : null)
    }));
    return json({ monitors });
  }

  private async createMonitorEntry(request: Request): Promise<Response> {
    const body = await readJson(request);
    const actorUserId = asString(body.actorUserId, "actor_user_id");
    const monitorId = asString(body.monitorId, "monitor_id");
    const name = asString(body.name, "monitor_name");
    const type = asString(body.type, "monitor_type");
    const status = body.status === "paused" ? "paused" : "active";
    const priority = typeof body.priority === "string" && body.priority.trim() ? body.priority.trim() : "normal";
    const nextScanAt = typeof body.nextScanAt === "string" && body.nextScanAt.trim() ? body.nextScanAt.trim() : null;
    const profile = normalizeMonitorProfile(body.profile);
    const profileJson = JSON.stringify(profile);
    const ts = nowIso();
    this.sql.exec(
      `INSERT INTO monitor_directory(monitor_id,name,type,status,priority,next_scan_at,profile_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      monitorId, name, type, status, priority, nextScanAt, profileJson, ts, ts
    );
    this.audit(actorUserId, "monitor.create", "monitor", monitorId, { name, type, nextScanAt, profile });
    return json({ ok: true }, 201);
  }

  private async updateMonitorEntry(request: Request, monitorId: string): Promise<Response> {
    const body = await readJson(request);
    const actorUserId = asString(body.actorUserId, "actor_user_id");
    const current = rows(this.sql.exec<{ name: string; type: string; status: string; priority: string; next_scan_at: string | null; profile_json: string | null }>(
      `SELECT name,type,status,priority,next_scan_at,profile_json FROM monitor_directory WHERE monitor_id = ? LIMIT 1`, monitorId
    ))[0];
    if (!current) return json({ error: "monitor_not_found" }, 404);
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : current.name;
    const type = typeof body.type === "string" && body.type.trim() ? body.type.trim() : current.type;
    const status = body.status === "paused" || body.status === "archived" || body.status === "active" ? body.status : current.status;
    const priority = typeof body.priority === "string" && body.priority.trim() ? body.priority.trim() : current.priority;
    const nextScanAt = typeof body.nextScanAt === "string" && body.nextScanAt.trim()
      ? body.nextScanAt.trim()
      : body.nextScanAt === null
        ? null
        : current.next_scan_at;
    const profile = body.profile !== undefined
      ? normalizeMonitorProfile(body.profile)
      : parseMonitorProfileJson(current.profile_json);
    const profileJson = JSON.stringify(profile);
    this.sql.exec(
      `UPDATE monitor_directory SET name=?,type=?,status=?,priority=?,next_scan_at=?,profile_json=?,updated_at=? WHERE monitor_id=?`,
      name, type, status, priority, nextScanAt, profileJson, nowIso(), monitorId
    );
    this.audit(actorUserId, "monitor.update", "monitor", monitorId, { name, type, status, priority, nextScanAt, profile });
    return json({ ok: true });
  }

  private async deleteMonitorEntry(request: Request, monitorId: string): Promise<Response> {
    const body = await readJson(request);
    const actorUserId = asString(body.actorUserId, "actor_user_id");
    this.sql.exec(`DELETE FROM monitor_directory WHERE monitor_id = ?`, monitorId);
    this.audit(actorUserId, "monitor.delete", "monitor", monitorId, {});
    return json({ ok: true });
  }

  private audit(actorUserId: string, action: string, targetType: string, targetId: string, metadata: Record<string, unknown>): void {
    this.sql.exec(
      `INSERT INTO audit_events(id,actor_user_id,action,target_type,target_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)`,
      crypto.randomUUID(), actorUserId, action, targetType, targetId, JSON.stringify(metadata), nowIso()
    );
  }

  private listAudit(): Response {
    const events = rows(this.sql.exec<Record<string, unknown>>(
      `SELECT id,actor_user_id,action,target_type,target_id,metadata_json,created_at FROM audit_events ORDER BY created_at DESC LIMIT 200`
    ));
    return json({ events });
  }

  private async patchPlan(request: Request): Promise<Response> {
    const body = await readJson(request);
    const plan = asString(body.plan, "plan");
    const actorUserId = asString(body.actorUserId, "actor_user_id");
    const allowed = new Set(["free", "starter", "pro", "business"]);
    if (!allowed.has(plan)) return json({ error: "invalid_plan" }, 400);
    const workspace = rows(this.sql.exec<{ id: string; plan: string }>(`SELECT id,plan FROM tenants LIMIT 1`))[0];
    if (!workspace) return json({ error: "workspace_not_initialized" }, 404);
    const previous = workspace.plan;
    this.sql.exec(`UPDATE tenants SET plan=?, updated_at=? WHERE id=?`, plan, nowIso(), workspace.id);
    this.audit(actorUserId, "workspace.plan_update", "workspace", workspace.id, { previous, plan });
    return json({ ok: true, plan, previous });
  }
}

export class MonitorDO extends SqliteObject {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS monitor (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
      default_language TEXT, scan_interval_sec INTEGER NOT NULL, alert_threshold INTEGER NOT NULL DEFAULT 60,
      next_scan_at TEXT, last_scan_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    ensureColumn(this.sql, "monitor", "next_scan_at", "TEXT");
    ensureColumn(this.sql, "monitor", "last_scan_at", "TEXT");
    ensureColumn(this.sql, "monitor", "profile_json", "TEXT");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS queries (
      id TEXT PRIMARY KEY, raw_query TEXT NOT NULL, normalized_query TEXT NOT NULL, ast_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS mentions (
      id TEXT PRIMARY KEY, content_id TEXT NOT NULL, canonical_url TEXT, source TEXT NOT NULL, source_native_id TEXT,
      author_name TEXT, author_url TEXT, title TEXT, excerpt TEXT, published_at TEXT, discovered_at TEXT NOT NULL,
      relevance_score REAL NOT NULL, sentiment TEXT NOT NULL, sentiment_confidence REAL NOT NULL, severity_score REAL NOT NULL,
      topic TEXT, language TEXT, engagement_score REAL, raw_r2_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    ensureColumn(this.sql, "mentions", "simhash", "TEXT");
    ensureColumn(this.sql, "mentions", "story_cluster_id", "TEXT");
    this.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mentions_content_id ON mentions(content_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_mentions_discovered ON mentions(discovered_at DESC)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_mentions_sentiment ON mentions(sentiment, discovered_at DESC)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_mentions_severity ON mentions(severity_score DESC, discovered_at DESC)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_mentions_story_cluster ON mentions(story_cluster_id, discovered_at DESC)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS mention_analysis (
      mention_id TEXT PRIMARY KEY, relevance_reason TEXT, sentiment_reason TEXT, severity_reason TEXT,
      risk_categories_json TEXT, ai_model TEXT, ai_version TEXT, analyzed_at TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY, mention_id TEXT NOT NULL, user_id TEXT NOT NULL, action TEXT NOT NULL, previous_value TEXT, new_value TEXT, created_at TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_mention ON feedback(mention_id, created_at DESC)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY, mention_id TEXT, type TEXT NOT NULL, severity TEXT NOT NULL, state TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE, reason TEXT, created_at TEXT NOT NULL, sent_at TEXT, acknowledged_at TEXT, resolved_at TEXT
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS alert_deliveries (
      id TEXT PRIMARY KEY,
      alert_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_ref TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(alert_id, channel)
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_alert_deliveries_alert ON alert_deliveries(alert_id, updated_at DESC)`);
    this.sql.exec(`INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('version', '4')`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/internal/init") return await this.init(request);
      if (request.method === "GET" && url.pathname === "/internal/monitor") return this.getMonitor();
      if (request.method === "PATCH" && url.pathname === "/internal/monitor") return await this.patchMonitor(request);
      if (request.method === "DELETE" && url.pathname === "/internal/monitor") return this.archiveMonitor();
      if (request.method === "GET" && url.pathname === "/internal/queries") return this.listQueries();
      if (request.method === "POST" && url.pathname === "/internal/queries") return await this.createQuery(request);
      if (url.pathname.startsWith("/internal/queries/")) {
        const queryId = url.pathname.split("/").pop() ?? "";
        if (request.method === "PATCH") return await this.patchQuery(request, queryId);
        if (request.method === "DELETE") return this.deleteQuery(queryId);
      }
      if (request.method === "GET" && url.pathname === "/internal/mentions") return this.listMentions(url);
      if (request.method === "POST" && url.pathname === "/internal/mentions/upsert") return await this.upsertMention(request);
      if (request.method === "GET" && url.pathname === "/internal/mentions/near-dupes") return this.nearDupes(url);
      if (request.method === "GET" && url.pathname.startsWith("/internal/mentions/exists/")) return this.mentionExists(url.pathname.split("/").pop() ?? "");
      if (request.method === "GET" && url.pathname.startsWith("/internal/mentions/")) return this.getMention(url.pathname.split("/").pop() ?? "");
      if (request.method === "POST" && url.pathname === "/internal/feedback") return await this.addFeedback(request);
      if (request.method === "POST" && url.pathname === "/internal/alerts/upsert") return await this.upsertAlert(request);
      if (request.method === "POST" && url.pathname === "/internal/alerts/deliveries/upsert") return await this.upsertAlertDelivery(request);
      if (request.method === "GET" && url.pathname === "/internal/alerts") return this.listAlerts(url);
      {
        const deliveryMatch = url.pathname.match(/^\/internal\/alerts\/([^/]+)\/deliveries$/);
        if (deliveryMatch && request.method === "GET") return this.listAlertDeliveries(deliveryMatch[1] ?? "");
      }
      {
        const alertMatch = url.pathname.match(/^\/internal\/alerts\/([^/]+)$/);
        if (alertMatch && request.method === "GET") return this.getAlert(alertMatch[1] ?? "");
        if (alertMatch && request.method === "PATCH") return await this.patchAlert(request, alertMatch[1] ?? "");
      }
      if (request.method === "POST" && url.pathname === "/internal/schedule/claim-advance") return await this.claimAdvance(request);
      return json({ error: "not_found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal_error";
      return json({ error: message }, message.startsWith("invalid_") ? 400 : 500);
    }
  }

  private async init(request: Request): Promise<Response> {
    const body = await readJson(request);
    const id = asString(body.id, "monitor_id");
    const tenantId = asString(body.tenantId, "tenant_id");
    const name = asString(body.name, "monitor_name");
    const type = asString(body.type, "monitor_type") as MonitorType;
    const defaultLanguage = typeof body.defaultLanguage === "string" ? body.defaultLanguage : null;
    // Floor 60s so ops/super_admin can request fast scans; API still enforces plan mins for customers.
    const scanIntervalSec = typeof body.scanIntervalSec === "number" ? Math.max(60, Math.floor(body.scanIntervalSec)) : 900;
    const alertThreshold = typeof body.alertThreshold === "number" ? Math.min(100, Math.max(0, Math.floor(body.alertThreshold))) : 60;
    const ts = nowIso();
    const nextScanAt = typeof body.nextScanAt === "string" && body.nextScanAt.trim() ? body.nextScanAt.trim() : ts;
    const profile = normalizeMonitorProfile(body.profile);
    const profileJson = JSON.stringify(profile);
    this.sql.exec(
      `INSERT OR IGNORE INTO monitor(id,tenant_id,name,type,status,default_language,scan_interval_sec,alert_threshold,next_scan_at,last_scan_at,profile_json,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, tenantId, name, type, "active", defaultLanguage, scanIntervalSec, alertThreshold, nextScanAt, null, profileJson, ts, ts
    );
    return this.getMonitor();
  }

  private getMonitor(): Response {
    const item = rows(this.sql.exec<{
      id: string; tenant_id: string; name: string; type: MonitorType; status: MonitorStatus;
      default_language: string | null; scan_interval_sec: number; alert_threshold: number;
      next_scan_at: string | null; last_scan_at: string | null; profile_json: string | null; created_at: string; updated_at: string;
    }>(`SELECT * FROM monitor LIMIT 1`))[0];
    if (!item) return json({ error: "monitor_not_found" }, 404);
    const monitor: MonitorRecord = {
      id: item.id,
      tenantId: item.tenant_id,
      name: item.name,
      type: item.type,
      status: item.status,
      defaultLanguage: item.default_language,
      scanIntervalSec: item.scan_interval_sec,
      alertThreshold: item.alert_threshold,
      nextScanAt: item.next_scan_at ?? null,
      lastScanAt: item.last_scan_at ?? null,
      profile: parseMonitorProfileJson(item.profile_json),
      createdAt: item.created_at,
      updatedAt: item.updated_at
    };
    return json({ monitor });
  }

  private async patchMonitor(request: Request): Promise<Response> {
    const body = await readJson(request);
    const currentResponse = this.getMonitor();
    if (!currentResponse.ok) return currentResponse;
    const parsed = (await currentResponse.json()) as { monitor: MonitorRecord };
    const current = parsed.monitor;
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : current.name;
    const type = typeof body.type === "string" ? body.type as MonitorType : current.type;
    const status = body.status === "active" || body.status === "paused" || body.status === "archived" ? body.status : current.status;
    const defaultLanguage = typeof body.defaultLanguage === "string" ? body.defaultLanguage : current.defaultLanguage;
    const scanIntervalSec = typeof body.scanIntervalSec === "number" ? Math.max(60, Math.floor(body.scanIntervalSec)) : current.scanIntervalSec;
    const alertThreshold = typeof body.alertThreshold === "number" ? Math.min(100, Math.max(0, Math.floor(body.alertThreshold))) : current.alertThreshold;
    const nextScanAt = typeof body.nextScanAt === "string" && body.nextScanAt.trim()
      ? body.nextScanAt.trim()
      : body.nextScanAt === null
        ? null
        : current.nextScanAt;
    const profile: MonitorProfile = body.profile !== undefined
      ? normalizeMonitorProfile(body.profile)
      : (current.profile ?? {});
    this.sql.exec(
      `UPDATE monitor SET name=?,type=?,status=?,default_language=?,scan_interval_sec=?,alert_threshold=?,next_scan_at=?,profile_json=?,updated_at=? WHERE id=?`,
      name, type, status, defaultLanguage, scanIntervalSec, alertThreshold, nextScanAt, JSON.stringify(profile), nowIso(), current.id
    );
    return this.getMonitor();
  }

  private async claimAdvance(request: Request): Promise<Response> {
    const body = await readJson(request);
    const now = typeof body.now === "string" && body.now.trim() ? body.now.trim() : nowIso();
    const currentResponse = this.getMonitor();
    if (!currentResponse.ok) return currentResponse;
    const parsed = (await currentResponse.json()) as { monitor: MonitorRecord };
    const current = parsed.monitor;
    const nextScanAt = advanceNextScanAt(current.nextScanAt ?? now, current.scanIntervalSec, now);
    this.sql.exec(
      `UPDATE monitor SET last_scan_at=?, next_scan_at=?, updated_at=? WHERE id=?`,
      now, nextScanAt, nowIso(), current.id
    );
    return this.getMonitor();
  }

  private archiveMonitor(): Response {
    this.sql.exec(`UPDATE monitor SET status='archived', updated_at=?`, nowIso());
    return json({ ok: true });
  }

  private listQueries(): Response {
    const queries: QueryRecord[] = rows(this.sql.exec<{
      id: string; raw_query: string; normalized_query: string; ast_json: string; enabled: number; created_at: string; updated_at: string;
    }>(`SELECT * FROM queries ORDER BY created_at ASC`)).map((item) => ({
      id: item.id,
      rawQuery: item.raw_query,
      normalizedQuery: item.normalized_query,
      astJson: item.ast_json,
      enabled: item.enabled === 1,
      createdAt: item.created_at,
      updatedAt: item.updated_at
    }));
    return json({ queries });
  }

  private async createQuery(request: Request): Promise<Response> {
    const body = await readJson(request);
    const id = crypto.randomUUID();
    const rawQuery = asString(body.rawQuery, "raw_query");
    const normalizedQuery = typeof body.normalizedQuery === "string" ? body.normalizedQuery : rawQuery;
    const astJson = typeof body.astJson === "string" ? body.astJson : JSON.stringify({ type: "unparsed", raw: rawQuery });
    const ts = nowIso();
    this.sql.exec(
      `INSERT INTO queries(id,raw_query,normalized_query,ast_json,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`,
      id, rawQuery, normalizedQuery, astJson, body.enabled === false ? 0 : 1, ts, ts
    );
    return json({ id, rawQuery, normalizedQuery, astJson, enabled: body.enabled !== false, createdAt: ts, updatedAt: ts }, 201);
  }

  private async patchQuery(request: Request, queryId: string): Promise<Response> {
    const existing = rows(this.sql.exec<{
      id: string; raw_query: string; normalized_query: string; ast_json: string; enabled: number;
    }>(`SELECT id,raw_query,normalized_query,ast_json,enabled FROM queries WHERE id=? LIMIT 1`, queryId))[0];
    if (!existing) return json({ error: "query_not_found" }, 404);
    const body = await readJson(request);
    const rawQuery = typeof body.rawQuery === "string" && body.rawQuery.trim() ? body.rawQuery.trim() : existing.raw_query;
    const normalizedQuery = typeof body.normalizedQuery === "string" ? body.normalizedQuery : existing.normalized_query;
    const astJson = typeof body.astJson === "string" ? body.astJson : existing.ast_json;
    const enabled = typeof body.enabled === "boolean" ? (body.enabled ? 1 : 0) : existing.enabled;
    this.sql.exec(
      `UPDATE queries SET raw_query=?,normalized_query=?,ast_json=?,enabled=?,updated_at=? WHERE id=?`,
      rawQuery, normalizedQuery, astJson, enabled, nowIso(), queryId
    );
    return json({ ok: true });
  }

  private deleteQuery(queryId: string): Response {
    this.sql.exec(`DELETE FROM queries WHERE id=?`, queryId);
    return json({ ok: true });
  }

  private mentionExists(contentId: string): Response {
    const exists = rows(this.sql.exec<{ id: string }>(`SELECT id FROM mentions WHERE content_id=? LIMIT 1`, contentId))[0];
    return json({ exists: Boolean(exists), mentionId: exists?.id ?? null });
  }

  private nearDupes(url: URL): Response {
    const simhashParam = url.searchParams.get("simhash") ?? "";
    if (!simhashParam.trim()) return json({ error: "invalid_simhash" }, 400);
    const threshold = Math.min(32, Math.max(0, Number(url.searchParams.get("threshold") ?? "3")));
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? "20")));
    const probe = simHashFromHex(simhashParam);
    const recent = rows(this.sql.exec<{
      id: string; content_id: string; title: string | null; simhash: string | null; story_cluster_id: string | null; discovered_at: string;
    }>(
      `SELECT id, content_id, title, simhash, story_cluster_id, discovered_at FROM mentions
       WHERE simhash IS NOT NULL AND simhash != ''
       ORDER BY discovered_at DESC LIMIT 200`
    ));
    const matches: Array<{
      id: string; contentId: string; title: string | null; simhash: string; storyClusterId: string | null; hamming: number; discoveredAt: string;
    }> = [];
    for (const item of recent) {
      if (!item.simhash) continue;
      const distance = hammingDistance64(probe, simHashFromHex(item.simhash));
      if (distance > threshold) continue;
      matches.push({
        id: item.id,
        contentId: item.content_id,
        title: item.title,
        simhash: item.simhash,
        storyClusterId: item.story_cluster_id,
        hamming: distance,
        discoveredAt: item.discovered_at
      });
    }
    matches.sort((a, b) => a.hamming - b.hamming || b.discoveredAt.localeCompare(a.discoveredAt));
    return json({ matches: matches.slice(0, limit), scanned: recent.length, threshold });
  }

  private listMentions(url: URL): Response {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "50")));
    const sentiment = url.searchParams.get("sentiment");
    const minSeverity = Number(url.searchParams.get("minSeverity") ?? "0");
    const source = url.searchParams.get("source");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const clauses = ["severity_score >= ?"];
    const params: unknown[] = [Number.isFinite(minSeverity) ? minSeverity : 0];
    if (sentiment) { clauses.push("sentiment = ?"); params.push(sentiment); }
    if (source) { clauses.push("source = ?"); params.push(source); }
    // Filter on discovered_at (always ISO). published_at may be RSS/RFC822 and is shown in UI separately.
    if (from && /^\d{4}-\d{2}-\d{2}/.test(from)) {
      clauses.push("discovered_at >= ?");
      params.push(from.length <= 10 ? `${from}T00:00:00.000Z` : from);
    }
    if (to && /^\d{4}-\d{2}-\d{2}/.test(to)) {
      clauses.push("discovered_at <= ?");
      params.push(to.length <= 10 ? `${to}T23:59:59.999Z` : to);
    }
    params.push(limit);
    const result = rows(this.sql.exec<Record<string, unknown>>(
      `SELECT * FROM mentions WHERE ${clauses.join(" AND ")} ORDER BY discovered_at DESC LIMIT ?`,
      ...params
    ));
    return json({ mentions: result });
  }

  private getMention(mentionId: string): Response {
    const mention = rows(this.sql.exec<Record<string, unknown>>(`SELECT * FROM mentions WHERE id=? LIMIT 1`, mentionId))[0];
    if (!mention) return json({ error: "mention_not_found" }, 404);
    const analysis = rows(this.sql.exec<Record<string, unknown>>(`SELECT * FROM mention_analysis WHERE mention_id=? LIMIT 1`, mentionId))[0] ?? null;
    return json({ mention, analysis });
  }

  private async upsertMention(request: Request): Promise<Response> {
    const body = await readJson(request);
    const contentId = asString(body.contentId, "content_id");
    const existing = rows(this.sql.exec<{ id: string }>(`SELECT id FROM mentions WHERE content_id=? LIMIT 1`, contentId))[0];
    if (existing) return json({ mentionId: existing.id, created: false });
    const mentionId = typeof body.id === "string" && body.id ? body.id : crypto.randomUUID();
    const ts = nowIso();
    const simhash = typeof body.simHash === "string" && body.simHash.trim()
      ? body.simHash.trim()
      : typeof body.simhash === "string" && body.simhash.trim()
        ? body.simhash.trim()
        : null;
    const storyClusterId = typeof body.storyClusterId === "string" && body.storyClusterId.trim()
      ? body.storyClusterId.trim()
      : null;
    this.sql.exec(
      `INSERT INTO mentions(id,content_id,canonical_url,source,title,excerpt,published_at,discovered_at,relevance_score,sentiment,sentiment_confidence,severity_score,topic,language,engagement_score,raw_r2_key,status,created_at,updated_at,simhash,story_cluster_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      mentionId,
      contentId,
      typeof body.canonicalUrl === "string" ? body.canonicalUrl : null,
      asString(body.source, "source"),
      typeof body.title === "string" ? body.title : null,
      typeof body.excerpt === "string" ? body.excerpt : null,
      typeof body.publishedAt === "string" ? body.publishedAt : null,
      typeof body.discoveredAt === "string" ? body.discoveredAt : ts,
      typeof body.relevanceScore === "number" ? body.relevanceScore : 0,
      asString(body.sentiment, "sentiment"),
      typeof body.sentimentConfidence === "number" ? body.sentimentConfidence : 0,
      typeof body.severityScore === "number" ? body.severityScore : 0,
      typeof body.topic === "string" ? body.topic : null,
      typeof body.language === "string" ? body.language : null,
      typeof body.engagementScore === "number" ? body.engagementScore : null,
      asString(body.rawR2Key, "raw_r2_key"),
      "active",
      ts,
      ts,
      simhash,
      storyClusterId
    );
    this.sql.exec(
      `INSERT OR REPLACE INTO mention_analysis(mention_id,relevance_reason,sentiment_reason,severity_reason,risk_categories_json,ai_model,ai_version,analyzed_at)
       VALUES(?,?,?,?,?,?,?,?)`,
      mentionId,
      typeof body.relevanceReason === "string" ? body.relevanceReason : null,
      typeof body.sentimentReason === "string" ? body.sentimentReason : null,
      typeof body.severityReason === "string" ? body.severityReason : null,
      JSON.stringify(Array.isArray(body.riskCategories) ? body.riskCategories : []),
      typeof body.aiModel === "string" ? body.aiModel : null,
      typeof body.aiVersion === "string" ? body.aiVersion : null,
      ts
    );
    return json({ mentionId, created: true }, 201);
  }

  private async addFeedback(request: Request): Promise<Response> {
    const body = await readJson(request);
    const mentionId = asString(body.mentionId, "mention_id");
    const userId = asString(body.userId, "user_id");
    const action = asString(body.action, "action");
    const allowed = new Set(["relevant", "not_relevant", "wrong_sentiment", "resolved", "flagged"]);
    if (!allowed.has(action)) return json({ error: "invalid_feedback_action" }, 400);
    const mention = rows(this.sql.exec<{ id: string; status: string }>(`SELECT id,status FROM mentions WHERE id=? LIMIT 1`, mentionId))[0];
    if (!mention) return json({ error: "mention_not_found" }, 404);
    this.sql.exec(
      `INSERT INTO feedback(id,mention_id,user_id,action,previous_value,new_value,created_at) VALUES(?,?,?,?,?,?,?)`,
      crypto.randomUUID(), mentionId, userId, action, mention.status, action, nowIso()
    );
    if (action === "resolved") this.sql.exec(`UPDATE mentions SET status='resolved',updated_at=? WHERE id=?`, nowIso(), mentionId);
    return json({ ok: true });
  }

  private async upsertAlert(request: Request): Promise<Response> {
    const body = await readJson(request);
    const dedupeKey = asString(body.dedupeKey, "dedupe_key");
    const existing = rows(this.sql.exec<{ id: string }>(`SELECT id FROM alerts WHERE dedupe_key=? LIMIT 1`, dedupeKey))[0];
    if (existing) return json({ alertId: existing.id, created: false });
    const id = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO alerts(id,mention_id,type,severity,state,dedupe_key,reason,created_at) VALUES(?,?,?,?,?,?,?,?)`,
      id,
      typeof body.mentionId === "string" ? body.mentionId : null,
      asString(body.type, "alert_type"),
      asString(body.severity, "alert_severity"),
      "pending",
      dedupeKey,
      typeof body.reason === "string" ? body.reason : null,
      nowIso()
    );
    return json({ alertId: id, created: true }, 201);
  }

  private listAlerts(url: URL): Response {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? "100")));
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const minSeverity = Number(url.searchParams.get("minSeverity") ?? "0");
    const severity = url.searchParams.get("severity");
    const state = url.searchParams.get("state");
    const clauses: string[] = ["1=1"];
    const params: unknown[] = [];
    // Prefer alert created_at for timeframe; fallback join keeps mention timestamps for display.
    if (from && /^\d{4}-\d{2}-\d{2}/.test(from)) {
      clauses.push("a.created_at >= ?");
      params.push(from.length <= 10 ? `${from}T00:00:00.000Z` : from);
    }
    if (to && /^\d{4}-\d{2}-\d{2}/.test(to)) {
      clauses.push("a.created_at <= ?");
      params.push(to.length <= 10 ? `${to}T23:59:59.999Z` : to);
    }
    if (Number.isFinite(minSeverity) && minSeverity > 0) {
      clauses.push("COALESCE(m.severity_score, 0) >= ?");
      params.push(minSeverity);
    }
    if (severity && ["critical", "high", "medium", "low"].includes(severity)) {
      clauses.push("a.severity = ?");
      params.push(severity);
    }
    if (state === "open" || state === "unresolved") {
      // Default triage queue: everything except resolved.
      clauses.push("a.state != ?");
      params.push("resolved");
    } else if (state && ["pending", "sent", "acknowledged", "resolved", "failed", "needs_setup"].includes(state)) {
      clauses.push("a.state = ?");
      params.push(state);
    }
    params.push(limit);
    const alerts = rows(this.sql.exec<Record<string, unknown>>(
      `SELECT
         a.id, a.mention_id, a.type, a.severity, a.state, a.dedupe_key, a.reason,
         a.created_at, a.sent_at, a.acknowledged_at, a.resolved_at,
         m.title AS mention_title,
         m.excerpt AS mention_excerpt,
         m.canonical_url AS mention_url,
         m.source AS mention_source,
         m.sentiment AS mention_sentiment,
         m.severity_score AS mention_severity_score,
         m.published_at AS mention_published_at,
         m.discovered_at AS mention_discovered_at,
         m.topic AS mention_topic
       FROM alerts a
       LEFT JOIN mentions m ON m.id = a.mention_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY COALESCE(m.discovered_at, a.created_at) DESC, a.created_at DESC
       LIMIT ?`,
      ...params
    )).map((row) => ({
      id: row.id,
      mention_id: row.mention_id,
      type: row.type,
      severity: row.severity,
      state: row.state,
      dedupe_key: row.dedupe_key,
      reason: row.reason,
      created_at: row.created_at,
      sent_at: row.sent_at,
      acknowledged_at: row.acknowledged_at,
      resolved_at: row.resolved_at,
      mention: row.mention_id
        ? {
            id: row.mention_id,
            title: row.mention_title ?? null,
            excerpt: row.mention_excerpt ?? null,
            canonical_url: row.mention_url ?? null,
            source: row.mention_source ?? null,
            sentiment: row.mention_sentiment ?? null,
            severity_score: row.mention_severity_score ?? null,
            published_at: row.mention_published_at ?? null,
            discovered_at: row.mention_discovered_at ?? null,
            topic: row.mention_topic ?? null
          }
        : null
    }));
    return json({ alerts });
  }

  private getAlert(alertId: string): Response {
    if (!alertId) return json({ error: "invalid_alert_id" }, 400);
    const alert = rows(this.sql.exec<Record<string, unknown>>(`SELECT * FROM alerts WHERE id=? LIMIT 1`, alertId))[0];
    if (!alert) return json({ error: "alert_not_found" }, 404);
    const deliveries = rows(this.sql.exec<Record<string, unknown>>(
      `SELECT * FROM alert_deliveries WHERE alert_id=? ORDER BY updated_at DESC`, alertId
    ));
    return json({ alert, deliveries });
  }

  private listAlertDeliveries(alertId: string): Response {
    if (!alertId) return json({ error: "invalid_alert_id" }, 400);
    const deliveries = rows(this.sql.exec<Record<string, unknown>>(
      `SELECT * FROM alert_deliveries WHERE alert_id=? ORDER BY updated_at DESC`, alertId
    ));
    return json({ deliveries });
  }

  private async upsertAlertDelivery(request: Request): Promise<Response> {
    const body = await readJson(request);
    const alertId = asString(body.alertId, "alert_id");
    const channel = asString(body.channel, "channel");
    const status = asString(body.status, "status");
    const allowed = new Set(["pending", "sent", "failed", "skipped"]);
    if (!allowed.has(status)) return json({ error: "invalid_delivery_status" }, 400);
    const attempt = typeof body.attempt === "number" && Number.isFinite(body.attempt)
      ? Math.max(1, Math.floor(body.attempt))
      : undefined;
    const providerRef = typeof body.providerRef === "string" ? body.providerRef : null;
    const errorText = typeof body.error === "string" ? body.error : null;
    const ts = nowIso();
    const existing = rows(this.sql.exec<{ id: string; attempt: number }>(
      `SELECT id,attempt FROM alert_deliveries WHERE alert_id=? AND channel=? LIMIT 1`, alertId, channel
    ))[0];
    if (existing) {
      const nextAttempt = attempt ?? existing.attempt + (status === "pending" ? 0 : 1);
      this.sql.exec(
        `UPDATE alert_deliveries SET status=?, provider_ref=?, attempt=?, error=?, updated_at=? WHERE id=?`,
        status, providerRef, nextAttempt, errorText, ts, existing.id
      );
      return json({ id: existing.id, alertId, channel, status, attempt: nextAttempt, updated: true });
    }
    const id = crypto.randomUUID();
    const firstAttempt = attempt ?? 1;
    this.sql.exec(
      `INSERT INTO alert_deliveries(id,alert_id,channel,status,provider_ref,attempt,error,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      id, alertId, channel, status, providerRef, firstAttempt, errorText, ts, ts
    );
    return json({ id, alertId, channel, status, attempt: firstAttempt, updated: false }, 201);
  }

  private async patchAlert(request: Request, alertId: string): Promise<Response> {
    const body = await readJson(request);
    const state = typeof body.state === "string" ? body.state : null;
    if (!state || !new Set(["pending", "sent", "acknowledged", "resolved", "failed", "needs_setup"]).has(state)) return json({ error: "invalid_alert_state" }, 400);
    const ts = nowIso();
    this.sql.exec(
      `UPDATE alerts SET state=?,sent_at=CASE WHEN ?='sent' THEN COALESCE(sent_at,?) ELSE sent_at END,
       acknowledged_at=CASE WHEN ?='acknowledged' THEN COALESCE(acknowledged_at,?) ELSE acknowledged_at END,
       resolved_at=CASE WHEN ?='resolved' THEN COALESCE(resolved_at,?) ELSE resolved_at END WHERE id=?`,
      state, state, ts, state, ts, state, ts, alertId
    );
    return json({ ok: true });
  }
}

export class TenantBudgetDO extends SqliteObject {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS monthly_usage (
      month TEXT PRIMARY KEY, crawl_requests INTEGER NOT NULL DEFAULT 0, browser_units REAL NOT NULL DEFAULT 0,
      ai_units REAL NOT NULL DEFAULT 0, mentions_processed INTEGER NOT NULL DEFAULT 0, notifications_sent INTEGER NOT NULL DEFAULT 0,
      storage_bytes_estimate INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    )`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/internal/usage/increment") return await this.incrementUsage(request);
      if (request.method === "GET" && url.pathname === "/internal/usage") return this.getUsage(url);
      return json({ ok: true, phase: "budget_usage" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal_error";
      return json({ error: message }, message.startsWith("invalid_") ? 400 : 500);
    }
  }

  private currentMonth(value?: string | null): string {
    if (value && /^\d{4}-\d{2}$/.test(value)) return value;
    return nowIso().slice(0, 7);
  }

  private async incrementUsage(request: Request): Promise<Response> {
    const body = await readJson(request);
    const month = this.currentMonth(typeof body.month === "string" ? body.month : null);
    const crawlRequests = typeof body.crawlRequests === "number" ? Math.max(0, Math.floor(body.crawlRequests)) : 0;
    const browserUnits = typeof body.browserUnits === "number" ? Math.max(0, body.browserUnits) : 0;
    const aiUnits = typeof body.aiUnits === "number" ? Math.max(0, body.aiUnits) : 0;
    const mentionsProcessed = typeof body.mentionsProcessed === "number" ? Math.max(0, Math.floor(body.mentionsProcessed)) : 0;
    const notificationsSent = typeof body.notificationsSent === "number" ? Math.max(0, Math.floor(body.notificationsSent)) : 0;
    const storageBytesEstimate = typeof body.storageBytesEstimate === "number" ? Math.max(0, Math.floor(body.storageBytesEstimate)) : 0;
    const ts = nowIso();
    this.sql.exec(
      `INSERT INTO monthly_usage(month,crawl_requests,browser_units,ai_units,mentions_processed,notifications_sent,storage_bytes_estimate,updated_at)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(month) DO UPDATE SET
         crawl_requests=crawl_requests+excluded.crawl_requests,
         browser_units=browser_units+excluded.browser_units,
         ai_units=ai_units+excluded.ai_units,
         mentions_processed=mentions_processed+excluded.mentions_processed,
         notifications_sent=notifications_sent+excluded.notifications_sent,
         storage_bytes_estimate=storage_bytes_estimate+excluded.storage_bytes_estimate,
         updated_at=excluded.updated_at`,
      month, crawlRequests, browserUnits, aiUnits, mentionsProcessed, notificationsSent, storageBytesEstimate, ts
    );
    return this.getUsage(new URL(`https://do.internal/internal/usage?month=${encodeURIComponent(month)}`));
  }

  private getUsage(url: URL): Response {
    const month = this.currentMonth(url.searchParams.get("month"));
    const usage = rows(this.sql.exec<Record<string, unknown>>(
      `SELECT * FROM monthly_usage WHERE month=? LIMIT 1`, month
    ))[0] ?? {
      month,
      crawl_requests: 0,
      browser_units: 0,
      ai_units: 0,
      mentions_processed: 0,
      notifications_sent: 0,
      storage_bytes_estimate: 0,
      updated_at: null
    };
    return json({ usage });
  }
}

const DOMAIN_PARK_CAP_PER_TENANT = 1024;
const DOMAIN_PARK_CAP_PER_DOMAIN = 4096;
const DOMAIN_PARK_BODY_MAX = 16 * 1024;
const WAKE_INFLIGHT_MS = 120_000;
const WAKE_STRANDED_GRACE_MS = 15 * 60 * 1000;
/** An alarm that is already due must not be scheduled for `now`, or the DO re-arms in a tight loop. */
const ALARM_REARM_FLOOR_MS = 60_000;
const PARK_EVENT_TTL_MS = 24 * 60 * 60 * 1000;
/** One sweep invocation. Matches crawler-core SWEEP_CHUNK without importing that module. */
const DOMAIN_SWEEP_LIMIT = 32;
/** A browser slot that is not released still expires, so active_requests cannot stick. */
const DOMAIN_LEASE_TTL_MS = 60_000;
const DOMAIN_LEASE_BASE = 2;
const DOMAIN_LEASE_CAP = 8;

/** Hot domains with a deep park get more than two slots. The cap stays at 8. */
function domainLeaseBudget(waiting: number): number {
  const extra = Math.floor(Math.max(0, waiting) / 32);
  return Math.max(DOMAIN_LEASE_BASE, Math.min(DOMAIN_LEASE_CAP, DOMAIN_LEASE_BASE + extra));
}

function parkLane(value: unknown): "fetch" | "browser" {
  if (value === "fetch" || value === "browser") return value;
  throw new Error("invalid_lane");
}

export class DomainCoordinatorDO extends SqliteObject {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS domain_state (
      key TEXT PRIMARY KEY, domain TEXT NOT NULL, next_allowed_at INTEGER NOT NULL DEFAULT 0,
      active_requests INTEGER NOT NULL DEFAULT 0, consecutive_errors INTEGER NOT NULL DEFAULT 0,
      recent_429 INTEGER NOT NULL DEFAULT 0, recent_403 INTEGER NOT NULL DEFAULT 0,
      backoff_until INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS domain_waiters (
      url_key TEXT PRIMARY KEY,
      lane TEXT NOT NULL,
      body_json TEXT NOT NULL,
      parked_at INTEGER NOT NULL,
      claimed_at INTEGER NOT NULL DEFAULT 0,
      tenant_id TEXT NOT NULL DEFAULT '',
      monitor_id TEXT NOT NULL DEFAULT ''
    )`);
    ensureColumn(this.sql, "domain_waiters", "claimed_at", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(this.sql, "domain_waiters", "tenant_id", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.sql, "domain_waiters", "monitor_id", "TEXT NOT NULL DEFAULT ''");
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_domain_waiters_lane ON domain_waiters(lane, parked_at)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS domain_wake (
      key TEXT PRIMARY KEY,
      wake_at INTEGER NOT NULL,
      hops INTEGER NOT NULL DEFAULT 0,
      token TEXT NOT NULL DEFAULT '',
      last_tenant TEXT
    )`);
    ensureColumn(this.sql, "domain_wake", "token", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.sql, "domain_wake", "last_tenant", "TEXT");
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_domain_waiters_tenant ON domain_waiters(lane, tenant_id, parked_at)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS domain_park_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lane TEXT NOT NULL,
      body_json TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT '',
      monitor_id TEXT NOT NULL DEFAULT '',
      expired_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS domain_leases (
      lease_id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      acquired_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_domain_leases_expires ON domain_leases(expires_at)`);
  }

  async alarm(): Promise<void> {
    const now = this.clock();
    await this.state.storage.transaction(async () => {
      this.expireLeases(now);
      this.sql.exec(`DELETE FROM domain_park_events WHERE expired_at < ?`, now - PARK_EVENT_TTL_MS);
      const wakes = rows<{ key: string; wake_at: number }>(this.sql.exec(
        `SELECT key, wake_at FROM domain_wake`
      ));
      const waiters = rows<{
        url_key: string;
        lane: string;
        body_json: string;
        tenant_id: string;
        monitor_id: string;
        parked_at: number;
      }>(this.sql.exec(
        `SELECT url_key, lane, body_json, tenant_id, monitor_id, parked_at FROM domain_waiters`
      ));
      for (const row of waiters) {
        const wake = wakes.find((item) => item.key === row.lane);
        const basis = Math.max(Number(row.parked_at), wake != null ? Number(wake.wake_at) : Number(row.parked_at));
        if (basis + WAKE_STRANDED_GRACE_MS > now) continue;
        this.logParkExpiry(row);
        this.sql.exec(
          `INSERT INTO domain_park_events(lane, body_json, tenant_id, monitor_id, expired_at) VALUES(?,?,?,?,?)`,
          row.lane, row.body_json, row.tenant_id ?? "", row.monitor_id ?? "", now
        );
        this.sql.exec(`DELETE FROM domain_waiters WHERE url_key=?`, row.url_key);
      }
      for (const wake of wakes) {
        if (Number(wake.wake_at) + WAKE_STRANDED_GRACE_MS > now) continue;
        if (wake.key !== "fetch" && wake.key !== "browser") continue;
        if (this.waiting(wake.key) === 0) this.sql.exec(`DELETE FROM domain_wake WHERE key=?`, wake.key);
      }
    });
    await this.syncAlarm();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/internal/park") return this.park(request);
    if (request.method === "POST" && url.pathname === "/internal/take") return this.take(request);
    if (request.method === "POST" && url.pathname === "/internal/complete") return this.complete(request);
    if (request.method === "POST" && url.pathname === "/internal/release-claim") return this.releaseClaim(request);
    if (request.method === "POST" && url.pathname === "/internal/release-wake") return this.releaseWake(request);
    if (request.method === "POST" && url.pathname === "/internal/note-wake") return this.noteWake(request);
    if (request.method === "POST" && url.pathname === "/internal/sweep") return this.sweep(request);
    if (request.method === "POST" && url.pathname === "/internal/revise-park") return this.revisePark(request);
    if (request.method === "POST" && url.pathname === "/internal/acquire") return this.acquire(request);
    if (request.method === "POST" && url.pathname === "/internal/release") return this.release(request);
    if (request.method === "GET" && url.pathname === "/internal/state") {
      const waitingRow = rows(this.sql.exec<{ waiting: number }>(`SELECT COUNT(*) AS waiting FROM domain_waiters`))[0];
      return json({
        state: rows(this.sql.exec<Record<string, unknown>>(`SELECT * FROM domain_state WHERE key='self' LIMIT 1`))[0] ?? null,
        waiting: Number(waitingRow?.waiting ?? 0),
        wake: rows(this.sql.exec<Record<string, unknown>>(`SELECT key, wake_at, hops, token, last_tenant FROM domain_wake`)),
        expired: Number(rows(this.sql.exec<{ expired: number }>(`SELECT COUNT(*) AS expired FROM domain_park_events`))[0]?.expired ?? 0),
        leases: this.liveLeases(),
        parkEvents: rows(this.sql.exec<Record<string, unknown>>(
          `SELECT lane, tenant_id, monitor_id, expired_at FROM domain_park_events ORDER BY id ASC LIMIT 50`
        ))
      });
    }
    return json({ error: "not_found" }, 404);
  }

  private waiterKey(lane: "fetch" | "browser", urlKey: string): string {
    return `${lane}\u001f${urlKey}`;
  }

  private waiting(lane: "fetch" | "browser"): number {
    const row = rows(this.sql.exec<{ waiting: number }>(
      `SELECT COUNT(*) AS waiting FROM domain_waiters WHERE lane=?`,
      lane
    ))[0];
    return Number(row?.waiting ?? 0);
  }

  private waitingTenant(lane: "fetch" | "browser", tenantId: string): number {
    const row = rows(this.sql.exec<{ waiting: number }>(
      `SELECT COUNT(*) AS waiting FROM domain_waiters WHERE lane=? AND tenant_id=?`,
      lane, tenantId
    ))[0];
    return Number(row?.waiting ?? 0);
  }

  private parkLimits(): { perTenant: number; perDomain: number } {
    const configured = Number(this.env.DOMAIN_PARK_CAP);
    if (Number.isFinite(configured) && configured >= 1) {
      const perTenant = Math.max(1, Math.min(DOMAIN_PARK_CAP_PER_TENANT, Math.floor(configured)));
      return { perTenant, perDomain: Math.max(perTenant, Math.min(DOMAIN_PARK_CAP_PER_DOMAIN, perTenant * 4)) };
    }
    return { perTenant: DOMAIN_PARK_CAP_PER_TENANT, perDomain: DOMAIN_PARK_CAP_PER_DOMAIN };
  }

  private wakeRow(lane: string): { wake_at: number; token: string; hops: number; last_tenant: string | null } | null {
    return rows(this.sql.exec<{ wake_at: number; token: string; hops: number; last_tenant: string | null }>(
      `SELECT wake_at, token, hops, last_tenant FROM domain_wake WHERE key=? LIMIT 1`,
      lane
    ))[0] ?? null;
  }

  private clock(): number {
    return this.env.nowMs ? this.env.nowMs() : Date.now();
  }

  private wakeInflight(wake: { wake_at: number; token: string } | null, now: number): boolean {
    if (!wake || !wake.token) return false;
    return Number(wake.wake_at) > now - WAKE_INFLIGHT_MS;
  }

  private writeWake(lane: string, now: number, delaySeconds: number, hops: number): string {
    const token = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO domain_wake(key, wake_at, hops, token) VALUES(?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET wake_at=excluded.wake_at, hops=excluded.hops, token=excluded.token`,
      lane, now + delaySeconds * 1000, hops, token
    );
    return token;
  }

  private logParkExpiry(row: { lane: string; body_json: string; tenant_id: string; monitor_id: string }): void {
    let url = "";
    let jobId = "";
    let tenantId = row.tenant_id ?? "";
    let monitorId = row.monitor_id ?? "";
    try {
      const parsed = JSON.parse(row.body_json) as {
        jobId?: unknown;
        tenantId?: unknown;
        monitorId?: unknown;
        payload?: { url?: unknown };
      };
      if (typeof parsed.jobId === "string") jobId = parsed.jobId;
      if (!tenantId && typeof parsed.tenantId === "string") tenantId = parsed.tenantId;
      if (!monitorId && typeof parsed.monitorId === "string") monitorId = parsed.monitorId;
      if (typeof parsed.payload?.url === "string") url = parsed.payload.url;
    } catch {
      /* the events table still keeps the raw body */
    }
    structuredLog("warn", "crawl_domain_park_expired", {
      requestId: jobId ? `park:${jobId}` : "park-expiry",
      tenantId: tenantId || undefined,
      monitorId: monitorId || undefined
    }, { lane: row.lane, url, jobId, count: 1 });
  }

  private async syncAlarm(): Promise<void> {
    const now = this.clock();
    const basis = rows<{ basis: number | null }>(this.sql.exec(
      `SELECT MIN(MAX(domain_waiters.parked_at, IFNULL(domain_wake.wake_at, domain_waiters.parked_at))) AS basis
       FROM domain_waiters
       LEFT JOIN domain_wake ON domain_wake.key = domain_waiters.lane`
    ))[0];
    const orphan = rows<{ wake_at: number | null }>(this.sql.exec(
      `SELECT MIN(wake_at) AS wake_at FROM domain_wake
       WHERE NOT EXISTS (SELECT 1 FROM domain_waiters WHERE lane = domain_wake.key)`
    ))[0];
    const times: number[] = [];
    if (basis?.basis != null && Number.isFinite(Number(basis.basis)) && Number(basis.basis) > 0) {
      times.push(Number(basis.basis) + WAKE_STRANDED_GRACE_MS);
    }
    if (orphan?.wake_at != null && Number(orphan.wake_at) > 0) times.push(Number(orphan.wake_at) + WAKE_STRANDED_GRACE_MS);
    const lease = rows<{ expires_at: number | null }>(this.sql.exec(
      `SELECT MIN(expires_at) AS expires_at FROM domain_leases`
    ))[0];
    if (lease?.expires_at != null && Number(lease.expires_at) > 0) times.push(Number(lease.expires_at));
    if (times.length === 0) {
      await this.state.storage.deleteAlarm();
      return;
    }
    const earliest = Math.min(...times);
    await this.state.storage.setAlarm(Math.max(now + ALARM_REARM_FLOOR_MS, earliest));
  }

  private retryAfterMs(now: number, lane: "fetch" | "browser"): number {
    this.expireLeases(now);
    const row = rows(this.sql.exec<{ active_requests: number; next_allowed_at: number; backoff_until: number }>(
      `SELECT active_requests, next_allowed_at, backoff_until FROM domain_state WHERE key='self' LIMIT 1`
    ))[0];
    if (!row) return 0;
    const backoffUntil = Number(row.backoff_until);
    if (lane === "fetch") return backoffUntil > now ? Math.max(250, backoffUntil - now) : 0;
    const blockedUntil = Math.max(Number(row.next_allowed_at), backoffUntil);
    const budget = domainLeaseBudget(this.totalWaiting());
    if (this.liveLeases() >= budget || blockedUntil > now) {
      return Math.max(250, blockedUntil > now ? blockedUntil - now : 250);
    }
    return 0;
  }

  /** Drop expired slot leases and mirror the live count so a missed release cannot pin the domain. */
  private expireLeases(now: number): number {
    this.sql.exec(`DELETE FROM domain_leases WHERE expires_at <= ?`, now);
    const active = this.liveLeases();
    this.sql.exec(`UPDATE domain_state SET active_requests=? WHERE key='self'`, active);
    return active;
  }

  private liveLeases(): number {
    const row = rows(this.sql.exec<{ active: number }>(`SELECT COUNT(*) AS active FROM domain_leases`))[0];
    return Number(row?.active ?? 0);
  }

  private totalWaiting(): number {
    const row = rows(this.sql.exec<{ waiting: number }>(`SELECT COUNT(*) AS waiting FROM domain_waiters`))[0];
    return Number(row?.waiting ?? 0);
  }

  private async acquire(request: Request): Promise<Response> {
    const body = await readJson(request);
    const domain = asString(body.domain, "domain").toLowerCase();
    const requested = typeof body.maxConcurrency === "number"
      ? Math.max(1, Math.min(DOMAIN_LEASE_CAP, Math.floor(body.maxConcurrency)))
      : DOMAIN_LEASE_BASE;
    const minDelayMs = typeof body.minDelayMs === "number" ? Math.max(0, Math.min(60_000, Math.floor(body.minDelayMs))) : 500;
    const now = this.clock();
    const outcome = await this.state.storage.transaction(async () => {
      const active = this.expireLeases(now);
      const effective = Math.min(DOMAIN_LEASE_CAP, Math.max(requested, domainLeaseBudget(this.totalWaiting())));
      const row = rows(this.sql.exec<{ next_allowed_at: number; backoff_until: number }>(
        `SELECT next_allowed_at, backoff_until FROM domain_state WHERE key='self' LIMIT 1`
      ))[0];
      const blockedUntil = row ? Math.max(Number(row.next_allowed_at), Number(row.backoff_until)) : 0;
      if (row && (active >= effective || blockedUntil > now)) {
        return { granted: false as const, leaseId: "", retryAfterMs: Math.max(250, blockedUntil > now ? blockedUntil - now : 250) };
      }
      const leaseId = crypto.randomUUID();
      this.sql.exec(
        `INSERT INTO domain_leases(lease_id, expires_at, acquired_at) VALUES(?,?,?)`,
        leaseId, now + DOMAIN_LEASE_TTL_MS, now
      );
      const live = this.liveLeases();
      if (!row) {
        this.sql.exec(
          `INSERT INTO domain_state(key,domain,next_allowed_at,active_requests,updated_at) VALUES('self',?,?,?,?)`,
          domain, now + minDelayMs, live, nowIso()
        );
      } else {
        this.sql.exec(
          `UPDATE domain_state SET active_requests=?, next_allowed_at=?, updated_at=? WHERE key='self'`,
          live, now + minDelayMs, nowIso()
        );
      }
      return { granted: true as const, leaseId, retryAfterMs: 0 };
    });
    await this.syncAlarm();
    if (!outcome.granted) return json({ granted: false, retryAfterMs: outcome.retryAfterMs }, 429);
    return json({ granted: true, leaseId: outcome.leaseId, retryAfterMs: 0 });
  }

  private async release(request: Request): Promise<Response> {
    const body = await readJson(request);
    const status = typeof body.status === "number" ? body.status : 200;
    const retryAfterMs = typeof body.retryAfterMs === "number" ? Math.max(0, Math.floor(body.retryAfterMs)) : 0;
    const domain = typeof body.domain === "string" && body.domain.trim() ? body.domain.trim().toLowerCase() : "unknown";
    const leaseId = typeof body.leaseId === "string" ? body.leaseId.trim() : "";
    const now = this.clock();
    await this.state.storage.transaction(async () => {
      this.expireLeases(now);
      if (leaseId) this.sql.exec(`DELETE FROM domain_leases WHERE lease_id=?`, leaseId);
      const active = this.liveLeases();
      // Upsert so a 429 can record backoff even when this worker never acquired a slot.
      this.sql.exec(
        `INSERT OR IGNORE INTO domain_state(key,domain,next_allowed_at,active_requests,consecutive_errors,recent_429,recent_403,backoff_until,updated_at)
         VALUES('self',?,0,0,0,0,0,0,?)`,
        domain, nowIso()
      );
      this.sql.exec(
        `UPDATE domain_state SET
          active_requests=?,
          consecutive_errors=CASE WHEN ? >= 500 THEN consecutive_errors+1 ELSE 0 END,
          recent_429=CASE WHEN ? = 429 THEN recent_429+1 ELSE recent_429 END,
          recent_403=CASE WHEN ? = 403 THEN recent_403+1 ELSE recent_403 END,
          backoff_until=CASE WHEN ? IN (429,403) THEN MAX(backoff_until, ?) ELSE backoff_until END,
          updated_at=? WHERE key='self'`,
        active, status, status, status, status, now + retryAfterMs, nowIso()
      );
    });
    await this.syncAlarm();
    return json({ ok: true });
  }

  private async revisePark(request: Request): Promise<Response> {
    const body = await readJson(request);
    const lane = parkLane(body.lane);
    const urlKey = asString(body.urlKey, "url_key");
    const bodyJson = asString(body.bodyJson, "body_json");
    if (bodyJson.length > DOMAIN_PARK_BODY_MAX) return json({ ok: false, error: "body_too_large" }, 400);
    const now = this.clock();
    const updated = await this.state.storage.transaction(async () => {
      const existing = rows(this.sql.exec<{ url_key: string }>(
        `SELECT url_key FROM domain_waiters WHERE url_key=? AND lane=? LIMIT 1`,
        urlKey, lane
      ))[0];
      if (!existing) return false;
      this.sql.exec(
        `UPDATE domain_waiters SET body_json=?, parked_at=?, claimed_at=0 WHERE url_key=? AND lane=?`,
        bodyJson, now, urlKey, lane
      );
      return true;
    });
    await this.syncAlarm();
    if (!updated) return json({ ok: false }, 404);
    return json({ ok: true });
  }

  private async park(request: Request): Promise<Response> {
    const body = await readJson(request);
    const lane = parkLane(body.lane);
    const urlKey = asString(body.urlKey, "url_key");
    const bodyJson = asString(body.bodyJson, "body_json");
    const delaySeconds = Math.max(1, Math.min(900, Math.ceil(Number(body.delaySeconds) || 1)));
    const hops = typeof body.hops === "number" && Number.isFinite(body.hops) ? Math.max(0, Math.min(20, Math.floor(body.hops))) : 0;
    const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
    const monitorId = typeof body.monitorId === "string" ? body.monitorId.trim() : "";
    const now = this.clock();
    const limits = this.parkLimits();
    const result = await this.state.storage.transaction(async () => {
      const wake = this.wakeRow(lane);
      const inflight = this.wakeInflight(wake, now);
      const heldToken = wake?.token ?? "";
      if (bodyJson.length > DOMAIN_PARK_BODY_MAX) {
        return {
          scheduleWake: false,
          delaySeconds,
          waiting: this.waiting(lane),
          overflow: false,
          duplicate: false,
          fallback: true,
          token: heldToken
        };
      }
      const key = this.waiterKey(lane, urlKey);
      const existing = rows(this.sql.exec<{ url_key: string }>(
        `SELECT url_key FROM domain_waiters WHERE url_key=? LIMIT 1`,
        key
      ))[0];
      const overCap = !existing && (
        this.waitingTenant(lane, tenantId) >= limits.perTenant
        || this.waiting(lane) >= limits.perDomain
      );
      if (overCap) {
        let token = heldToken;
        const scheduleWake = !inflight && this.waiting(lane) > 0;
        if (scheduleWake) token = this.writeWake(lane, now, delaySeconds, hops);
        return {
          scheduleWake,
          delaySeconds,
          waiting: this.waiting(lane),
          overflow: true,
          duplicate: false,
          fallback: true,
          token
        };
      }
      if (!existing) {
        this.sql.exec(
          `INSERT INTO domain_waiters(url_key, lane, body_json, parked_at, claimed_at, tenant_id, monitor_id) VALUES(?,?,?,?,0,?,?)`,
          key, lane, bodyJson, now, tenantId, monitorId
        );
      }
      let token = heldToken;
      const scheduleWake = !inflight;
      if (scheduleWake) token = this.writeWake(lane, now, delaySeconds, hops);
      return {
        scheduleWake,
        delaySeconds,
        waiting: this.waiting(lane),
        overflow: false,
        duplicate: Boolean(existing),
        fallback: false,
        token
      };
    });
    await this.syncAlarm();
    return json(result);
  }

  private async take(request: Request): Promise<Response> {
    const body = await readJson(request);
    const lane = parkLane(body.lane);
    const requested = typeof body.limit === "number" ? Math.floor(body.limit) : 1;
    const limit = Math.max(1, Math.min(8, requested));
    const token = typeof body.token === "string" ? body.token : "";
    const now = this.clock();
    const result = await this.state.storage.transaction(async () => {
      const wake = this.wakeRow(lane);
      const waiting = this.waiting(lane);
      if (!wake || !token || wake.token !== token) return { jobs: [], retryAfterMs: 0, waiting, stale: true };
      const retryAfterMs = this.retryAfterMs(now, lane);
      if (retryAfterMs > 0) return { jobs: [], retryAfterMs, waiting, stale: false };
      const selected: Array<{ url_key: string; body_json: string }> = [];
      let lastTenant: string | null = wake.last_tenant == null ? null : String(wake.last_tenant);
      for (let slot = 0; slot < limit; slot += 1) {
        const job = this.claimNext(lane, now, lastTenant);
        if (!job) break;
        this.sql.exec(`UPDATE domain_waiters SET claimed_at=? WHERE url_key=?`, now, job.url_key);
        selected.push(job);
        lastTenant = job.tenant_id ?? "";
      }
      if (selected.length > 0) {
        this.sql.exec(`UPDATE domain_wake SET wake_at=?, last_tenant=? WHERE key=?`, now + WAKE_INFLIGHT_MS, lastTenant, lane);
      }
      return {
        jobs: selected.map((job) => ({ bodyJson: job.body_json, urlKey: job.url_key })),
        retryAfterMs: 0,
        waiting: this.waiting(lane),
        stale: false
      };
    });
    return json(result);
  }

  private async complete(request: Request): Promise<Response> {
    const body = await readJson(request);
    const lane = parkLane(body.lane);
    const urlKey = asString(body.urlKey, "url_key");
    this.sql.exec(`DELETE FROM domain_waiters WHERE url_key=? AND lane=?`, urlKey, lane);
    return json({ ok: true });
  }

  private async releaseClaim(request: Request): Promise<Response> {
    const body = await readJson(request);
    const lane = parkLane(body.lane);
    const urlKey = asString(body.urlKey, "url_key");
    this.sql.exec(`UPDATE domain_waiters SET claimed_at=0 WHERE url_key=? AND lane=?`, urlKey, lane);
    return json({ ok: true });
  }

  private async releaseWake(request: Request): Promise<Response> {
    const body = await readJson(request);
    const lane = parkLane(body.lane);
    const now = this.clock();
    const result = await this.state.storage.transaction(async () => {
      const waiting = this.waiting(lane);
      if (waiting === 0) this.sql.exec(`DELETE FROM domain_wake WHERE key=?`, lane);
      return { waiting, retryAfterMs: waiting > 0 ? this.retryAfterMs(now, lane) : 0 };
    });
    await this.syncAlarm();
    return json(result);
  }

  private async noteWake(request: Request): Promise<Response> {
    const body = await readJson(request);
    const lane = parkLane(body.lane);
    const delaySeconds = Math.ceil(Number(body.delaySeconds) || 0);
    const hops = typeof body.hops === "number" && Number.isFinite(body.hops) ? Math.max(0, Math.min(20, Math.floor(body.hops))) : 0;
    const now = this.clock();
    await this.state.storage.transaction(async () => {
      if (delaySeconds <= 0) {
        this.sql.exec(`DELETE FROM domain_wake WHERE key=?`, lane);
        return;
      }
      const clamped = Math.max(1, Math.min(900, delaySeconds));
      const existing = this.wakeRow(lane);
      if (existing) {
        this.sql.exec(`UPDATE domain_wake SET wake_at=?, hops=? WHERE key=?`, now + clamped * 1000, hops, lane);
        return;
      }
      this.sql.exec(
        `INSERT INTO domain_wake(key, wake_at, hops, token) VALUES(?,?,?,?)`,
        lane, now + clamped * 1000, hops, crypto.randomUUID()
      );
    });
    await this.syncAlarm();
    return json({ ok: true });
  }

  private claimNext(
    lane: "fetch" | "browser",
    now: number,
    lastTenant: string | null
  ): { url_key: string; body_json: string; tenant_id: string } | null {
    const cutoff = now - WAKE_INFLIGHT_MS;
    const claimable = `lane=? AND (claimed_at=0 OR claimed_at < ?)`;
    let tenant: string | null = null;
    if (lastTenant == null) {
      const oldest = rows<{ tenant_id: string }>(this.sql.exec(
        `SELECT tenant_id FROM domain_waiters WHERE ${claimable} ORDER BY parked_at ASC, url_key ASC LIMIT 1`,
        lane, cutoff
      ))[0];
      tenant = oldest ? String(oldest.tenant_id ?? "") : null;
    } else {
      const next = rows<{ tenant_id: string }>(this.sql.exec(
        `SELECT tenant_id FROM domain_waiters WHERE ${claimable} AND tenant_id > ?
         GROUP BY tenant_id ORDER BY tenant_id ASC LIMIT 1`,
        lane, cutoff, lastTenant
      ))[0];
      if (next) tenant = String(next.tenant_id ?? "");
      else {
        const wrap = rows<{ tenant_id: string }>(this.sql.exec(
          `SELECT tenant_id FROM domain_waiters WHERE ${claimable}
           GROUP BY tenant_id ORDER BY tenant_id ASC LIMIT 1`,
          lane, cutoff
        ))[0];
        tenant = wrap ? String(wrap.tenant_id ?? "") : null;
      }
    }
    if (tenant == null) return null;
    return rows<{ url_key: string; body_json: string; tenant_id: string }>(this.sql.exec(
      `SELECT url_key, body_json, tenant_id FROM domain_waiters
       WHERE ${claimable} AND tenant_id=?
       ORDER BY parked_at ASC, url_key ASC LIMIT 1`,
      lane, cutoff, tenant
    ))[0] ?? null;
  }

  private async sweep(request: Request): Promise<Response> {
    const body = await readJson(request);
    const lane = parkLane(body.lane);
    const requested = typeof body.limit === "number" ? Math.floor(body.limit) : DOMAIN_SWEEP_LIMIT;
    const limit = Math.max(1, Math.min(DOMAIN_SWEEP_LIMIT, requested));
    const result = await this.state.storage.transaction(async () => {
      const selected = rows(this.sql.exec<{ url_key: string; body_json: string }>(
        `SELECT url_key, body_json FROM domain_waiters WHERE lane=? ORDER BY parked_at ASC, url_key ASC LIMIT ?`,
        lane, limit
      ));
      const waiting = this.waiting(lane);
      return {
        jobs: selected.map((job) => ({ bodyJson: job.body_json, urlKey: job.url_key })),
        remaining: Math.max(0, waiting - selected.length)
      };
    });
    return json(result);
  }
}

export class BrowserPoolDO extends SqliteObject {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS pool_state (
      key TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 0, max_active INTEGER NOT NULL DEFAULT 100, updated_at TEXT NOT NULL
    )`);
    this.sql.exec(`INSERT OR IGNORE INTO pool_state(key,active,max_active,updated_at) VALUES('global',0,100,?)`, nowIso());
    this.sql.exec(`CREATE TABLE IF NOT EXISTS pool_leases (
      lease_id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      acquired_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_pool_leases_expires ON pool_leases(expires_at)`);
  }

  async alarm(): Promise<void> {
    this.sweep(Date.now());
    await this.syncAlarm();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/internal/acquire") return await this.acquire(request);
      if (request.method === "POST" && url.pathname === "/internal/release") return await this.release(request);
      if (request.method === "POST" && url.pathname === "/internal/reset") return await this.reset();
      if (request.method === "GET" && url.pathname === "/internal/state") return this.snapshot();
      return json({ error: "not_found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal_error";
      return json({ error: message }, message.startsWith("invalid_") ? 400 : 500);
    }
  }

  private accountCap(): number {
    return browserPoolCap(this.env.BROWSER_POOL_MAX);
  }

  private activeLeases(): number {
    const row = rows(this.sql.exec<{ active: number }>(`SELECT COUNT(*) AS active FROM pool_leases`))[0];
    return Number(row?.active ?? 0);
  }

  /** Drop expired leases and mirror the live count onto the legacy counter so it cannot drift. */
  private sweep(now: number): number {
    this.sql.exec(`DELETE FROM pool_leases WHERE expires_at <= ?`, now);
    const active = this.activeLeases();
    this.sql.exec(
      `UPDATE pool_state SET active=?, max_active=?, updated_at=? WHERE key='global'`,
      active, this.accountCap(), nowIso()
    );
    return active;
  }

  private async syncAlarm(): Promise<void> {
    const row = rows(this.sql.exec<{ expires_at: number | null }>(
      `SELECT MIN(expires_at) AS expires_at FROM pool_leases`
    ))[0];
    const expiresAt = row?.expires_at == null ? null : Number(row.expires_at);
    if (expiresAt != null && Number.isFinite(expiresAt)) await this.state.storage.setAlarm(expiresAt);
    else await this.state.storage.deleteAlarm();
  }

  private async acquire(request: Request): Promise<Response> {
    const body = await readJson(request);
    const requested = typeof body.maxActive === "number" ? body.maxActive : this.accountCap();
    const effectiveMax = Math.max(1, Math.min(this.accountCap(), Math.floor(requested)));
    const now = Date.now();
    const outcome = await this.state.storage.transaction(async () => {
      const active = this.sweep(now);
      if (active >= effectiveMax) {
        const next = rows(this.sql.exec<{ expires_at: number | null }>(
          `SELECT MIN(expires_at) AS expires_at FROM pool_leases`
        ))[0];
        const wait = next?.expires_at == null ? 1000 : Math.max(250, Number(next.expires_at) - now);
        return { granted: false as const, retryAfterMs: wait, active, maxActive: effectiveMax };
      }
      const leaseId = crypto.randomUUID();
      const expiresAt = now + BROWSER_POOL_LEASE_TTL_MS;
      this.sql.exec(
        `INSERT INTO pool_leases(lease_id, expires_at, acquired_at) VALUES(?,?,?)`,
        leaseId, expiresAt, now
      );
      this.sql.exec(
        `UPDATE pool_state SET active=?, max_active=?, updated_at=? WHERE key='global'`,
        active + 1, effectiveMax, nowIso()
      );
      return {
        granted: true as const,
        leaseId,
        expiresAt,
        active: active + 1,
        maxActive: effectiveMax,
        retryAfterMs: 0
      };
    });
    await this.syncAlarm();
    if (!outcome.granted) return json(outcome, 429);
    return json(outcome);
  }

  private async release(request: Request): Promise<Response> {
    const body = await readJson(request);
    const leaseId = typeof body.leaseId === "string" ? body.leaseId.trim() : "";
    const released = await this.state.storage.transaction(async () => {
      this.sweep(Date.now());
      const before = this.activeLeases();
      if (leaseId) {
        this.sql.exec(`DELETE FROM pool_leases WHERE lease_id=?`, leaseId);
      } else if (before > 0) {
        // In-flight callers from the pre-lease worker omit leaseId. Free the oldest slot.
        this.sql.exec(
          `DELETE FROM pool_leases WHERE lease_id = (
            SELECT lease_id FROM pool_leases ORDER BY acquired_at ASC LIMIT 1
          )`
        );
      }
      const active = this.activeLeases();
      this.sql.exec(
        `UPDATE pool_state SET active=?, max_active=?, updated_at=? WHERE key='global'`,
        active, this.accountCap(), nowIso()
      );
      return { released: before - active, active };
    });
    await this.syncAlarm();
    return json({ ok: true, released: released.released, active: released.active });
  }

  private async reset(): Promise<Response> {
    const cleared = await this.state.storage.transaction(async () => {
      const active = this.activeLeases();
      this.sql.exec(`DELETE FROM pool_leases`);
      this.sql.exec(
        `UPDATE pool_state SET active=0, max_active=?, updated_at=? WHERE key='global'`,
        this.accountCap(), nowIso()
      );
      return active;
    });
    await this.syncAlarm();
    return json({ ok: true, cleared, maxActive: this.accountCap() });
  }

  private snapshot(): Response {
    const legacy = rows(this.sql.exec<{ active: number; max_active: number }>(
      `SELECT active, max_active FROM pool_state WHERE key='global' LIMIT 1`
    ))[0];
    const legacyCounter = Number(legacy?.active ?? 0);
    const active = this.sweep(Date.now());
    const next = rows(this.sql.exec<{ expires_at: number | null }>(
      `SELECT MIN(expires_at) AS expires_at FROM pool_leases`
    ))[0];
    return json({
      state: {
        active,
        maxActive: this.accountCap(),
        legacyCounterBeforeSweep: legacyCounter,
        nextExpiresAt: next?.expires_at == null ? null : Number(next.expires_at),
        leaseTtlMs: BROWSER_POOL_LEASE_TTL_MS
      }
    });
  }
}

/** Shared-secret gate for the post-deploy pool reset. Missing token fails closed. */
export function browserPoolAdminAllowed(expected: string | undefined, authorization: string | null): "ok" | "not_configured" | "unauthorized" {
  const token = expected?.trim() ?? "";
  if (!token) return "not_configured";
  const provided = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  return constantTimeEqual(provided, token) ? "ok" : "unauthorized";
}


export class SchedulerShardDO extends SqliteObject {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS due_monitors (
      tenant_id TEXT NOT NULL,
      monitor_id TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'active',
      next_scan_at TEXT NOT NULL,
      scan_interval_sec INTEGER NOT NULL DEFAULT 900,
      claimed_until TEXT,
      last_claimed_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, monitor_id)
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_due_monitors_next ON due_monitors(status, next_scan_at)`);
    this.sql.exec(`INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('version', '1')`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/internal/upsert") return await this.upsert(request);
      if (request.method === "POST" && url.pathname === "/internal/remove") return await this.remove(request);
      if (request.method === "POST" && url.pathname === "/internal/claim") return await this.claim(request);
      if (request.method === "GET" && url.pathname === "/internal/stats") return this.stats();
      return json({ error: "not_found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal_error";
      return json({ error: message }, message.startsWith("invalid_") ? 400 : 500);
    }
  }

  private async upsert(request: Request): Promise<Response> {
    const body = await readJson(request);
    const tenantId = asString(body.tenantId, "tenant_id");
    const monitorId = asString(body.monitorId, "monitor_id");
    const priority = typeof body.priority === "string" && body.priority.trim() ? body.priority.trim() : "normal";
    const status = typeof body.status === "string" && body.status.trim() ? body.status.trim() : "active";
    const scanIntervalSec = typeof body.scanIntervalSec === "number"
      ? Math.max(60, Math.floor(body.scanIntervalSec))
      : 900;
    const ts = nowIso();
    const nextScanAt = typeof body.nextScanAt === "string" && body.nextScanAt.trim() ? body.nextScanAt.trim() : ts;
    this.sql.exec(
      `INSERT INTO due_monitors(tenant_id,monitor_id,priority,status,next_scan_at,scan_interval_sec,claimed_until,last_claimed_at,updated_at)
       VALUES(?,?,?,?,?,?,NULL,NULL,?)
       ON CONFLICT(tenant_id, monitor_id) DO UPDATE SET
         priority=excluded.priority,
         status=excluded.status,
         next_scan_at=excluded.next_scan_at,
         scan_interval_sec=excluded.scan_interval_sec,
         updated_at=excluded.updated_at`,
      tenantId, monitorId, priority, status, nextScanAt, scanIntervalSec, ts
    );
    return json({ ok: true });
  }

  private async remove(request: Request): Promise<Response> {
    const body = await readJson(request);
    const tenantId = asString(body.tenantId, "tenant_id");
    const monitorId = asString(body.monitorId, "monitor_id");
    this.sql.exec(`DELETE FROM due_monitors WHERE tenant_id=? AND monitor_id=?`, tenantId, monitorId);
    return json({ ok: true });
  }

  private async claim(request: Request): Promise<Response> {
    const body = await readJson(request);
    const limit = typeof body.limit === "number" ? Math.max(1, Math.min(200, Math.floor(body.limit))) : 50;
    const leaseSec = typeof body.leaseSec === "number" ? Math.max(15, Math.min(3600, Math.floor(body.leaseSec))) : 120;
    const now = typeof body.now === "string" && body.now.trim() ? body.now.trim() : nowIso();
    return this.state.storage.transaction(async () => {
      const candidates = rows(this.sql.exec<{
        tenant_id: string;
        monitor_id: string;
        priority: string;
        status: string;
        next_scan_at: string;
        scan_interval_sec: number;
        claimed_until: string | null;
      }>(
        `SELECT tenant_id,monitor_id,priority,status,next_scan_at,scan_interval_sec,claimed_until
         FROM due_monitors
         WHERE status = 'active' AND next_scan_at <= ?
         ORDER BY next_scan_at ASC
         LIMIT ?`,
        now, limit * 4
      ));
      const claimed: Array<{
        tenantId: string;
        monitorId: string;
        priority: string;
        nextScanAt: string;
        scanIntervalSec: number;
        claimedUntil: string;
      }> = [];
      const claimedUntil = claimLeaseUntil(now, leaseSec);
      for (const row of candidates) {
        if (claimed.length >= limit) break;
        if (!isClaimable({
          status: row.status,
          nextScanAt: row.next_scan_at,
          claimedUntil: row.claimed_until
        }, now)) continue;
        const nextScanAt = advanceNextScanAt(row.next_scan_at, row.scan_interval_sec, now);
        this.sql.exec(
          `UPDATE due_monitors SET claimed_until=?, last_claimed_at=?, next_scan_at=?, updated_at=?
           WHERE tenant_id=? AND monitor_id=?`,
          claimedUntil, now, nextScanAt, nowIso(), row.tenant_id, row.monitor_id
        );
        claimed.push({
          tenantId: row.tenant_id,
          monitorId: row.monitor_id,
          priority: row.priority,
          nextScanAt,
          scanIntervalSec: row.scan_interval_sec,
          claimedUntil
        });
      }
      return json({ claimed, now, leaseSec });
    });
  }

  private stats(): Response {
    const now = nowIso();
    const totals = rows(this.sql.exec<{ total: number; active: number; due: number; claimed: number }>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status='active' AND next_scan_at <= ? AND (claimed_until IS NULL OR claimed_until < ?) THEN 1 ELSE 0 END) AS due,
         SUM(CASE WHEN claimed_until IS NOT NULL AND claimed_until >= ? THEN 1 ELSE 0 END) AS claimed
       FROM due_monitors`,
      now, now, now
    ))[0];
    return json({
      total: totals?.total ?? 0,
      active: totals?.active ?? 0,
      due: totals?.due ?? 0,
      claimed: totals?.claimed ?? 0
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/browser-pool/reset" || url.pathname === "/internal/browser-pool/state") {
      const allowed = browserPoolAdminAllowed(env.BROWSER_POOL_RESET_TOKEN, request.headers.get("authorization"));
      if (allowed === "not_configured") return json({ error: "reset_not_configured" }, 503);
      if (allowed === "unauthorized") return json({ error: "unauthorized" }, 401);
      if (!env.BROWSER_POOL_DO) return json({ error: "browser_pool_unbound" }, 500);
      const stub = env.BROWSER_POOL_DO.get(env.BROWSER_POOL_DO.idFromName("global"));
      if (request.method === "POST" && url.pathname === "/internal/browser-pool/reset") {
        return stub.fetch("https://do.internal/internal/reset", { method: "POST", body: "{}" });
      }
      if (request.method === "GET" && url.pathname === "/internal/browser-pool/state") {
        return stub.fetch("https://do.internal/internal/state");
      }
      return json({ error: "method_not_allowed" }, 405);
    }
    return json({ service: "state", status: "ok" });
  }
};
