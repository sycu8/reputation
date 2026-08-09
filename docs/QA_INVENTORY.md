# QA Inventory — PulseWatch local

Last updated: 2026-08-09  
Scope: user-facing dashboard + authenticated API under local production-like settings.  
Data: sanitized fixtures from `scripts/seed-local-qa.mjs` (fake brands/emails only).

## Roles

| Role | How represented | Capabilities under test |
|---|---|---|
| Anonymous | signed out | See auth forms, open Settings (API base), cannot access tenant data |
| Workspace owner | `owner@acme.example` | Full CRUD monitors/queries, mentions/alerts actions, billing checkout |
| Workspace viewer | `viewer@acme.example` on Acme | Read monitors/mentions/alerts; cannot create monitors |
| Other-tenant owner | `owner@beacon.example` | Isolated; cannot read Acme |
| Super admin | `ops@pulsewatch.example` (allowlist) | `/v1/admin/*`, plan bypass |

## Routes / views (dashboard)

| ID | Route/view | Entry | Primary inputs | Acceptance |
|---|---|---|---|---|
| D1 | Auth / Overview signed-out | load `/` | signup+login forms | Shows signup+login; sessionState=Signed out |
| D2 | Overview signed-in | nav Overview | — | Metrics >0 with seed; workspace name/role visible |
| D3 | Mentions | nav Mentions | monitor, sentiment, minSeverity, source, Apply | List+detail; filters narrow results |
| D4 | Alerts | nav Alerts | monitor, Refresh, Ack, Resolve | Lists alerts; Ack/Resolve update state |
| D5 | Monitors | nav Monitors | New monitor dialog | Lists seeded monitors; create adds row |
| D6 | Reports | nav Reports | Refresh aggregates | Live sentiment/source bars + per-monitor rollup from mention/alert APIs |
| D7 | Settings | nav Settings | API base URL, billing plan | Persists API base; owner can start stub checkout; viewer hides billing |
| D8 | Source health | nav Source health | — | Shows ≥9 sources with availability chips |
| D9 | New monitor modal | New monitor | name, type, query, Cancel/Create | Valid create succeeds; Cancel closes; invalid query errors; hidden for viewers |
| D10 | Sign out | Sign out | — | Returns to auth; /v1/me unauthorized |
| D11 | Mention feedback | Mentions detail | Relevant / Not relevant / Wrong sentiment / Resolved / Flag | POST feedback succeeds; toast confirms |
| D12 | Admin console | nav Admin (super_admin only) | Refresh tenants | Lists tenant registry + admin source health; hidden for non-ops |
| D13 | API docs | nav API docs / `/docs/index.html` | TOC, copy base URL | Professional reference for all public `/v1` routes |

## API surface

| ID | Method path | Roles | Acceptance / edge cases |
|---|---|---|---|
| A1 | GET `/health` | public | 200 `{status:"ok"}` |
| A2 | GET `/v1/source-health` | public | sources[] non-empty |
| A3 | POST `/v1/auth/signup` | public | 201+cookie; short password 400; duplicate shard 409 |
| A4 | POST `/v1/auth/login` | public | 200+cookie; bad password 401 |
| A5 | POST `/v1/auth/logout` | auth | revokes session |
| A6 | GET `/v1/me` | auth | returns user |
| A7 | GET/POST `/v1/workspaces` | auth | list memberships; create workspace |
| A8 | GET/POST `/v1/workspaces/:id/monitors` | member | list/create; cross-tenant 403; viewer create 403; plan limit 402 |
| A9 | GET/PATCH/DELETE monitor | member | update/delete owner ok |
| A10 | queries CRUD | member | invalid Boolean 400 |
| A11 | mentions list/detail/feedback | member | filters work; feedback actions accepted |
| A12 | alerts list/patch | member | ack/resolve only valid states |
| A13 | POST billing/checkout | owner/admin | stub URL; viewer 403 |
| A14 | POST billing/webhook | signed | idempotent event |
| A15 | GET `/v1/admin/tenants` | super_admin | 200 for ops; 403 owner |

