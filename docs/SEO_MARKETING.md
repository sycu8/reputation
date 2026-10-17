# PulseWatch SEO & Marketing Metadata

Production site: https://reputation.orangecloud.vn

## Homepage

Marketing landing: `/` (`apps/dashboard/public/index.html`) — public, no login  
Product app: `/app/` (`apps/dashboard/public/app/index.html`) — sign-in for workspace

| Field | Value |
|---|---|
| `<title>` | PulseWatch \| Social Listening & Reputation Monitoring by OrangeCloud |
| H1 | Know what the Internet is saying about you. |
| Meta description | PulseWatch by OrangeCloud monitors online mentions across the public web and supported social platforms, analyzes sentiment, and alerts you to important negative conversations. |
| Open Graph title | Know What's Being Said Before It Spreads \| PulseWatch |
| Open Graph description | Continuous social listening and reputation monitoring for people, professionals and businesses. |
| `og:url` | https://reputation.orangecloud.vn/ |
| `og:type` | website |
| Canonical | https://reputation.orangecloud.vn/ |

## Brand strings for SEO surfaces

- Primary: **PulseWatch**
- Endorsed: **PulseWatch by OrangeCloud**
- Tagline: Know what's being said. Before it spreads.

## Plan naming (public)

- PulseWatch Starter
- PulseWatch Pro
- PulseWatch Business

Stripe Payment Links are used only inside the signed-in app (Settings → Billing), not on the marketing homepage.

Never index or promote Super Admin as a customer plan.

## API docs page

- Title may remain product-scoped (e.g. “PulseWatch API Reference”).
- Prefer “PulseWatch by OrangeCloud” in footer / shared chrome.
- Base URL examples use https://reputation.orangecloud.vn/api

## Agent discovery

Public origin files (plain responses, not the marketing HTML shell):

| Path | Content type | Role |
|---|---|---|
| `/robots.txt` | `text/plain` | Crawl rules, AI crawler groups, Content-Signal, sitemap |
| `/sitemap.xml` | `application/xml` | Canonical public URLs |
| `/.well-known/api-catalog` | `application/linkset+json` | RFC 9727 API catalog |
| `/openapi.json` | `application/json` | OpenAPI description |
| `/auth.md` | `text/markdown` | Agent registration instructions |
| `/.well-known/oauth-protected-resource` | `application/json` | RFC 9728 resource metadata |
| `/.well-known/oauth-authorization-server` | `application/json` | Session login discovery |
| `/.well-known/mcp/server-card.json` | `application/json` | MCP server card |
| `/.well-known/agent-skills/index.json` | `application/json` | Agent skills index |
| `/.well-known/ai-catalog.json` | `application/json` | ARD capability manifest |

The homepage sends RFC 8288 `Link` headers for `api-catalog`, `service-desc`, `service-doc`, and `describedby`.

DNS-AID SVCB/HTTPS records for `_index._agents.reputation.orangecloud.vn` are published by `scripts/deploy-cloudspace.mjs` when the API token can edit zone DNS. DNSSEC is not turned on by that script.

## Technical hostnames

`reputation.orangecloud.vn` and `reputa-*-production.sycu-lee.workers.dev` are infrastructure hostnames. Keep them in docs and configs; do not treat them as the product display name.
