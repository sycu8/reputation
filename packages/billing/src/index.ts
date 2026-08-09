import type { CustomerPlan } from "../../auth/src/entitlements.ts";

export interface BillingCheckoutInput {
  tenantId: string;
  plan: string;
  successUrl: string;
  cancelUrl: string;
}

export interface BillingPortalInput {
  tenantId: string;
  returnUrl: string;
}

export interface BillingWebhookEvent {
  eventId: string;
  type: string;
  tenantId?: string;
  plan?: string;
  status?: string;
  raw: unknown;
}

export interface BillingProvider {
  createCheckout(input: BillingCheckoutInput): Promise<{ checkoutUrl: string; providerRef: string }>;
  createPortalSession(input: BillingPortalInput): Promise<{ portalUrl: string }>;
  verifyWebhook(request: Request, secret: string): Promise<BillingWebhookEvent>;
}

const PRICE_TO_PLAN: Record<string, CustomerPlan> = {
  price_starter: "starter",
  price_pro: "pro",
  price_business: "business",
  stub_price_starter: "starter",
  stub_price_pro: "pro",
  stub_price_business: "business",
  "price_usd_29": "starter",
  "price_usd_49": "pro",
  "price_usd_99": "business"
};

export function planFromPriceId(priceId: string | undefined | null): CustomerPlan | null {
  if (!priceId) return null;
  return PRICE_TO_PLAN[priceId] ?? null;
}

function asPlan(value: unknown): CustomerPlan | undefined {
  if (value === "starter" || value === "pro" || value === "business") return value;
  if (typeof value === "string") {
    const fromPrice = planFromPriceId(value);
    if (fromPrice) return fromPrice;
  }
  return undefined;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class StubBillingProvider implements BillingProvider {
  async createCheckout(input: BillingCheckoutInput): Promise<{ checkoutUrl: string; providerRef: string }> {
    const plan = asPlan(input.plan) ?? "starter";
    const providerRef = `stub_checkout_${input.tenantId}_${plan}`;
    const checkoutUrl = `https://billing.stub.local/checkout?tenant=${encodeURIComponent(input.tenantId)}&plan=${encodeURIComponent(plan)}&ref=${encodeURIComponent(providerRef)}&success=${encodeURIComponent(input.successUrl)}&cancel=${encodeURIComponent(input.cancelUrl)}`;
    return { checkoutUrl, providerRef };
  }

  async createPortalSession(input: BillingPortalInput): Promise<{ portalUrl: string }> {
    const portalUrl = `https://billing.stub.local/portal?tenant=${encodeURIComponent(input.tenantId)}&return=${encodeURIComponent(input.returnUrl)}`;
    return { portalUrl };
  }

  async verifyWebhook(request: Request, secret: string): Promise<BillingWebhookEvent> {
    if (!secret) throw new Error("billing_webhook_secret_missing");
    const signature = request.headers.get("X-Billing-Signature") ?? "";
    const bodyText = await request.text();
    const hmac = await hmacSha256Hex(secret, bodyText);
    const valid = signature === secret || signature === hmac || signature === `sha256=${hmac}`;
    if (!valid) throw new Error("invalid_billing_signature");

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      throw new Error("invalid_billing_payload");
    }

    const eventId = typeof raw.eventId === "string" && raw.eventId.trim()
      ? raw.eventId.trim()
      : typeof raw.id === "string" && raw.id.trim()
        ? raw.id.trim()
        : "";
    if (!eventId) throw new Error("invalid_billing_event_id");

    const type = typeof raw.type === "string" && raw.type.trim() ? raw.type.trim() : "unknown";
    const data = (typeof raw.data === "object" && raw.data !== null ? raw.data : raw) as Record<string, unknown>;
    const tenantId = typeof data.tenantId === "string" ? data.tenantId
      : typeof raw.tenantId === "string" ? raw.tenantId
        : undefined;
    const plan = asPlan(data.plan) ?? asPlan(raw.plan) ?? planFromPriceId(typeof data.priceId === "string" ? data.priceId : null) ?? undefined;
    const status = typeof data.status === "string" ? data.status
      : typeof raw.status === "string" ? raw.status
        : undefined;

    const event: BillingWebhookEvent = { eventId, type, raw };
    if (tenantId !== undefined) event.tenantId = tenantId;
    if (plan !== undefined) event.plan = plan;
    if (status !== undefined) event.status = status;
    return event;
  }
}

export function createBillingProvider(name = "stub"): BillingProvider {
  if (name === "stub") return new StubBillingProvider();
  return new StubBillingProvider();
}
