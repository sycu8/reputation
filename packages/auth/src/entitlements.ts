export type CustomerPlan = "free" | "starter" | "pro" | "business";

export interface PlanEntitlements {
  plan: CustomerPlan;
  /** Customer-facing plan label. Super Admin is never a public plan. */
  displayName: string;
  monitorMaxActive: number;
  mentionMonthlyIncluded: number;
  scanMinIntervalSeconds: number;
  teamMaxSeats: number;
}

/**
 * Technical entitlement tiers.
 * Public list prices live in the marketing site and signed-in billing UI.
 */
export const PLAN_ENTITLEMENTS: Record<CustomerPlan, PlanEntitlements> = {
  free: {
    plan: "free",
    displayName: "PulseWatch Free",
    monitorMaxActive: 1,
    mentionMonthlyIncluded: 1_000,
    scanMinIntervalSeconds: 1_800,
    teamMaxSeats: 1
  },
  starter: {
    plan: "starter",
    displayName: "PulseWatch Starter",
    monitorMaxActive: 3,
    mentionMonthlyIncluded: 10_000,
    scanMinIntervalSeconds: 900,
    teamMaxSeats: 1
  },
  pro: {
    plan: "pro",
    displayName: "PulseWatch Pro",
    monitorMaxActive: 10,
    mentionMonthlyIncluded: 50_000,
    scanMinIntervalSeconds: 600,
    teamMaxSeats: 5
  },
  business: {
    plan: "business",
    displayName: "PulseWatch Business",
    monitorMaxActive: 30,
    mentionMonthlyIncluded: 200_000,
    scanMinIntervalSeconds: 300,
    teamMaxSeats: 15
  }
};

export function planDisplayName(plan: string): string {
  return PLAN_ENTITLEMENTS[plan as CustomerPlan]?.displayName ?? plan;
}

export interface EntitlementDecision {
  unlimited: boolean;
  value?: number;
}

export function monitorLimitFor(plan: string, superAdmin: boolean): EntitlementDecision {
  if (superAdmin) return { unlimited: true };
  const entitlements = PLAN_ENTITLEMENTS[plan as CustomerPlan] ?? PLAN_ENTITLEMENTS.free;
  return { unlimited: false, value: entitlements.monitorMaxActive };
}
