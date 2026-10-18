# Crawl DLQ proposal

Status: proposal only. Do not purge, replay, or attach a consumer until Cuong approves. This change does not call Cloudflare and does not deploy.

Snapshot from the 2026-10-18 16:51 UTC+7 check:

| Queue | Messages | Consumer | Oldest |
| --- | --- | --- | --- |
| `reputa-crawl-static-production` | 1,456 | `reputa-crawler-fetch-production` | 2026-10-14 17:54 UTC+7 |
| `reputa-crawl-browser-production` | 144 | `reputa-crawler-browser-production` | 2026-10-14 17:45 UTC+7 |
| `reputa-crawl-dlq-production` | 861,075 (1.1 GB) | none | 2026-10-14 09:50 UTC+7 |

Both main queues already have the correct single consumer. `max_retries` 3 is set. Before this change `max_concurrency` was unset, so a push consumer scales to the Queues cap of 250 concurrent invocations. The DLQ has no consumer because no worker lists it.

A later read-only check at about 17:17 UTC+7 the same day:

| Queue | Backlog | Oldest | Concurrency | Last hour written / read / acked / DLQ |
| --- | --- | --- | --- | --- |
| `reputa-crawl-static-production` | 1,125 | 2026-10-15 00:54 UTC+7 | 250, at the cap | 40.3k / 46.7k / 37.7k / 2,485 |
| `reputa-crawl-browser-production` | 194, growing | 2026-10-15 00:45 UTC+7 | 250, at the cap | 4.5k / 14.7k / 1,408 / 3,041 |

`delivery_paused` was not set on either queue. Browser terminal outcomes were about 68% DLQ (3,041 / (1,408 + 3,041)). Between 16:51 and 17:17 the oldest timestamp on both queues moved from 14 October to 15 October. That is two snapshots, not a trace of one message.

## What the logs showed

Production Workers Logs show `message.retry()` does spend `max_retries`. `domain_busy` deliveries were attempts 1 (2,542), 2 (2,290), 3 (2,049), and 4 (1,941), and none past 4. Those messages already reach `reputa-crawl-dlq-production`. A claim that per-message `retry()` ignores `max_retries` is wrong.

## Why the 15 October head may not be the message being delivered

This is a hypothesis. The code does not prove it.

`oldestMessageTimestamp` is the enqueue time of the oldest message still stored on the queue. It is not a cursor showing which message the consumer is handling. A message sent or retried with `delaySeconds` stays in that backlog and is not eligible for delivery until the delay ends. Platform `delaySeconds` can be as long as 24 hours. This repository caps crawl delays at 900 seconds, wrangler sets no queue-level `delivery_delay`, and `message.retry()` dead-letters a message after the fourth delivery. That path cannot park one message from 15 October 00:54 until 18 October 17:17.

At 17:17 the static consumer had acked about 37.7k messages in the last hour against a backlog of 1,125, and the browser consumer had acked 1,408, while both oldest timestamps were still 15 October and the consumers were not paused. Newer messages were being delivered. The head messages were not.

What this repo cannot show is why those particular messages were not offered. A delay or visibility hold only hides a message while it lasts, and the holds this code sets are minutes, not three days. Push consumers also do not document a guarantee that the oldest message is always the next one handed out once concurrency is 250. Either of those would match the counters. Neither is established for these messages.

## What the browser DLQ messages are

The browser worker calls `BROWSER.quickAction("content")`. Before this change a non-OK response was thrown as `browser_http_<status>` and the Browser Run error body was discarded. `browser_http_429` and any other non-terminal browser error, including a thrown `too many sessions`, then called `message.retry()`. With `max_retries` 3 that is four deliveries and then the DLQ. `browser_pool_busy` did the same on the deployed revision `0f89943`. Permanent browser 4xx and tiny extractions are acked, so they are not the 3,041 DLQ writes.

Workers Paid Browser Run (limits page current 2026-10-14) allows 200 concurrent browsers per account for sessions and 30 Quick Action requests per second. Exceeding the rate returns HTTP 429. The binding can also fail with a session-limit error before a status line. 250 consumer invocations, each able to hold one Quick Action, is above that 200 session ceiling and can start requests faster than 30 per second. The pool Durable Object also stops at 200 leases, and the overflow is `browser_pool_busy`. The 17:17 logs were not re-read here, so this does not name the error string on those 3,041 messages. The code path that dead-letters both the 429 and the pool overflow is the one above.

The DLQ has no consumer in wrangler. A DLQ with no consumer is kept for four days and then deleted, which is why 861,075 messages do not drain on their own.

## What the code change does

`domain_busy`, `browser_pool_busy`, Browser Run HTTP 429, and session-limit errors (`too many sessions`, `too many browsers`, `browser instance limit`, `unable to create new browser`) are re-sent on the same queue with `delaySeconds` of `max(coordinator hint or Retry-After, 30s × 2^hop)` capped at 900 seconds (30, 60, 120, 240, 480, then 900) and a `congestionHops` counter, and the original message is acked. Twelve hops cover 7,230 seconds, about 2 hours, when the hint is shorter than the step. After 12 hops the worker logs `crawl_congestion_cap` at warn and acks. Congestion does not enter the DLQ. A follow-up parks `domain_busy` on `DomainCoordinatorDO` and sends one wake per domain instead of re-sending every URL. That follow-up is not deployed with this note. Real transients (5xx, network, upstream 429, browser 5xx that are not a session limit) still use `message.retry()` and the existing `max_retries` 3 DLQ path.

Consumer settings in wrangler, for both dev and production: static `max_concurrency` 80, `max_batch_size` 10, `max_batch_timeout` 5; browser `max_concurrency` 200, `max_batch_size` 1, `max_batch_timeout` 1. The browser cap is the published concurrent-browser limit, and batch size 1 keeps one Quick Action in flight per invocation. The static cap is below the 250 platform ceiling: about 11 new messages per second were written in the 17:17 hour, and 80 concurrent fetches cover that at a few seconds per fetch without sitting on the autoscaler maximum. This does not explain or clear the old main-queue head, and it does not deploy.

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

1. Do not treat this branch as a proven explanation for the 15 October head. The counters show newer messages being acked while that head stays old. The delay and ordering notes above are hypotheses.
2. Do not add a replay consumer. Congestion no longer needs a DLQ round-trip; replaying the storm residue recreates crawl load.
3. Prefer leaving `reputa-crawl-dlq-production` to the four-day no-consumer retention unless Cuong approves a purge. Option B is useful only if someone needs a sample first. This change does not purge.
