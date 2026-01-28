# Patchlings

Give your coding agent a soul — watch it work, learn as it patches.

Patchlings is an engine plus themes. It is repo-agnostic and can visualize any coding agent that can emit an event stream. The default integration is Codex CLI JSONL via `codex exec --json`.

## 30-Second Quickstart

```bash
npx pnpm@9.12.0 install
npx pnpm@9.12.0 demo
```

Open the viewer at:

- `http://localhost:5173` (Vite dev server)
- The runner streams at `http://localhost:4317/stream`
- Runner-served assets live under `http://localhost:4317/patchlings-assets/`

## Run With Codex CLI

```bash
npx pnpm@9.12.0 run -- "Refactor the telemetry adapter to add backpressure summaries."
```

Then open `http://localhost:5173`.

Patchlings will ingest Codex JSONL from:

```bash
codex exec --json "<prompt>"
```

## Sprite Assets (Optional)

Place Patchling sprites under:

- `patchling_characters/patchlings_branding_images/`

The runner serves them at `/patchlings-assets` by default. Override with `PATCHLINGS_ASSETS_DIR` (runner) or `VITE_PATCHLINGS_ASSET_BASE` (viewer). If assets are missing, the viewer falls back to placeholder Patchlings.

## Replay A Recording

Recordings are stored under `.patchlings/recordings/`.

```bash
pnpm replay -- .patchlings/recordings/<run_id>.jsonl
```

## Export Story Time

Story Time generates a deterministic, privacy-safe Markdown story per run:

```bash
pnpm export-story -- latest
```

Output lands at `.patchlings/story/<run_id>.md`.

## Privacy-First Defaults

- Redaction is on by default.
- Raw prompt/tool payloads are not displayed or stored by default.
- Paths and IDs are hashed with workspace and run salts.
- To opt into raw content (not recommended), set `PATCHLINGS_ALLOW_CONTENT=true`.

See `docs/SECURITY.md` for the threat model and verification steps.

## Core Concepts

- Engine: persistent world state and chaptering (`turn.started` → `turn.completed|failed`)
- Themes: render logic that consumes world state plus events
- Learn-lings: beginner-friendly explanations from metadata-only telemetry
- Story Time: deterministic Markdown exporter

## Repo Layout

- `apps/viewer`: web UI (Universe theme, timeline, Learn-lings, export)
- `apps/runner`: CLI runner and bridge (adapters, engine, server, WS stream)
- `packages/protocol`: Telemetry v1 schema, types, validation
- `packages/redact`: privacy-safe redaction and hashing
- `packages/engine`: persistence, chaptering, backpressure, determinism
- `packages/adapters`: codex-jsonl, stdin-jsonl, demo, file-tail
- `packages/themes`: theme interface plus Universe theme
- `packages/learnlings`: explanation mapping engine
- `packages/storytime`: Story Time exporter
- `docs/*`: project docs and architecture notes

## Docs

- `docs/QUICKSTART.md`
- `docs/ARCHITECTURE.md`
- `docs/SECURITY.md`
- `docs/THEMES.md`
- `docs/ROADMAP.md`

## Status

This repo is an early public OSS scaffold aimed at a solid v0.1 foundation: correctness, privacy, persistence, and a stable demo.

## Contributing

See `CONTRIBUTING.md`.

## License

MIT, see `LICENSE`.
