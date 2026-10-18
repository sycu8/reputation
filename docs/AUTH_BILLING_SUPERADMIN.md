# Authentication, Billing, Plans, Quotas, and Super Admin

## 1. Scope

This document is canonical for account registration, authentication, subscriptions, entitlement checks, usage metering, and the super-admin control plane.

The application runtime and persistent product state remain Cloudflare-native. Payment processing is an external financial dependency and must be isolated behind a billing-provider adapter. Never store raw card data.

## 2. Plans

Canonical monthly plan keys (technical entitlements only — commercial pricing is not stored in this repository):

| Plan key | Public label | Target | Monitors | Included relevant mentions/month | Default scan interval | Team seats |
|---|---|---|---:|---:|---|---:|
| `starter` | PulseWatch Starter | individual / small brand | 3 | 10,000 | 15 min | 1 |
| `pro` | PulseWatch Pro | professional / creator / SMB | 10 | 50,000 | 10 min | 5 |
| `business` | PulseWatch Business | business / agency-light | 30 | 200,000 | 5 min on active sources, adaptive otherwise | 15 |

Internal-only: Super Admin is a **role bypass**, not a customer plan. Never expose it in pricing UI or marketing.

The exact limits are product defaults, not hard-coded pricing. Store plan definitions as versioned configuration so they can change without migrations. Billing provider price IDs map to these keys outside the public docs.

## 3. Super Admin

Production operator allowlist is the Worker secret `SUPER_ADMIN_EMAILS` (comma-separated emails). `scripts/deploy-cloudspace.mjs` writes that secret only from the `SUPER_ADMIN_EMAILS` environment variable and fails if it is missing. There is no in-repo default allowlist.

Account password reset and lock are `POST /v1/admin/accounts/reset-password` and `POST /v1/admin/accounts/lock`. Both require an HMAC-SHA256 signature of the method, path, timestamp, nonce, and body hash in `X-Operator-Timestamp`, `X-Operator-Nonce`, and `X-Operator-Signature`. The raw `OPERATOR_ACCOUNT_SECRET` is only the HMAC key and is not a request header. A session alone, including `super_admin`, receives `403 operator_secret_required`. If an operator signature or the old secret header is present and `OPERATOR_ACCOUNT_SECRET` is unset, the route fails closed with `503 operator_secret_not_configured`. A missing, expired, replayed, or invalid signature is `401 invalid_operator_secret` and is not treated as a session. A request that still sends `X-Operator-Secret` is rejected the same way. The application does not read or log that header value. Cloudflare Workers Logs stores a legacy `X-Operator-Secret` header when a stale client sends it. No operator headers and no session is `401 authentication_required`. Failed attempts that present a valid session are written on that account as `account.password_reset_denied` or `account.lock_denied`, with actor `{userId}:{cf-ray}`. A successful call records actor `operator_secret:{cf-ray}` (`no-request-id` when the header is absent). Anonymous failures are not written, so a request without a session cannot create user Durable Objects through the audit path. Reset stores a new password hash and sets `revoked_at` on every session for that user Durable Object. Lock sets status `suspended` or `deleted` and revokes every session. Neither response nor the audit row includes the password, hash, or salt. Denial audit writes for one user id on one account stop after 8 in 60 seconds. The stored actor remains `{userId}:{cf-ray}`, and the cap ignores the ray, so a new request id does not reset the counter. That cap does not apply to a call with a valid operator secret. `GET /v1/admin/accounts/audit` returns the newest 50 events and a separate `mutations` list of `account.password_reset` and `account.lock` rows. `action=account.password_reset`, `action=account.lock`, or `action=mutations` reads those rows on their own, so denial rows cannot push a reset or lock out of view. Failed signature checks count toward 8 failures per client IP per 60 seconds in that Worker isolate, including requests that also send a cookie. The count is checked before the HMAC is compared. After 8 failures, the next attempt from that IP receives `429 rate_limited` with `Retry-After` and the signature is not compared. Valid signatures are not recorded. A signature is valid for 60 seconds, and the same Worker isolate rejects a reused nonce. That isolate removes a nonce only after it is older than 60 seconds. It does not evict an in-window nonce to make room. When 2048 in-window nonces are stored, the next new nonce is `429 rate_limited` with `Retry-After` and is not stored. That 429 does not count as a failed signature guess. The signed path drops one leading `/api` prefix, so `API_BASE=https://reputation.orangecloud.vn/api` and the workers.dev host sign the same `/v1/...` path. `scripts/operator-account.mjs audit` reads `GET /v1/admin/accounts/audit` for `TARGET_EMAIL` and prints the JSON. Deploy rejects `OPERATOR_ACCOUNT_SECRET` when it is empty or shorter than 43 characters. A session that does not send the signature headers is not part of that counter. `scripts/operator-account.mjs` waits for `Retry-After` and signs a new nonce on each retry. This is not a global Workers Rate Limiting binding. Generate `OPERATOR_ACCOUNT_SECRET` with `openssl rand -base64 32`. Reads (`GET /v1/admin/accounts`, account audit, and `GET /v1/admin/tenants`) still accept the operator secret or a `super_admin` session. The runbook is in `docs/SRE_RUNBOOK.md`. The signature scheme is not in production until this branch is merged and deployed. Production still accepts the raw `X-Operator-Secret` header from the previous deploy until then.

