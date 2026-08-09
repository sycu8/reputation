# Codex Prompt — Phase 4: Generic Web, News, RSS

You are a senior web-crawling engineer building a policy-aware Cloudflare system.

## Objective

Deliver the first real end-to-end source path for open web/news/RSS using cheap fetch-first collection.

## Build

- SourceAdapter contract and capability metadata
- generic web adapter
- RSS/Atom adapter
- sitemap adapter
- pluggable search/discovery provider interface
- direct `fetch()` crawler
- canonical URL normalization
- R2 raw-content persistence
- content fingerprint
- crawl-once/match-many cache path
- SSRF protection
- domain policy hooks
- content extraction quality score

## Rules

- R2 owns raw/large payloads.
- DO stores operational metadata and references only.
- Do not invoke Browser Run in normal static fixtures; Phase 5 adds fallback.
- Never crawl private/reserved IP ranges.
- Respect bounded redirects, response size limits, MIME/type validation, timeouts, and decompression safeguards.

## Acceptance

A test monitor discovers a public fixture/article/feed item, fetches it, stores one raw object in R2, evaluates the canonical monitor query, and creates a customer-specific mention without duplicate raw content.
