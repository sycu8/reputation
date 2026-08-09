# Data Model Specification

## 1. Storage ownership

- **Durable Objects SQLite:** operational relational state, indexes, counters, cursor state, alerts, feedback.
- **R2:** raw HTML/JSON, media, screenshots, reports, exports, historical crawl snapshots.
- **KV:** feature flags, source configuration, parser/model thresholds, cache hints.
- **Vectorize:** optional semantic fingerprints/embeddings for dedupe and clustering.
- **Analytics Engine:** append-oriented telemetry only.

## 2. TenantDirectoryDO schema

```sql
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE memberships (
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id)
);

CREATE TABLE monitor_directory (
  monitor_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  next_scan_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_monitor_directory_next_scan
ON monitor_directory(next_scan_at, status);
```

## 3. MonitorDO schema

```sql
CREATE TABLE monitor (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  default_language TEXT,
  scan_interval_sec INTEGER NOT NULL,
  alert_threshold INTEGER NOT NULL DEFAULT 60,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE queries (
  id TEXT PRIMARY KEY,
  raw_query TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  ast_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE source_state (
  source TEXT PRIMARY KEY,
  cursor TEXT,
  last_scan_at TEXT,
  next_scan_at TEXT,
  last_success_at TEXT,
  error_count INTEGER NOT NULL DEFAULT 0,
  health TEXT NOT NULL DEFAULT 'unknown',
  metadata_json TEXT
);

CREATE TABLE mentions (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL,
  canonical_url TEXT,
  source TEXT NOT NULL,
  source_native_id TEXT,
  author_name TEXT,
  author_url TEXT,
  title TEXT,
  excerpt TEXT,
  published_at TEXT,
  discovered_at TEXT NOT NULL,
  relevance_score REAL NOT NULL,
  sentiment TEXT NOT NULL,
  sentiment_confidence REAL NOT NULL,
  severity_score REAL NOT NULL,
  topic TEXT,
  language TEXT,
  engagement_score REAL,
  raw_r2_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_mentions_content_id
ON mentions(content_id);

CREATE INDEX idx_mentions_discovered
ON mentions(discovered_at DESC);

CREATE INDEX idx_mentions_published
ON mentions(published_at DESC);

CREATE INDEX idx_mentions_sentiment
ON mentions(sentiment, discovered_at DESC);

CREATE INDEX idx_mentions_severity
ON mentions(severity_score DESC, discovered_at DESC);

CREATE INDEX idx_mentions_source
ON mentions(source, discovered_at DESC);

CREATE TABLE mention_analysis (
  mention_id TEXT PRIMARY KEY,
  relevance_reason TEXT,
  sentiment_reason TEXT,
  severity_reason TEXT,
  risk_categories_json TEXT,
  ai_model TEXT,
  ai_version TEXT,
  analyzed_at TEXT NOT NULL
);

CREATE TABLE engagement_snapshots (
  id TEXT PRIMARY KEY,
  mention_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  views INTEGER,
  other_json TEXT
);

CREATE INDEX idx_engagement_mention_time
ON engagement_snapshots(mention_id, captured_at DESC);

CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  mention_id TEXT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  state TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  acknowledged_at TEXT,
  resolved_at TEXT
);

CREATE UNIQUE INDEX idx_alert_dedupe
ON alerts(dedupe_key);

CREATE INDEX idx_alert_state_time
ON alerts(state, created_at DESC);

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  mention_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  previous_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_feedback_mention
ON feedback(mention_id, created_at DESC);

CREATE TABLE scan_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  relevant_count INTEGER NOT NULL DEFAULT 0,
  negative_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  trace_id TEXT NOT NULL
);
```

## 4. BudgetDO schema

```sql
CREATE TABLE monthly_usage (
  month TEXT PRIMARY KEY,
  crawl_requests INTEGER NOT NULL DEFAULT 0,
  browser_units REAL NOT NULL DEFAULT 0,
  ai_units REAL NOT NULL DEFAULT 0,
  mentions_processed INTEGER NOT NULL DEFAULT 0,
  notifications_sent INTEGER NOT NULL DEFAULT 0,
  storage_bytes_estimate INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
```

## 5. DomainCoordinatorDO schema

```sql
CREATE TABLE domain_state (
  domain TEXT PRIMARY KEY,
  next_allowed_at TEXT,
  active_requests INTEGER NOT NULL DEFAULT 0,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  recent_429 INTEGER NOT NULL DEFAULT 0,
  recent_403 INTEGER NOT NULL DEFAULT 0,
  backoff_until TEXT,
  robots_r2_key TEXT,
  policy_json TEXT,
  updated_at TEXT NOT NULL
);
```

## 6. Canonical content metadata

Canonical raw bodies live in R2. A lightweight metadata/index record may be cached or stored in a dedicated sharded content-index DO if/when scale requires it.

```ts
export interface CanonicalContentMeta {
  contentId: string;
  canonicalUrl: string;
  normalizedUrlHash: string;
  source: string;
  sourceNativeId?: string;
  publishedAt?: string;
  discoveredAt: string;
  fingerprint: string;
  rawR2Key: string;
  latestVersion: string;
}
```

## 7. ID strategy

- tenantId: ULID/UUIDv7
- monitorId: ULID/UUIDv7
- queryId: ULID/UUIDv7
- contentId: deterministic hash where possible (`source + nativeId` or canonical URL hash)
- mentionId: deterministic `hash(monitorId + contentId + analysisVersion)`
- alertId: ULID/UUIDv7
- dedupe keys: deterministic SHA-256

## 8. Retention

V1 defaults:
- mention metadata: 12 months
- raw HTML/text: 90 days for Professional, 180 days Business
- screenshots/media: shorter retention unless tied to High/Critical mention
- analytics telemetry: per operational need
- reports: 12 months

Lifecycle policies should be configured at R2 bucket/prefix level where possible.
