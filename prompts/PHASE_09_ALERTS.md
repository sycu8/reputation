# Codex Prompt — Phase 9: Negative Alerting

You are a senior eventing/notification engineer.

## Objective

Deliver reliable, deduplicated negative alerts with the product SLO: P95 important mention detection under 15 minutes and notification after classification under the documented alert latency target.

## Build

- alert rule engine
- default threshold behavior
- alert deduplication/idempotency
- Email channel
- Telegram channel
- notification delivery log
- alert list/detail UI
- acknowledge/resolve/mute controls
- retry and dead-letter behavior

## Rules

- The same logical alert must not notify twice because of queue retry.
- Channel delivery failure must not destroy the alert record.
- Degraded source coverage must be retained in alert context.
- Notification templates must contain source link, reason, confidence, severity, monitor, and detected time without leaking internal tokens.

## Tests

- High negative fixture sends exactly one logical alert
- retry does not duplicate notification
- delivery failure records retryable state
- acknowledgement/resolution is tenant-safe and auditable
