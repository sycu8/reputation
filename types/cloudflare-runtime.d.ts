interface SqlStorageCursor<T = Record<string, unknown>> extends Iterable<T> {
  toArray(): T[];
}

interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T>;
}

interface DurableObjectStorage {
  sql: SqlStorage;
  transaction<T>(closure: () => Promise<T>): Promise<T>;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface R2ObjectBody {
  key: string;
  body: ReadableStream;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream): Promise<unknown>;
  delete(key: string): Promise<void>;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface AnalyticsEngineDataset {
  writeDataPoint(event?: {
    indexes?: string[];
    blobs?: string[];
    doubles?: number[];
  }): void;
}

interface Message<T = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: T;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

interface MessageBatch<T = unknown> {
  readonly queue: string;
  readonly messages: readonly Message<T>[];
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
}

interface Queue<T = unknown> {
  send(body: T, options?: { contentType?: "json" | "text" | "bytes"; delaySeconds?: number }): Promise<void>;
  sendBatch(messages: Array<{ body: T; contentType?: "json" | "text" | "bytes"; delaySeconds?: number }>): Promise<void>;
}

interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
  noRetry(): void;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface BrowserRun {
  quickAction(action: "content" | "markdown" | "scrape" | "json" | "links" | "snapshot" | "screenshot" | "pdf", input: Record<string, unknown>): Promise<Response>;
}

interface Ai {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

interface SendEmail {
  send(message: {
    from: string;
    to: string | string[];
    subject: string;
    text?: string;
    html?: string;
  }): Promise<unknown>;
}
