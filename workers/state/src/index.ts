import { advanceNextScanAt, claimLeaseUntil, isClaimable } from "../../../packages/crawler-core/src/index.ts";
import { hammingDistance64, simHashFromHex } from "../../../packages/dedupe/src/index.ts";
import type { GlobalRole, MonitorRecord, MonitorStatus, MonitorType, QueryRecord, WorkspaceRole } from "../../../packages/types/src/index.ts";

interface Env {}

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
    this.sql.exec(`INSERT OR IGNORE INTO tenants(id,name,plan,status,created_at,updated_at) VALUES(?,?,?,?,?,?)`, id, name, "starter", "active", ts, ts);
    this.sql.exec(
      `INSERT INTO memberships(user_id,role,created_at,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET role=excluded.role, updated_at=excluded.updated_at`,
      ownerUserId, "owner", ts, ts
    );
    this.audit(ownerUserId, "workspace.create", "workspace", id, { name });
    return json({ id, name, plan: "starter", status: "active" }, 201);
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
      `SELECT monitor_id,name,type,status,priority,next_scan_at,created_at,updated_at FROM monitor_directory ORDER BY created_at DESC`
    ));
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
    const ts = nowIso();
    this.sql.exec(
      `INSERT INTO monitor_directory(monitor_id,name,type,status,priority,next_scan_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
      monitorId, name, type, status, priority, nextScanAt, ts, ts
    );
    this.audit(actorUserId, "monitor.create", "monitor", monitorId, { name, type, nextScanAt });
    return json({ ok: true }, 201);
  }

  private async updateMonitorEntry(request: Request, monitorId: string): Promise<Response> {
    const body = await readJson(request);
    const actorUserId = asString(body.actorUserId, "actor_user_id");
    const current = rows(this.sql.exec<{ name: string; type: string; status: string; priority: string; next_scan_at: string | null }>(
      `SELECT name,type,status,priority,next_scan_at FROM monitor_directory WHERE monitor_id = ? LIMIT 1`, monitorId
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
    this.sql.exec(
      `UPDATE monitor_directory SET name=?,type=?,status=?,priority=?,next_scan_at=?,updated_at=? WHERE monitor_id=?`,
      name, type, status, priority, nextScanAt, nowIso(), monitorId
    );
    this.audit(actorUserId, "monitor.update", "monitor", monitorId, { name, type, status, priority, nextScanAt });
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
    const allowed = new Set(["starter", "pro", "business"]);
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
      if (request.method === "GET" && url.pathname === "/internal/alerts") return this.listAlerts();
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
    this.sql.exec(
      `INSERT OR IGNORE INTO monitor(id,tenant_id,name,type,status,default_language,scan_interval_sec,alert_threshold,next_scan_at,last_scan_at,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, tenantId, name, type, "active", defaultLanguage, scanIntervalSec, alertThreshold, nextScanAt, null, ts, ts
    );
    return this.getMonitor();
  }

  private getMonitor(): Response {
    const item = rows(this.sql.exec<{
      id: string; tenant_id: string; name: string; type: MonitorType; status: MonitorStatus;
      default_language: string | null; scan_interval_sec: number; alert_threshold: number;
      next_scan_at: string | null; last_scan_at: string | null; created_at: string; updated_at: string;
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
    this.sql.exec(
      `UPDATE monitor SET name=?,type=?,status=?,default_language=?,scan_interval_sec=?,alert_threshold=?,next_scan_at=?,updated_at=? WHERE id=?`,
      name, type, status, defaultLanguage, scanIntervalSec, alertThreshold, nextScanAt, nowIso(), current.id
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
    const clauses = ["severity_score >= ?"];
    const params: unknown[] = [Number.isFinite(minSeverity) ? minSeverity : 0];
    if (sentiment) { clauses.push("sentiment = ?"); params.push(sentiment); }
    if (source) { clauses.push("source = ?"); params.push(source); }
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

  private listAlerts(): Response {
    const alerts = rows(this.sql.exec<Record<string, unknown>>(`SELECT * FROM alerts ORDER BY created_at DESC LIMIT 200`));
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
    if (!state || !new Set(["pending", "sent", "acknowledged", "resolved", "failed"]).has(state)) return json({ error: "invalid_alert_state" }, 400);
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

export class DomainCoordinatorDO extends SqliteObject {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS domain_state (
      key TEXT PRIMARY KEY, domain TEXT NOT NULL, next_allowed_at INTEGER NOT NULL DEFAULT 0,
      active_requests INTEGER NOT NULL DEFAULT 0, consecutive_errors INTEGER NOT NULL DEFAULT 0,
      recent_429 INTEGER NOT NULL DEFAULT 0, recent_403 INTEGER NOT NULL DEFAULT 0,
      backoff_until INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    )`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/internal/acquire") {
      const body = await readJson(request);
      const domain = asString(body.domain, "domain").toLowerCase();
      const maxConcurrency = typeof body.maxConcurrency === "number" ? Math.max(1, Math.min(8, Math.floor(body.maxConcurrency))) : 2;
      const minDelayMs = typeof body.minDelayMs === "number" ? Math.max(0, Math.min(60_000, Math.floor(body.minDelayMs))) : 500;
      const currentTime = Date.now();
      return this.state.storage.transaction(async () => {
        const row = rows(this.sql.exec<{ active_requests: number; next_allowed_at: number; backoff_until: number }>(
          `SELECT active_requests,next_allowed_at,backoff_until FROM domain_state WHERE key='self' LIMIT 1`
        ))[0];
        if (!row) {
          this.sql.exec(
            `INSERT INTO domain_state(key,domain,next_allowed_at,active_requests,updated_at) VALUES('self',?,?,1,?)`,
            domain, currentTime + minDelayMs, nowIso()
          );
          return json({ granted: true, leaseId: crypto.randomUUID(), retryAfterMs: 0 });
        }
        const blockedUntil = Math.max(row.next_allowed_at, row.backoff_until);
        if (row.active_requests >= maxConcurrency || blockedUntil > currentTime) {
          return json({ granted: false, retryAfterMs: Math.max(250, blockedUntil - currentTime) }, 429);
        }
        this.sql.exec(
          `UPDATE domain_state SET active_requests=active_requests+1,next_allowed_at=?,updated_at=? WHERE key='self'`,
          currentTime + minDelayMs, nowIso()
        );
        return json({ granted: true, leaseId: crypto.randomUUID(), retryAfterMs: 0 });
      });
    }
    if (request.method === "POST" && url.pathname === "/internal/release") {
      const body = await readJson(request);
      const status = typeof body.status === "number" ? body.status : 200;
      const retryAfterMs = typeof body.retryAfterMs === "number" ? Math.max(0, Math.floor(body.retryAfterMs)) : 0;
      const now = Date.now();
      this.sql.exec(
        `UPDATE domain_state SET
          active_requests=MAX(active_requests-1,0),
          consecutive_errors=CASE WHEN ? >= 500 THEN consecutive_errors+1 ELSE 0 END,
          recent_429=CASE WHEN ? = 429 THEN recent_429+1 ELSE recent_429 END,
          recent_403=CASE WHEN ? = 403 THEN recent_403+1 ELSE recent_403 END,
          backoff_until=CASE WHEN ? IN (429,403) THEN MAX(backoff_until, ?) ELSE backoff_until END,
          updated_at=? WHERE key='self'`,
        status, status, status, status, now + retryAfterMs, nowIso()
      );
      return json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/internal/state") {
      return json({ state: rows(this.sql.exec<Record<string, unknown>>(`SELECT * FROM domain_state WHERE key='self' LIMIT 1`))[0] ?? null });
    }
    return json({ error: "not_found" }, 404);
  }
}

export class BrowserPoolDO extends SqliteObject {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS pool_state (
      key TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 0, max_active INTEGER NOT NULL DEFAULT 100, updated_at TEXT NOT NULL
    )`);
    this.sql.exec(`INSERT OR IGNORE INTO pool_state(key,active,max_active,updated_at) VALUES('global',0,100,?)`, nowIso());
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/internal/acquire") {
      const body = await readJson(request);
      const requestedMax = typeof body.maxActive === "number" ? Math.max(1, Math.min(110, Math.floor(body.maxActive))) : 100;
      return this.state.storage.transaction(async () => {
        const row = rows(this.sql.exec<{ active: number; max_active: number }>(`SELECT active,max_active FROM pool_state WHERE key='global' LIMIT 1`))[0]!;
        const effectiveMax = Math.min(row.max_active, requestedMax);
        if (row.active >= effectiveMax) return json({ granted: false, retryAfterMs: 1000 }, 429);
        this.sql.exec(`UPDATE pool_state SET active=active+1,updated_at=? WHERE key='global'`, nowIso());
        return json({ granted: true, leaseId: crypto.randomUUID(), active: row.active + 1, maxActive: effectiveMax });
      });
    }
    if (request.method === "POST" && url.pathname === "/internal/release") {
      this.sql.exec(`UPDATE pool_state SET active=MAX(active-1,0),updated_at=? WHERE key='global'`, nowIso());
      return json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/internal/state") {
      return json({ state: rows(this.sql.exec<Record<string, unknown>>(`SELECT * FROM pool_state WHERE key='global' LIMIT 1`))[0] });
    }
    return json({ error: "not_found" }, 404);
  }
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
  fetch(): Response {
    return json({ service: "state", status: "ok" });
  }
};
