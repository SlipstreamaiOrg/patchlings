# WP-009 — Replay Fixture + Truncated Line Coverage

## Goal
Add deterministic replay fixtures and coverage for truncated lines in replay adapters.

## Scope (In)
- Fixture JSONL recording(s).
- Tests for truncated line handling and determinism with fixture.

## Scope (Out)
- Replay UX changes.

## Constraints
- Fixtures must be metadata-only.
- Tests must be deterministic.

## Plan
1. Add recording fixture under test fixtures.
2. Add tests for file-tail adapter truncated line handling.
3. Add determinism test that replays fixture.

## Acceptance Criteria
- Fixture file checked in.
- Tests cover truncated line handling and deterministic replay.
- Docs remain unchanged unless needed.
