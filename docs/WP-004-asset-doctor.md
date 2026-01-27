# WP-004 — Canonical Assets + Asset Doctor

## Goal
Lock in Patchlings character asset conventions and add a robust asset doctor + viewer UX so contributors never get confused.

## Scope (In)
- Canonical asset README + gitkeep structure
- Single source of truth for asset root constant
- Asset doctor command with exit codes
- Viewer startup logging + HUD pill for sprite status
- Docs updates (Quickstart + Architecture)

## Scope (Out)
- New art assets
- Theme/engine features unrelated to asset loading

## Constraints
- Privacy-first: no secrets or prompt/tool payloads in output
- Canonical asset root is `patchling_characters/patchlings_branding_images/`
- Keep defaults backward compatible where possible

## Plan
1. Add canonical constant and env override handling.
2. Implement asset doctor command.
3. Update viewer startup logs + HUD pill.
4. Update docs and validate.

## Acceptance Criteria
- README documents asset conventions and folder layout.
- Asset doctor reports status and exits 0/1 correctly.
- Viewer logs "Loaded Patchlings sprites v1" or "Patchlings sprites missing; running placeholder mode".
- HUD shows "Sprites: Loaded" or "Sprites: Placeholder".
- Docs mention canonical root + fallback order + doctor command.
