export type CustomerPlan = "starter" | "pro" | "business";

export interface PlanEntitlements {
  plan: CustomerPlan;
  priceUsdMonthly: number;
  monitorMaxActive: number;
  mentionMonthlyIncluded: number;
  scanMinIntervalSeconds: number;
  teamMaxSeats: number;
}

export const PLAN_ENTITLEMENTS: Record<CustomerPlan, PlanEntitlements> = {
  starter: {
    plan: "starter",
    priceUsdMonthly: 29,
    monitorMaxActive: 3,
    mentionMonthlyIncluded: 10_000,
    scanMinIntervalSeconds: 900,
    teamMaxSeats: 1
  },
  pro: {
    plan: "pro",
    priceUsdMonthly: 49,
    monitorMaxActive: 10,
    mentionMonthlyIncluded: 50_000,
    scanMinIntervalSeconds: 600,
    teamMaxSeats: 5
  },
  business: {
    plan: "business",
    priceUsdMonthly: 99,
    monitorMaxActive: 30,
    mentionMonthlyIncluded: 200_000,
    scanMinIntervalSeconds: 300,
    teamMaxSeats: 15
  }
};

export interface EntitlementDecision {
  unlimited: boolean;
  value?: number;
}

export function monitorLimitFor(plan: string, superAdmin: boolean): EntitlementDecision {
  if (superAdmin) return { unlimited: true };
  const entitlements = PLAN_ENTITLEMENTS[plan as CustomerPlan] ?? PLAN_ENTITLEMENTS.starter;
  return { unlimited: false, value: entitlements.monitorMaxActive };
}
