# Contributing To Patchlings

Thanks for your interest in Patchlings.

Patchlings is privacy-first by default. Please avoid adding features that assume access to raw prompts or tool payloads unless they are clearly opt-in.

## Local Development

```bash
npm install -g pnpm
pnpm install
pnpm demo
```

Open `http://localhost:5173`.

## Useful Commands

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm run -- "Your prompt here"
pnpm export-story -- latest
```

## Design Principles

- Keep the telemetry contract stable
- Prefer metadata-only summaries over raw content
- Protect responsiveness with batching and caps
- Preserve deterministic replay behavior

## Pull Requests

- Keep changes scoped
- Add or update tests when you change behavior
- Call out privacy implications explicitly

