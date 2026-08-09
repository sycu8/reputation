# PulseWatch Brand Kit

## Official identity

| Layer | Value |
|---|---|
| Product name | **PulseWatch** |
| Endorsed brand | **PulseWatch by OrangeCloud** |
| Production URL | https://reputation.orangecloud.vn |
| Primary tagline | Know what's being said. Before it spreads. |
| Homepage H1 | Know what the Internet is saying about you. |

## Lockup

Preferred vertical lockup:

```
[mark]  PulseWatch
        by OrangeCloud
```

- **PulseWatch** carries visual emphasis (display weight, larger size).
- **by OrangeCloud** is secondary (smaller, muted).
- Do **not** use an “R” monogram. The mark represents pulse, radar, monitoring signal, and conversation activity.

Asset: `apps/dashboard/public/brand-mark.svg` (conversation bubble + radar signal)

## Surfaces

- Marketing homepage: `/` — `apps/dashboard/public/index.html`
- Product app: `/app/` — `apps/dashboard/public/app/index.html`
- API docs: `/docs/index.html`

## Palette

| Token | Hex | Use |
|---|---|---|
| Orange | `#F97316` | Primary accent, CTAs, brand mark |
| Deep Navy | `#0B1220` | Sidebar / deep surfaces |
| Midnight | `#111827` | Dark ink / dark panels |
| Cloud White | `#F8FAFC` | Light backgrounds |
| Slate | `#64748B` | Muted body / secondary text |
| Positive | `#22C55E` | Healthy / positive sentiment |
| Info | `#3B82F6` | Informational |
| Warning | `#F59E0B` | Degraded / caution |
| Critical | `#EF4444` | Alerts / negative severity |

## Typography

- Display: Sora (brand wordmark, H1)
- Body: IBM Plex Sans
- Code: IBM Plex Mono

## Public plan names

| Technical key | Public label | Stripe payment link |
|---|---|---|
| `starter` | PulseWatch Starter | https://buy.stripe.com/8x200j4O2674e5U8aUcZa02 |
| `pro` | PulseWatch Pro | https://buy.stripe.com/6oU7sLgwKgLI0f4cracZa03 |
| `business` | PulseWatch Business | https://buy.stripe.com/8x29ATfsGfHE1j8dvecZa04 |

Do **not** expose the internal Super Admin plan in pricing UI or marketing.

Landing pricing CTAs and in-app Settings → Billing open these Stripe Payment Links.

## What not to rename

Keep technical identifiers such as worker names (`reputa-*`), hostname `reputation.orangecloud.vn`, cookie `reputa_session`, queue/KV/R2 names, and Durable Object class names unless a dedicated migration is planned.
