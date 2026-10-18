# Crawl DLQ proposal

Status: proposal only. Do not purge, replay, or attach a consumer until Cuong approves. This change does not call Cloudflare and does not deploy.

Snapshot from the 2026-10-18 16:51 UTC+7 check:

| Queue | Messages | Consumer | Oldest |
| --- | --- | --- | --- |
| `reputa-crawl-static-production` | 1,456 | `reputa-crawler-fetch-production` | 2026-10-14 17:54 UTC+7 |
| `reputa-crawl-browser-production` | 144 | `reputa-crawler-browser-production` | 2026-10-14 17:45 UTC+7 |
| `reputa-crawl-dlq-production` | 861,075 (1.1 GB) | none | 2026-10-14 09:50 UTC+7 |

Both main queues already have the correct single consumer. `max_batch_size`, `max_batch_timeout`, and `max_retries` 3 are set. `max_concurrency` and `retry_delay` are unset, which is valid. The DLQ has no consumer because no worker lists it.

## What the logs showed

Production Workers Logs show `message.retry()` does spend `max_retries`. `domain_busy` deliveries were attempts 1 (2,542), 2 (2,290), 3 (2,049), and 4 (1,941), and none past 4. Those messages already reach `reputa-crawl-dlq-production`. A claim that per-message `retry()` ignores `max_retries` is wrong.

Why messages from 14 October are still on the two main queues is not established. The consumers are the right workers. Batch size, batch timeout, and `max_retries` 3 are set. A read-only dashboard check is still open. This note does not give a cause for that backlog.

The DLQ has no consumer in wrangler. A DLQ with no consumer is kept for four days and then deleted, which is why 861,075 messages do not drain on their own.

## What the code change does

`domain_busy` and `browser_pool_busy` are re-sent on the same queue with `delaySeconds` (at most 900 seconds) and a `congestionHops` counter, and the original message is acked. After 12 hops the worker logs `crawl_congestion_cap` and acks. Congestion does not enter the DLQ. Real transients (5xx, network, upstream 429) still use `message.retry()` and the existing `max_retries` 3 DLQ path. This does not explain or clear the 14 October main-queue messages.

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
- A bug that retries instead of acking would leave the DLQ messages in place until `max_retries` moves them again or retention deletes them.

Risks: medium, mostly cost and a bad retry loop. Safe only if the consumer acks every message and has no producer binding to the crawl queues.

## Option C — replay into the crawl queues

A consumer would re-send selected bodies to `reputa-crawl-static-production` or `reputa-crawl-browser-production`, then ack the DLQ message.

Pros:

- Could recover a mention that failed for a short-lived reason and was never recrawled.

Cons:

- Almost all 861,075 messages are retry-storm residue (`domain_busy` tight loops, permanent 4xx, tiny extractions), not a fresh outage.
- Replaying them recreates crawl load, browser-pool pressure, and duplicate processing. Content hashes make some duplicates harmless, but the fetch cost is not.
- Real transients still dead-letter after three retries, so replaying a poison URL without a filter sends it back to this queue. Congestion is no longer on that path.

Risks: high. Do not replay the full DLQ.

## Option D — purge

`npx wrangler queues purge reputa-crawl-dlq-production` deletes every message in that queue. This proposal does not run that command.

Pros:

- Frees the 1.1 GB immediately.
- Avoids a replay storm.
- The same messages are already due to age out under the four-day no-consumer rule.

Cons:

- Irreversible. Any real mention that landed here in the last four days and was not recrawled is gone.
- A purge does not explain or remove the 14 October messages on the main queues.

Risks: data loss for that window. Acceptable for storm residue, not acceptable as a silent step.

## Recommendation

1. Do not treat this branch as the explanation for the 14 October main-queue backlog. Wait for the read-only dashboard check.
2. Do not add a replay consumer. Congestion no longer needs a DLQ round-trip; replaying the storm residue recreates crawl load.
3. Prefer leaving `reputa-crawl-dlq-production` to the four-day no-consumer retention unless Cuong approves a purge. Option B is useful only if someone needs a sample first. This change does not purge.
