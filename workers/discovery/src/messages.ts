/** Stay under the Cloudflare Queues 128_000-byte message limit. */
export const CRAWL_QUEUE_MESSAGE_MAX_BYTES = 120_000;
/** Stay under the sendBatch total-size limit (256 KB) with room for framing. */
export const CRAWL_QUEUE_BATCH_MAX_BYTES = 200_000;
export const CRAWL_QUEUE_BATCH_MAX_COUNT = 50;

interface ShrinkablePayload {
  url: string;
  title?: string | undefined;
  snippet?: string | undefined;
}

export function crawlMessageBytes(message: unknown): number {
  return new TextEncoder().encode(JSON.stringify(message)).byteLength;
}

function shrink(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 1) return undefined;
  return value.slice(0, Math.floor(value.length / 2));
}

/** Trim title/snippet (and, if needed, the URL) until the JSON message fits. */
export function fitCrawlJob<T extends { payload: ShrinkablePayload }>(job: T): T {
  const payload: ShrinkablePayload & Record<string, unknown> = { ...job.payload };
  if (typeof payload.title === "string" && payload.title.length > 300) payload.title = payload.title.slice(0, 300);
  if (typeof payload.snippet === "string" && payload.snippet.length > 4_000) payload.snippet = payload.snippet.slice(0, 4_000);
  let fitted = { ...job, payload };
  let guard = 0;
  while (crawlMessageBytes(fitted) > CRAWL_QUEUE_MESSAGE_MAX_BYTES && guard < 16) {
    guard += 1;
    if (typeof payload.snippet === "string" && payload.snippet.length > 0) payload.snippet = shrink(payload.snippet);
    else if (typeof payload.title === "string" && payload.title.length > 0) payload.title = shrink(payload.title);
    else payload.url = payload.url.slice(0, Math.max(16, Math.floor(payload.url.length / 2)));
    if (!payload.snippet) delete payload.snippet;
    if (!payload.title) delete payload.title;
    fitted = { ...job, payload: { ...payload } };
  }
  return fitted;
}

export function batchCrawlJobs<T>(jobs: readonly T[], maxCount = CRAWL_QUEUE_BATCH_MAX_COUNT, maxBytes = CRAWL_QUEUE_BATCH_MAX_BYTES): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const job of jobs) {
    const size = crawlMessageBytes(job);
    if (current.length > 0 && (current.length >= maxCount || bytes + size > maxBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(job);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
