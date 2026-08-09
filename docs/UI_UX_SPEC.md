# UI/UX Specification — V1

## 1. Design objective

The interface must answer the customer's core question within 30 seconds:

> What is being said about my monitor right now, and what needs my attention?

The product is a professional monitoring tool, not a generic analytics dashboard. Optimize for speed, clarity, density, and trust.

## 2. Information architecture

Desktop sidebar:

1. Overview
2. Mentions
3. Alerts
4. Monitors
5. Reports
6. Settings

Top bar:

- workspace switcher
- global time range
- source health indicator
- notification icon
- user/account menu

Mobile navigation may collapse to Overview, Mentions, Alerts, More.

## 3. Global interaction rules

- Latest information is always the default ordering.
- Negative and Critical states are visually prominent but must not create panic from low-confidence classifications.
- Every AI label that can materially affect a customer's action exposes a reason/explanation.
- Never hide a source limitation. Source coverage status is visible in monitor settings and source-health details.
- Every feed/list supports loading, empty, partial-data, degraded-source, error, and permission states.
- Preserve filter state in URL query parameters.
- Keyboard navigation and accessible labels are required.
- Target responsive breakpoints: mobile <768 px, tablet 768-1199 px, desktop >=1200 px.

## 4. Screen: Overview

### Primary job

Give the customer a morning/real-time operational brief without requiring them to inspect every mention.

### Header

- workspace name
- monitor selector: All monitors or one monitor
- time range: 1h, 6h, 24h, 7d, 30d, custom
- `Create monitor` primary action

### KPI row

Cards:

1. Mentions
2. Negative
3. Critical/High alerts
4. Positive
5. Potential reach when source data supports it

Each card shows:

- current value
- comparison vs previous equal-length period
- small direction indicator
- data-coverage tooltip

Do not compute fake reach for sources without reliable metrics.

### AI brief

Card title: `What matters now`

Content structure:

- 1 sentence on volume change
- 1 sentence on sentiment mix
- 1 sentence on dominant negative topic if any
- 1 sentence on most important source/story
- severity recommendation: Normal / Watch / High / Critical

Actions:

- View negative mentions
- View story/mention causing alert

### Mention volume chart

Series:

- All mentions
- Negative mentions toggle

Bucket size adapts to time range.

### Sentiment chart

Stacked/line representation of Positive, Neutral, Negative.

### Priority feed

Max 10 items. Sort by priority score, then freshness.

Each row:

- severity badge
- source icon/name
- relative time
- title/excerpt
- monitor name
- sentiment confidence
- engagement trend if available
- source-health indicator if data is partial

## 5. Screen: Mentions

### Layout

Desktop:

- left/top filter bar
- main results feed
- optional right preview pane on wide displays

### Default sort

`discovered_at DESC`

Alternative sorts:

- Published newest
- Severity highest
- Engagement highest
- Relevance highest

### Filters

- monitor
- time range
- sentiment
- severity
- source
- topic
- language
- relevance confidence
- status: new/reviewed/resolved/not relevant

### Mention card

Required fields:

- source
- author if available
- published/discovered time
- title or content excerpt
- matched keyword/query clause
- sentiment + confidence
- relevance score
- severity
- topic
- engagement summary when supported
- source URL

Actions:

- Open source
- Mark relevant/not relevant
- Correct sentiment
- Mark resolved
- Create alert rule from this pattern (P1)

### Mention states

- New
- Reviewed
- Resolved
- Not relevant

Not Relevant removes it from default analytics but retains it for feedback/audit.

## 6. Screen: Mention Detail

### Header

- source
- severity
- sentiment
- published time
- source URL
- monitor(s) matched

### Original content panel

- title
- author
- full normalized text
- media preview when retained/permitted
- metadata
- engagement snapshots

Large raw HTML is not directly dumped into the UI.

### Analysis panel

- relevance score
- sentiment toward monitored entity
- confidence
- severity score
- topic
- risk category
- language
- story cluster ID if any

### Why this result?

Explain in human-readable bullets derived from structured evidence, not free-form hallucinated rationale.

Example:

- Exact monitored brand appears in the title.
- Complaint explicitly targets refund handling.
- Engagement increased 3.1x in 20 minutes.
- Similar complaints were detected in 4 other posts.

### Feedback controls

- Relevant
- Not relevant
- Sentiment should be Positive / Neutral / Negative
- Severity too high / correct / too low
- Resolved

Persist actor, timestamp, old value, new value, and optional note.

## 7. Screen: Alerts

### Tabs

- Open
- Acknowledged
- Resolved
- All

### Alert row

- severity
- type
- monitor
- source/story
- first detected
- latest update
- reason
- channels sent
- status

### Alert detail

- primary mention/story
- related mentions
- timeline
- engagement velocity
- alert rule that fired
- notification delivery log

Actions:

