# Codex Prompt — Phase 3: Scheduler and Queue Backbone

You are a senior Cloudflare distributed-systems engineer.

## Objective

Implement the asynchronous job backbone and scheduling primitives without real external crawling yet.

## Read first

Read `docs/QUEUE_CONTRACTS.md`, `docs/SRE_RUNBOOK.md`, `docs/DATA_MODEL.md`, and current Wrangler bindings.

## Build

- scheduler Worker
- due-monitor selection/coordination
- discovery normal and priority queues
- crawl static queue
- crawl browser queue
- processing queues
- priority AI queue if defined in docs
- alert queue
- DLQs
- typed common job envelope
- trace/correlation IDs
- idempotency keys
- bounded retry policy
- queue health telemetry

## Scheduling rule

Do not run a Cron per monitor. Use a global scheduler tick plus monitor `next_scan_at` state and idempotent claiming.

## Required tests

- due monitor emits exactly one logical discovery job despite retries
- replayed queue messages do not duplicate scan state
- tenant/monitor IDs propagate across stages
- malformed jobs fail safely
- exhausted jobs reach DLQ with enough context for replay

Do not implement external source adapters in this phase. Use fixtures/test producers.