## Finite risk-based edge cases (must cover)

1. Cross-tenant monitor/mention/alert access → 403
2. Viewer cannot create monitor → 403
3. Starter plan 4th monitor → 402
4. Invalid Boolean query on create → 400 toast/API
5. Empty monitor select on Mentions/Alerts → empty state, no throw
6. Min severity filter excludes low scores
7. Session revoke blocks subsequent API
8. CORS: disallowed origin does not get ACAO credentials header
9. Alert resolve then refresh stays resolved
10. Source health never fabricates “available” for contract-required social stubs without credentials
11. HTTP local/QA envs must not set `Secure` cookies
12. Session cookie shard parsing must strip `name=` prefix when seeding memberships
13. Dashboard API base defaults to same hostname as the page (avoid localhost vs 127.0.0.1 cookie mismatch)

## Bug log (local QA 2026-08-09)

| ID | Severity | Area | Repro | Expected | Actual | Evidence | Status |
|---|---|---|---|---|---|---|---|
| BUG-1 | Critical | Auth cookies | Open dashboard on `127.0.0.1:8788` with default API `localhost:8787` / `ENVIRONMENT=local-qa` | Login succeeds over HTTP | Login failed; `Set-Cookie` included `Secure` for non-prod env; hostname mismatch | `/opt/cursor/artifacts/qa-screenshots/` + curl Set-Cookie | **Fixed** — `useSecureCookies()` only for production/staging; API base defaults to `window.location.hostname` |
| BUG-2 | High | Viewer seed/UX | Login as `viewer@acme.example` | See Acme Listening monitors | Only Viewer Scratch; Acme membership upsert used wrong DO shard (`reputa_session=…`) | curl `/v1/workspaces` before fix | **Fixed** — `shardFromSessionCookie()`; seed asserts Acme membership; workspace switcher + Acme preference |
| BUG-3 | High | Monitor modal | Create monitor failure path | Clear toast, no crash | `Cannot read properties of null (reading 'reset')` after await; `method="dialog"` + stale `currentTarget` | computer-use screenshots | **Fixed** — capture form el before await; remove `method="dialog"`; clearer validation toasts |
| BUG-4 | Medium | Monitor modal | Submit with Type selected | Submits to API | Intermittent HTML5 “fill out this field” blocked submit | computer-use | **Fixed** — explicit selected type option + JS required checks |
| BUG-5 | Medium | Mentions UX | Open mention detail | Feedback actions available | Detail pane had no feedback controls despite API | inventory gap | **Fixed** — feedback buttons POST `/mentions/:id/feedback` |
| BUG-6 | Medium | Settings UX | Owner opens Settings | Billing checkout UI | Checkout API only; no Settings form | inventory gap | **Fixed** — plan select + stub checkout link |
| BUG-7 | Medium | Admin UX | Ops opens Admin | Tenant registry UI | Admin APIs only; no nav/panel | inventory gap | **Fixed** — Admin nav for `super_admin` |
| BUG-8 | Low | Reports UX | Nav Reports | Live aggregates | Stub copy only | inventory gap | **Fixed** — sentiment/source/monitor rollups |
| BUG-9 | Low | RBAC UX | Viewer on Monitors | New monitor hidden | Button visible; create 403 | inventory gap | **Fixed** — role-aware New monitor + billing visibility |

## Regression

- `npm run validate` — includes `tests/qa-inventory.test.mjs`
- Manual rerun: owner login, viewer Acme access, forbidden toast, plan-limit toast, mentions filter, alert ack — **PASS**
- UI gap closure (2026-08-09): mention feedback, billing checkout, admin console, live reports, role-aware New monitor — covered by inventory surface test + API A11/A13/A15

## Local QA commands

```bash
npm run qa:local          # API :8787 + dashboard :8788 with seeded data
npm run qa:inventory      # automated acceptance/edge inventory
```

Owner: `owner@acme.example` / `Local-QA-Passphrase-2026!`  
Viewer: `viewer@acme.example` / same password  