- Acknowledge
- Resolve
- Mute this story
- Tune rule

## 8. Screen: Monitors

### Monitor list

Columns/cards:

- name
- status
- keyword/query count
- source coverage
- last successful scan
- next scan
- mentions last 24h
- negative last 24h
- alert status

### Create Monitor wizard

Step 1 — Identity

- monitor name
- type: Person / Brand / Company / Product / Campaign / Other
- primary keyword

Step 2 — Query

- aliases
- exact phrases
- excluded terms
- Boolean query editor
- query validation
- live syntax highlighting

Step 3 — Sources

Source selector shows for every source:

- available/limited/contract required/disabled
- expected freshness
- what data is covered

Step 4 — Alerts

- severity threshold
- negative only toggle
- email recipients
- Telegram configuration

Step 5 — Preview

Run a limited query preview and show:

- sample matches
- false-positive candidates
- compiled provider queries
- warnings about source limitations

Step 6 — Activate

Show first-scan status and expected monitoring cadence.

## 9. Boolean Query Editor

Required UX:

- syntax highlighting
- parentheses matching
- validation errors with character offset
- operator autocomplete
- exact-phrase support
- test query against pasted sample text
- preview compiled query by source

Example:

```text
("ABC Company" OR "ABC Vietnam")
AND ("refund" OR "hoàn tiền")
NOT "ABC School"
```

Do not expose provider-specific syntax in the canonical editor. Provider compilation is a secondary advanced view.

## 10. Reports

V1:

- Daily
- Weekly

Report sections:

- executive summary
- mention volume
- sentiment mix
- negative topics
- top critical/high mentions
- top story clusters
- source coverage health
- monitor changes

Exports can be generated as HTML/JSON first; PDF is later unless required.

## 11. Settings

Sections:

- Workspace
- Members / RBAC
- Notification channels
- Source integrations
- API credentials/approved connections
- Billing/usage
- Data retention
- Audit log

Secrets are never displayed after creation except masked metadata.

## 12. Source Health UX

Global source health page or drawer:

| Source | Status | Last success | Freshness | Error rate | Coverage note |
|---|---|---:|---:|---:|---|

Statuses:

- Healthy
- Limited
- Contract Required
- Degraded
- Disabled

A degraded source must produce a visible analytics/report footnote so customers do not interpret missing data as zero conversation.

## 13. Empty states

### No monitor

Message: `Create your first monitor to start listening.`
Action: Create monitor.

### Monitor active but first scan pending

Show pipeline status:

`Discovering → Collecting → Analyzing → Ready`

### No mentions

Differentiate:

- genuinely no relevant results found
- discovery still running
- source unavailable/limited

Never collapse these into one message.

## 14. Error states

User-facing errors should be actionable:

- invalid Boolean query
- monitor quota reached
- source credential expired
- source contract not configured
- temporary source degradation
- notification channel failure

Never expose stack traces, raw tokens, or internal IDs unnecessarily.

## 15. Frontend technical expectations

- TypeScript.
- Server/API state must not be duplicated into ad-hoc global client state without need.
- Infinite scroll or cursor pagination for Mentions.
- URL-addressable filters.
- Skeleton states for feed/chart loading.
- Optimistic UI only for reversible local actions; alert/resolution mutations must reconcile with server result.
- Feature flags for P1/P2 surfaces.
- Every component that displays metrics must understand `coverage_status` and `data_completeness`.

## 16. Acceptance scenarios

1. User can create a monitor with Vietnamese Unicode Boolean query.
2. User sees current source limitations before activating it.
3. Fresh negative mention appears at top of Mentions.
4. High-severity negative mention is visually obvious without hiding confidence.
5. User can understand why the mention was classified negative.
6. User can correct a false positive in one interaction.
7. Overview changes after feedback without corrupting historical audit data.
8. Degraded Facebook/TikTok coverage is clearly visible.
9. Mobile user can view and acknowledge a critical alert.
10. Filters survive page refresh/shareable URL navigation.

# Billing, Auth, and Admin UI Addendum

## Public/auth screens

- Sign up
- Log in
- Account recovery
- Workspace creation/join
- Plan selection

Plan cards must show exactly USD 29 / USD 49 / USD 99 monthly defaults from server-provided plan data. Never duplicate entitlement truth only in frontend constants.

## Billing settings

Show:

- current plan
- subscription state
- current billing period
- usage vs included quota
- upgrade/downgrade action
- billing portal action

When source/crawl/AI capacity is degraded due to quota, say so explicitly. Never show `0 mentions` as a substitute.

## Super admin

Navigation is invisible and inaccessible to non-super-admin users.

Admin pages:

- Tenants
- Users
- Subscriptions
- Plans
- Usage/Cost
- Sources
- Queue/Crawler health
- Audit log

Dangerous actions require re-authentication and confirmation.
