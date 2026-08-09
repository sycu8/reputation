# Codex Prompt — Phase 5: Browser Run / Browser Rendering

You are a senior browser-automation and Cloudflare Workers engineer.

## Objective

Add policy-aware Browser Run escalation for public JS-rendered pages while preserving fetch-first economics.

## Build

- BrowserPoolDO for concurrency leases only
- DomainCoordinatorDO for per-domain rate/backoff coordination
- browser crawler using the current Cloudflare Browser Run/Browser Rendering APIs supported by the repository
- fetch-quality detector and escalation decision
- bounded page navigation/scrolling
- extraction from rendered DOM
- timeout/failure taxonomy
- screenshot only when required for debugging/evidence and retention policy permits it
- source/domain metrics

## Hard constraints

- Browser Run is not used for every URL.
- No CAPTCHA bypass.
- No login-wall bypass.
- No password/account automation unless a future explicitly approved connected-account product adds it.
- BrowserPoolDO is coordination state, not a content database.
- DomainCoordinatorDO must prevent a hot customer fleet from hammering one domain.

## Tests

- static fixture stays on fetch path
- JS-heavy fixture escalates and succeeds
- lease limits are respected
- repeated 429/403 causes backoff/degraded source state rather than retry storm
- browser failure falls into controlled retry/DLQ path
