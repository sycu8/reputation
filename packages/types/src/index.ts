export type WorkspaceRole = "owner" | "admin" | "analyst" | "viewer";
export type GlobalRole = "user" | "super_admin";
export type AccountStatus = "pending_verification" | "active" | "suspended" | "deleted";
export type MonitorStatus = "active" | "paused" | "archived";
export type MonitorType = "person" | "company" | "brand" | "product";

export interface AuthContext {
  userId: string;
  userShard: string;
  email: string;
  globalRole: GlobalRole;
  sessionId: string;
}

export interface WorkspaceMembership {
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
}

export interface MonitorRecord {
  id: string;
  tenantId: string;
  name: string;
  type: MonitorType;
  status: MonitorStatus;
  defaultLanguage: string | null;
  scanIntervalSec: number;
  alertThreshold: number;
  createdAt: string;
  updatedAt: string;
}

export interface QueryRecord {
  id: string;
  rawQuery: string;
  normalizedQuery: string;
  astJson: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
