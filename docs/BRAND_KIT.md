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

- Marketing homepage: `/` — `apps/dashboard/public/index.html` (public; no login)
- Product app: `/app/` — `apps/dashboard/public/app/index.html` (auth required for workspace)
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

| Technical key | Public label |
|---|---|
| `starter` | PulseWatch Starter |
| `pro` | PulseWatch Pro |
| `business` | PulseWatch Business |

Do **not** expose the internal Super Admin plan in pricing UI or marketing.

## What not to rename

Keep technical identifiers such as worker names (`reputa-*`), hostname `reputation.orangecloud.vn`, cookie `reputa_session`, queue/KV/R2 names, and Durable Object class names unless a dedicated migration is planned.
