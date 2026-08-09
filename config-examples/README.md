# Wrangler configuration examples

These are architecture examples, not deploy-ready credentials/resources. Resource names must exist before deployment and may be adjusted by the implementation phase.

Before using any file:

1. Copy it into the relevant Worker package as `wrangler.jsonc`.
2. Validate it against the installed current Wrangler schema.
3. Run `npx wrangler types`.
4. Ensure all referenced queues/buckets/indexes/Workers exist in the target environment.
5. Keep secrets out of these files.
6. Do not assume non-inheritable Wrangler fields carry from top-level into named environments; bindings are intentionally repeated here for staging/production.

Files:

- `state.wrangler.jsonc` — SQLite-backed Durable Object namespaces.
- `crawler-browser.wrangler.jsonc` — Browser Run + R2 + queue consumer + cross-Worker DO bindings.
- `processor.wrangler.jsonc` — R2 + Vectorize + Workers AI + queue processing.

Use `docs/WRANGLER_BINDINGS_ARCHITECTURE.md` as the authoritative rationale.
