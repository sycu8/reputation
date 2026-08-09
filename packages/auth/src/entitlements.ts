export type CustomerPlan = "starter" | "pro" | "business";

export interface PlanEntitlements {
  plan: CustomerPlan;
  /** Customer-facing plan label. Super Admin is never a public plan. */
  displayName: string;
  monitorMaxActive: number;
  mentionMonthlyIncluded: number;
  scanMinIntervalSeconds: number;
  teamMaxSeats: number;
}

/** Technical entitlement tiers. Commercial pricing is not stored in-repo. */
export const PLAN_ENTITLEMENTS: Record<CustomerPlan, PlanEntitlements> = {
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
  const entitlements = PLAN_ENTITLEMENTS[plan as CustomerPlan] ?? PLAN_ENTITLEMENTS.starter;
  return { unlimited: false, value: entitlements.monitorMaxActive };
}
