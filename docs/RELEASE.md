# Release Plan

This document defines how Patchlings versions are cut and what we consider a release-ready state.

## SemVer Policy

Patchlings follows semantic versioning (MAJOR.MINOR.PATCH).

- **MAJOR**: breaking changes to public contracts (Telemetry schema, CLI flags, persisted storage layout, theme API).
- **MINOR**: new features that are backwards compatible.
- **PATCH**: bug fixes, docs improvements, and internal refactors with no behavior change.

**Telemetry contract rule:** any breaking change to Telemetry v1 requires a protocol version bump and a migration note for downstream consumers.

## Changelog Strategy

We use a curated `CHANGELOG.md` at the repo root:

- Each release gets a dated entry under the new version.
- Sections include: Added, Changed, Fixed, Security (when relevant).
- Only user-facing changes go into the changelog; purely internal refactors are omitted unless they affect behavior.

## Release Steps (Manual)

1. Ensure `main` is green (CI passing).
2. Update `CHANGELOG.md` with the release notes.
3. Bump version(s) where needed (root package.json and any published packages).
4. Tag the release: `git tag vX.Y.Z`.
5. Push tags: `git push --tags`.
6. Create the GitHub release with notes copied from `CHANGELOG.md`.

## v0.1 Exit Criteria

A v0.1 release is ready when:

- Protocol v1 is stable and documented.
- Redaction + hashing defaults are verified and documented.
- Engine persistence + chaptering are reliable.
- Demo mode and Codex JSONL adapter are tested and usable.
- Viewer renders Universe + Learn-lings + Story Time with safe defaults.
- Deterministic replay fixture tests pass.
- Docs (Quickstart, Architecture, Themes, Security) are current.

## Notes

This plan is intentionally lightweight to keep early releases fast and safe. We can automate parts of the process after v0.1.
