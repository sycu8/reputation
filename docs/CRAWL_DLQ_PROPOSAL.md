# Crawl DLQ proposal

Status: proposal only. Do not purge, replay, or attach a consumer until Cuong approves. This change does not call Cloudflare and does not deploy.

Snapshot from the 2026-10-18 16:51 UTC+7 check:

| Queue | Messages | Consumer | Oldest |
| --- | --- | --- | --- |
| `reputa-crawl-static-production` | 1,456 | `reputa-crawler-fetch-production` | 2026-10-14 17:54 UTC+7 |
| `reputa-crawl-browser-production` | 144 | `reputa-crawler-browser-production` | 2026-10-14 17:45 UTC+7 |
| `reputa-crawl-dlq-production` | 861,075 (1.1 GB) | none | 2026-10-14 09:50 UTC+7 |

Both main queues already have the correct single consumer. `max_batch_size`, `max_batch_timeout`, and `max_retries` 3 are set. `max_concurrency` and `retry_delay` are unset, which is valid. The DLQ has no consumer because no worker lists it.

## Why the main queues still hold 14 October messages

Cloudflare Queues applies `max_retries` when a delivery fails or the handler calls `retryAll()`. Per-message `message.retry({ delaySeconds })` does not spend that budget. The crawl workers used that call for `domain_busy`, `browser_pool_busy`, 429, and 5xx. Each call kept the original message id and timestamp and scheduled another delivery. A 30–900 second delay cannot hide a message for four days; only repeating the retry can. Default retention is 4 days (345,600 seconds). The oldest main-queue messages were about 3 days 23 hours old at the check, which is the retention horizon, not a consumer pointed at the wrong queue.

The 861,075 DLQ messages are the deliveries that did fail the budget (uncaught failures and killed invocations during the retry storm). A DLQ with no consumer keeps messages for four days and then deletes them. That is why this queue does not drain on its own. Its oldest timestamp is already past that window, so deletion is in progress or the timestamp is the original produce time.

The code fix makes transient crawl failures call `retryAll()` instead. After deploy, the roughly 1,600 messages still on the main queues can reach this DLQ in a few retries. They should not be treated as a new incident.

## Option A — leave the DLQ with no consumer

Pros:

- No new worker, no extra reads, no risk of replaying the storm.
- Cloudflare deletes messages with no consumer after four days. Much of this backlog is already at that age.

Cons:

- 1.1 GB stays until retention finishes.
- There is no record of which URLs were dropped.

Risks: low. The lost payloads are storm residue. Fresh discovery after `0f89943` is the path for new mentions.

## Option B — add a consumer that only records and acks

A worker would read each DLQ message, log source, tenant, and error, then `ack()` it. It would not send the job back to a crawl queue.

Pros:

- Drains the backlog on purpose and can keep a short sample of what failed.
- Does not refetch URLs or wake the browser pool.

Cons:

- About 861,000 reads, plus the small number that arrive after the main-queue fix.
- A bug that retries instead of acking would pin the DLQ the same way the main queues were pinned.

Risks: medium, mostly cost and a bad retry loop. Safe only if the consumer acks every message and has no producer binding to the crawl queues.

## Option C — replay into the crawl queues

A consumer would re-send selected bodies to `reputa-crawl-static-production` or `reputa-crawl-browser-production`, then ack the DLQ message.

Pros:

- Could recover a mention that failed for a short-lived reason and was never recrawled.

Cons:

- Almost all 861,075 messages are retry-storm residue (`domain_busy` tight loops, permanent 4xx, tiny extractions), not a fresh outage.
- Replaying them recreates crawl load, browser-pool pressure, and duplicate processing. Content hashes make some duplicates harmless, but the fetch cost is not.
- The new main-queue fix will DLQ a poison URL again after three tries, so replay without a filter just moves the same jobs in a circle.

Risks: high. Do not replay the full DLQ.

## Option D — purge

`npx wrangler queues purge reputa-crawl-dlq-production` deletes every message in that queue. This proposal does not run that command.

Pros:

- Frees the 1.1 GB immediately.
- Avoids a replay storm.
- The same messages are already due to age out under the four-day no-consumer rule.

Cons:

- Irreversible. Any real mention that landed here in the last four days and was not recrawled is gone.
- Purge does not fix the main queues. Those drain only after the `retryAll()` fix is deployed.

Risks: data loss for that window. Acceptable for storm residue, not acceptable as a silent step.

## Recommendation

1. Deploy the `retryAll()` fix first. That is what lets the main queues drain. Expect on the order of 1,600 additional DLQ messages, then a stop.
2. Do not add a replay consumer.
3. Prefer a purge of `reputa-crawl-dlq-production` over waiting out retention, but only after Cuong says so. Option A is the fallback if a purge is not approved. Option B is useful only if someone needs a sample before the purge.
