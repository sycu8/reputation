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

/** Official pages / profiles to collect alongside keyword listening. */
export interface MonitorProfile {
  website?: string | null;
  facebook?: string | null;
  x?: string | null;
  linkedin?: string | null;
  youtube?: string | null;
  tiktok?: string | null;
  instagram?: string | null;
  reddit?: string | null;
  notes?: string | null;
}

export const MONITOR_PROFILE_LINK_KEYS = [
  "website",
  "facebook",
  "x",
  "linkedin",
  "youtube",
  "tiktok",
  "instagram",
  "reddit"
] as const;

export type MonitorProfileLinkKey = (typeof MONITOR_PROFILE_LINK_KEYS)[number];

function normalizeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Sanitize optional website / social profile URLs and notes. */
export function normalizeMonitorProfile(input: unknown): MonitorProfile {
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const profile: MonitorProfile = {};
  for (const key of MONITOR_PROFILE_LINK_KEYS) {
    const normalized = normalizeHttpUrl(raw[key]);
    if (normalized) profile[key] = normalized;
  }
  if (typeof raw.notes === "string" && raw.notes.trim()) {
    profile.notes = raw.notes.trim().slice(0, 500);
  }
  return profile;
}

export function parseMonitorProfileJson(raw: string | null | undefined): MonitorProfile {
  if (!raw) return {};
  try {
    return normalizeMonitorProfile(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

/** Flatten profile URLs for discovery / crawl seeding. */
export function monitorProfileUrls(profile: MonitorProfile | null | undefined): Array<{ key: MonitorProfileLinkKey; url: string }> {
  if (!profile) return [];
  const out: Array<{ key: MonitorProfileLinkKey; url: string }> = [];
  for (const key of MONITOR_PROFILE_LINK_KEYS) {
    const value = profile[key];
    if (typeof value === "string" && value) out.push({ key, url: value });
  }
  return out;
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
  nextScanAt: string | null;
  lastScanAt: string | null;
  profile: MonitorProfile;
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
