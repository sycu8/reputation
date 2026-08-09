export type Sentiment = "positive" | "neutral" | "negative";
export type SeverityBand = "low" | "medium" | "high" | "critical";

const RISK_BOOSTS: Record<string, number> = {
  fraud: 25,
  scam: 25,
  legal: 20,
  security_incident: 25,
  data_leak: 30,
  physical_safety: 30,
  executive_misconduct: 20,
  outage: 15,
  boycott: 15,
  media_investigation: 20,
  refund: 10,
  customer_service: 5
};

export interface SeverityInput {
  sentiment: Sentiment;
  sentimentConfidence: number;
  relevanceScore: number;
  riskCategories: string[];
  engagementScore?: number | undefined;
  viralityScore?: number | undefined;
}

export function calculateSeverity(input: SeverityInput): number {
  if (input.sentiment !== "negative") return 0;
  const confidence = Math.max(0, Math.min(1, input.sentimentConfidence));
  const relevance = Math.max(0, Math.min(100, input.relevanceScore)) / 100;
  let score = 25 + (confidence * 25) + (relevance * 10);
  for (const category of new Set(input.riskCategories)) score += RISK_BOOSTS[category] ?? 0;
  if (typeof input.engagementScore === "number") score += Math.min(10, Math.max(0, input.engagementScore / 10));
  if (typeof input.viralityScore === "number") score += Math.min(15, Math.max(0, input.viralityScore / 6.67));
  return Math.round(Math.min(100, Math.max(0, score)));
}

export function severityBand(score: number): SeverityBand {
  if (score >= 76) return "critical";
  if (score >= 51) return "high";
  if (score >= 26) return "medium";
  return "low";
}
