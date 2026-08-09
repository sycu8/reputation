# Codex Phase Prompts

Use one phase prompt at a time. Do not ask Codex to implement multiple phases in one run unless the repository is already mature and the phases are demonstrably small.

Before every phase, Codex must read:

- `AGENTS.md`
- `docs/BUILD_HANDOFF_INDEX.md`
- architecture/data/crawler/queue/SRE docs
- the current phase prompt

After implementation, run a separate strict code-review pass before starting the next phase.

## One-shot mode
Use `ONE_SHOT_CODEX_BOOTSTRAP.md` when you want to paste one instruction once and have Codex proceed phase-by-phase with internal review gates.

## Phase 13
`PHASE_13_BILLING_SUPERADMIN.md` adds production billing, plan entitlements, quota metering, and the internal super-admin control plane.
