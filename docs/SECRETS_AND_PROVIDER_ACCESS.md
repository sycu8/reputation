# Secrets and Provider Access Checklist

Never commit real values from this checklist.

## Cloudflare

Required at deploy/operator level:
- Cloudflare auth with access to account `Cloudspace`.
- Permission to manage Workers, Durable Objects, R2, KV, Queues, Browser Run, Workers AI, Vectorize, Analytics Engine, DNS/Workers Routes and Email Service as required.

## Discovery/search

Current code includes a Brave broad-web discovery path.
- `BRAVE_SEARCH_API_KEY` (or the exact env name currently used by source code; inspect before configuring)

Add providers behind source-adapter interfaces rather than hard-coding provider logic into the pipeline.

## Social/native source credentials

Only configure credentials for access actually approved for this commercial use case.
Potential adapters:
- YouTube Data API key/OAuth as required
- X API credentials/plan
- Reddit approved commercial/API credentials or licensed-provider contract
- Meta/Facebook permissions/products appropriate to the supported public data use case
- TikTok approved commercial/public access mechanism if available for the required data
- LinkedIn approved products/permissions if available for the required data

If access is unavailable, adapter status must be `contract-required`, `degraded` or `disabled`; never substitute login scraping/CAPTCHA bypass.

## Alerts

- Telegram bot token and target/chat configuration if Telegram alerts are enabled
- Cloudflare Email Service verified sender/domain configuration if email alerts are enabled

The repo currently contains placeholder email values; do not treat them as production configuration.

## Billing

The billing architecture is provider-abstracted. Configure a real payment provider only after inspecting `docs/AUTH_BILLING_SUPERADMIN.md` and the implementation.
Likely secret categories:
- payment provider secret API key
- webhook signing secret
- price/product IDs as non-secret configuration where appropriate

Do not store full card data in Workers, R2, KV or Durable Objects.

## Super admin bootstrap

Do not expose `super_admin` assignment through public signup/profile APIs.
Bootstrap the owner using an explicit secure operator-only procedure and record an audit event.
