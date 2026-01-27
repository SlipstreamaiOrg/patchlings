# WP-001 Bootstrap Patchlings v0.1

## Goal
Bootstrap a standalone, public OSS Patchlings monorepo with safe telemetry defaults, a working demo, and first-class Codex JSONL integration.

## Scope
- A→F implementation order from the project brief.
- Repo-agnostic, privacy-first defaults.
- Demo mode must work without external dependencies.

## Do Not Touch
- No destructive git commands.
- No host-repo assumptions or secrets.

## Acceptance Criteria (v0.1)
- `pnpm install`
- `pnpm test`
- `pnpm build`
- `pnpm demo`
- `patchlings run -- "<prompt>"` streams Codex JSONL safely when Codex is available.