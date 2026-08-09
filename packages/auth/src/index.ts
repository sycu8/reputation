import type { GlobalRole, WorkspaceRole } from "../../types/src/index.ts";

export type Capability =
  | "workspace.read"
  | "workspace.update"
  | "membership.manage"
  | "monitor.read"
  | "monitor.create"
  | "monitor.update"
  | "monitor.delete"
  | "query.read"
  | "query.create"
  | "query.update"
  | "query.delete";

const ROLE_CAPABILITIES: Record<WorkspaceRole, ReadonlySet<Capability>> = {
  owner: new Set([
    "workspace.read", "workspace.update", "membership.manage",
    "monitor.read", "monitor.create", "monitor.update", "monitor.delete",
    "query.read", "query.create", "query.update", "query.delete"
  ]),
  admin: new Set([
    "workspace.read", "workspace.update", "membership.manage",
    "monitor.read", "monitor.create", "monitor.update", "monitor.delete",
    "query.read", "query.create", "query.update", "query.delete"
  ]),
  analyst: new Set([
    "workspace.read", "monitor.read", "monitor.create", "monitor.update",
    "query.read", "query.create", "query.update"
  ]),
  viewer: new Set(["workspace.read", "monitor.read", "query.read"])
};

export function hasCapability(
  role: WorkspaceRole,
  capability: Capability,
  globalRole: GlobalRole = "user"
): boolean {
  if (globalRole === "super_admin") return true;
  return ROLE_CAPABILITIES[role].has(capability);
}

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return value === "owner" || value === "admin" || value === "analyst" || value === "viewer";
}

export function isSuperAdminEmail(email: string, configured: string | undefined): boolean {
  if (!configured) return false;
  const normalized = email.trim().toLowerCase();
  return configured
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .includes(normalized);
}

export { monitorLimitFor, PLAN_ENTITLEMENTS, planDisplayName } from "./entitlements.ts";
export type { CustomerPlan, PlanEntitlements, EntitlementDecision } from "./entitlements.ts";
