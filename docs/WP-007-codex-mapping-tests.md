# WP-007 — Codex JSONL Mapping Fixtures + Tests

## Goal
Add fixtures and tests that validate Codex JSONL mapping behavior.

## Scope (In)
- Fixture JSONL events covering thread/turn/item/error cases.
- Adapter tests that verify mapping + redaction behavior.

## Scope (Out)
- Runtime behavior changes beyond test visibility.

## Constraints
- No raw prompt/tool payloads in fixtures.
- Keep tests deterministic.

## Plan
1. Add fixture JSONL file(s) under packages/adapters/test/fixtures.
2. Add mapping tests and expose minimal helpers if needed.
3. Run adapter tests.

## Acceptance Criteria
- Mapping tests cover item.* -> Telemetry v1 kinds/names.
- Tests validate seq synthesis and redaction-safe attrs.
- Fixtures are checked in.