Matching emails receive role `super_admin` at signup. Existing accounts are promoted/demoted on authenticated requests so allowlist changes apply without re-signup. `super_admin` is never assignable through a public request body.

`super_admin` bypasses customer-facing plan quotas and subscription gates for product usage. It does not bypass:

- platform safety controls,
- source policy restrictions,
- SSRF protections,
- Cloudflare account hard limits,
- global emergency kill switches,
- per-domain politeness/rate limits.

Never represent super-admin unlimited access by assigning a huge numeric quota such as 999999999. Entitlement checks must support an explicit bypass flag.

## 4. Account lifecycle

States:

- `pending_verification`
- `active`
- `suspended`
- `deleted`

Subscription states:

- `trialing` (optional future use)
- `active`
- `past_due`
- `grace_period`
- `canceled`
- `expired`

User flow:

1. Sign up.
2. Verify identity/contact channel where configured.
3. Create or join workspace.
4. Select plan.
5. Checkout through billing provider.
6. Billing webhook updates authoritative subscription state.
7. Entitlements are recomputed.
8. User can create monitors within plan limits.

## 5. Authentication architecture

Preferred V1:

- Cloudflare Worker API gateway.
- User/account records in `TenantDirectoryDO` or a dedicated identity DO shard.
- WebAuthn/passkeys supported as the preferred high-assurance login method when practical.
- Password login may be supported using a reviewed password hashing implementation compatible with Workers; never store plaintext or reversible passwords.
- Session tokens are short-lived, signed, and rotated.
- Refresh/session state is strongly consistent and revocable.
- Turnstile on sign-up, login abuse paths, password reset, and suspicious actions.
- RBAC at every service boundary.

Roles:

- `super_admin`
- `workspace_owner`
- `workspace_admin`
- `analyst`
- `viewer`

Permissions must be explicit capabilities, not scattered role string checks.

## 6. Session model

Session record fields:

- session_id
- user_id
- tenant_id (nullable before workspace selection)
- created_at
- expires_at
- revoked_at
- last_seen_at
- device_hash (privacy-preserving)
- auth_strength

Do not put authorization truth only inside a long-lived JWT. A stolen token must be revocable.

## 7. Billing provider abstraction

Create an interface such as:

```ts
interface BillingProvider {
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>;
  createPortalSession(input: PortalInput): Promise<PortalResult>;
  verifyWebhook(request: Request): Promise<BillingEvent>;
}
```

Stripe can be the first provider, but the domain model must not depend on Stripe-specific names.

Billing webhook consumer requirements:

- signature verification,
- idempotency key/event ID storage,
- replay safety,
- ordering-tolerant state machine,
- audit trail,
- no user-controlled plan claims,
- reconciliation job for missed webhooks.

## 8. Entitlement model

Entitlements are derived from plan version + subscription status + overrides.

Examples:

- `monitor.max_active`
- `query.max_per_monitor`
- `mention.monthly_included`
- `scan.min_interval_seconds`
- `browser.monthly_budget_ms`
- `ai.monthly_budget_units`
- `team.max_seats`
- `alert.telegram.enabled`
- `alert.email.enabled`
- `alert.webhook.enabled`
- `report.daily.enabled`
- `report.weekly.enabled`

Entitlements must be evaluated server-side before job creation, not only in UI.

## 9. Usage metering

Meter at least:

- discovery queries,
- URLs fetched,
- Browser Run milliseconds,
- relevant mentions accepted,
- AI classification units,
- embeddings generated,
- R2 bytes stored,
- alerts sent,
- report generations.

Use `TenantBudgetDO` for strongly consistent per-tenant counters/budget decisions. Emit append-only observability usage events to Analytics Engine for analysis; Analytics Engine is not the billing source of truth.

## 10. Quota behavior

Soft limit at 80%: show warning.

Hard-plan limit: do not silently stop critical monitoring. Apply this order:

1. Continue already-discovered high/critical negative processing.
2. Reduce background refresh frequency.
3. Reduce browser escalation for low-priority pages.
4. Suspend low-priority discovery.
5. Ask customer to upgrade.

Never downgrade source coverage invisibly. UI must show degraded coverage state.

## 11. Admin console

Super admin screens:

- tenants
- users
- subscriptions
- plans and plan versions
- entitlement overrides
- usage and cost
- source health
- queue health
- crawler/browser health
- AI usage
- alerts
- audit events
- tenant suspension
- emergency source disable
- global kill switches

Sensitive actions require audit events and re-authentication.

## 12. Required data tables / entities

Identity directory:

- users
- credentials
- sessions
- workspaces
- memberships
- invitations
- audit_events

Billing:

- plans
- plan_versions
- subscriptions
- billing_customers
- billing_events
- entitlement_overrides
- usage_counters
- usage_periods

## 13. Security acceptance criteria

- Tenant A cannot use any ID/URL manipulation to read Tenant B.
- Passwords/credentials are never logged.
- Billing webhook replay is idempotent.
- Client cannot grant itself a paid plan.
- A revoked session cannot continue to create scans.
- `super_admin` is never assignable through public APIs.
- Super-admin actions are fully audited.
- Rate limits and Turnstile are applied to abuse-sensitive auth endpoints.

## 14. Pricing-product principle

Plan quotas are economic safety rails, not the primary user experience. Shared discovery, crawl-once/match-many, fetch-first/browser-second, cheap-first AI, adaptive scheduling, and source-level cache reuse keep unit costs manageable.
