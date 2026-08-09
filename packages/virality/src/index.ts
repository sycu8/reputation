export interface ViralityInput {
  likes?: number | undefined;
  comments?: number | undefined;
  shares?: number | undefined;
  views?: number | undefined;
  ageMinutes: number;
}

function finiteOrUndefined(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/**
 * Engagement-weighted virality score in [0, 100].
 * Missing metrics are ignored (not treated as zero). Age dampens raw volume.
 */
export function computeViralityScore(input: ViralityInput): number {
  const likes = finiteOrUndefined(input.likes);
  const comments = finiteOrUndefined(input.comments);
  const shares = finiteOrUndefined(input.shares);
  const views = finiteOrUndefined(input.views);
  const ageMinutes = Math.max(1, Number.isFinite(input.ageMinutes) ? input.ageMinutes : 1);

  let weighted = 0;
  let weightSum = 0;
  if (likes !== undefined) { weighted += likes * 1; weightSum += 1; }
  if (comments !== undefined) { weighted += comments * 3; weightSum += 3; }
  if (shares !== undefined) { weighted += shares * 5; weightSum += 5; }
  if (views !== undefined) { weighted += views * 0.05; weightSum += 0.05; }
  if (weightSum === 0) return 0;

  const perHour = (weighted / ageMinutes) * 60;
  // Log-scale map: ~10 weighted/hour → ~40, ~100 → ~70, ~1000 → ~90
  const score = (Math.log10(1 + perHour) / Math.log10(1 + 2000)) * 100;
  return Math.round(Math.min(100, Math.max(0, score)));
}

export interface EngagementSnapshot {
  at: string;
  engagement: number;
}

/** Average engagement gain per hour across consecutive snapshots; 0 if insufficient data. */
export function engagementVelocity(snapshots: Array<EngagementSnapshot>): number {
  if (!Array.isArray(snapshots) || snapshots.length < 2) return 0;
  const ordered = [...snapshots]
    .filter((item) => item && typeof item.at === "string" && typeof item.engagement === "number" && Number.isFinite(item.engagement))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (ordered.length < 2) return 0;

  let totalRate = 0;
  let segments = 0;
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]!;
    const next = ordered[i]!;
    const dtMs = Date.parse(next.at) - Date.parse(prev.at);
    if (!(dtMs > 0)) continue;
    const delta = next.engagement - prev.engagement;
    totalRate += (delta / dtMs) * 3_600_000;
    segments += 1;
  }
  if (!segments) return 0;
  return totalRate / segments;
}

/**
 * Cluster-aware alert gate: escalate when severity is material and either
 * virality is high or the cluster already has multiple mentions.
 */
export function shouldClusterAlert(severity: number, virality: number, clusterMentionCount: number): boolean {
  const sev = Math.max(0, Math.min(100, severity));
  const vir = Math.max(0, Math.min(100, virality));
  const count = Math.max(0, Math.floor(clusterMentionCount));
  if (sev < 50) return false;
  if (count >= 3 && sev >= 60) return true;
  if (vir >= 70 && sev >= 55) return true;
  if (count >= 2 && vir >= 40 && sev >= 60) return true;
  return false;
}
