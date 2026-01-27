# Architecture

Patchlings is an engine plus themes. The runner bridges upstream event streams into a privacy-safe telemetry contract, persists a world state, and streams normalized updates to the viewer.

## Event Flow

1. Upstream agent emits events (Codex JSONL, stdin JSONL, demo, or file replay)
2. Adapter normalizes events into Telemetry v1
3. Protocol validation enforces the v1 contract
4. Redaction strips sensitive keys and hashes identifiers by salt
5. Engine reduces events into persistent world state plus chapters
6. Runner batches and streams updates to the viewer over `/stream`
7. Viewer consumes world state plus events and renders the PixiJS Universe simulation

## Chapter Semantics (Locked)

- A chapter opens on `turn.started`
- A chapter closes on `turn.completed` or `turn.failed`
- Chapter summaries append to `.patchlings/chapters.ndjson`
- The world state checkpoints to `.patchlings/world.json`

## Persistence Layout

By default, everything persists under `.patchlings/`:

- `world.json`: current world state
- `chapters.ndjson`: append-only chapter summaries
- `recordings/<run_id>.jsonl`: optional telemetry recordings (rotated by size)
- `story/<run_id>.md`: Story Time exports
- `salts.json`: stable workspace salt plus per-run salts

## Backpressure And Responsiveness

The engine tracks events per second. When throughput exceeds a threshold, low-value repeats are aggregated into internal metric summaries (`metric.backpressure.summary`) instead of flooding the UI.

This keeps the viewer responsive without breaking determinism.

## Deterministic Replay

Given the same recording and salts, replay produces the same counters and chapter summaries. Backpressure summaries are synthesized deterministically and are marked as `internal: true`.

## Theme API (High-Level)

A theme consumes:

- `world`: persistent world state
- `events`: recent normalized events
- `chapters`: chapter summaries

It produces a render state for the viewer. The built-in `Universe` theme focuses on clarity and stability first, then aesthetics.

## Viewer Rendering (v0.1)

The current viewer implements the Universe theme as a PixiJS colony simulation. It connects only to runner endpoints:

- `/stream`
- `/export/storytime`
- `/patchlings-assets/*`

By default, sprite assets are served from `patchling_characters/patchlings_branding_images/`.
