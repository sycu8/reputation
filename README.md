# PulseWatch — Cloudflare-native Social Listening SaaS

Working implementation of the social-listening specification in this repository.

## Current implemented path

`account -> workspace -> monitor -> Boolean query -> scheduler/queue -> Brave web discovery -> fetch crawler -> Browser Run fallback -> R2 -> relevance -> Workers AI sentiment/severity -> mention storage -> negative alert queue`

The project is multi-tenant from the first commit and keeps raw content in R2 while operational state is sharded across SQLite-backed Durable Objects.

## Local validation

```bash
npm run validate
```

The repository uses zero runtime dependencies. `typescript` and `wrangler` are declared as development dependencies for normal CI/Cloudflare environments.

## HTTP API documentation

Interactive reference (auth, RBAC, every `/v1` route):

- Dashboard nav **API docs**, or open `/docs/index.html`
- Written guide: [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md)

## Cloudflare resources

Deploy order:

1. `workers/state`
2. create R2 buckets, KV namespaces, and Queues
3. `apps/api-worker`
4. `workers/scheduler`
5. `workers/discovery`
6. `workers/crawler-fetch`
7. `workers/crawler-browser`
8. `workers/processor`
9. `workers/ai-classifier`
10. `workers/alerts`
11. `apps/dashboard`

Replace the placeholder KV IDs and `example.com` hostnames before deployment.

## Required secrets / operator configuration

### API worker

```bash
wrangler secret put SUPER_ADMIN_EMAILS --config apps/api-worker/wrangler.jsonc
```

The value is a comma-separated allowlist of operator email addresses. `super_admin` is never assignable through a public API.

### Discovery worker

```bash
wrangler secret put BRAVE_SEARCH_API_KEY --config workers/discovery/wrangler.jsonc
```

Brave Search is the first broad-web discovery provider. The provider layer is intentionally replaceable/federated.

### Alerts worker

```bash
wrangler secret put TELEGRAM_BOT_TOKEN --config workers/alerts/wrangler.jsonc
```

Configure per-tenant notification targets in `NOTIFY_CONFIG` using key `notify:<tenantId>`:

```json
{
  "email": "alerts@example.com",
  "telegramChatId": "123456789"
}
```

Cloudflare Email Service must be onboarded for the domain used by `ALERT_FROM_EMAIL`.

## Browser Run

`workers/crawler-browser` uses `env.BROWSER.quickAction("content", ...)` and is configured with a remote browser binding. Static/simple pages are fetched first; Browser Run is only the fallback.

## Safety / source policy

The crawler is for publicly accessible content. It does not bypass CAPTCHA, login gates, private groups, bot protections, or platform authorization. Social adapters must expose their source capability/degraded state instead of pretending unavailable coverage exists.

See `BUILD_STATUS.md` before continuing work.

## Cursor handoff

For Cursor, start with `CURSOR_MASTER_PROMPT.md` or tell Cursor Agent to read `CURSOR_START_HERE.md`. Persistent project rules are included in `.cursor/rules/`.

Production deployment target carried by this handoff:
- Cloudflare account: Cloudspace
- Hostname: `reputation.orangecloud.vn`

See `docs/DEPLOYMENT_CLOUDSPACE.md` and `docs/SECRETS_AND_PROVIDER_ACCESS.md` before provisioning/deployment.
