# WP-011 — Colony Sim Stability + Demo Loop

## Goal
Keep the Pixi colony feeling alive: fix sprite refresh crash, add ambient wandering, and loop demo telemetry so the viewer never goes idle.

## Scope (In)
- Guard AnimatedSprite refresh to avoid destroying shared textures.
- Add idle wander timing so agents keep moving when no jobs are queued.
- Add a demo adapter loop option and enable it for `patchlings demo`/`dev`.

## Scope (Out)
- New art assets or visual design changes.
- Protocol/engine changes.

## Constraints
- Privacy-safe logs only.
- Minimal behavior changes outside the viewer/demo adapter.

## Plan
1. Harden sprite refresh teardown to avoid Pixi destroy crashes.
2. Add idle wander cadence so agents keep moving.
3. Add demo loop option + wire runner to enable it for demo/dev.

## Acceptance Criteria
- Demo runs continuously without stopping.
- Agents keep ambient motion when idle.
- No console crash during sprite refresh.
