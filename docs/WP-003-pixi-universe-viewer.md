# WP-003 — PixiJS Universe Viewer + Patchlings Colony Simulation (v0.1)

## Goal
Upgrade the Universe viewer to a PixiJS top-down colony simulation driven by the existing runner WebSocket stream and TelemetryEventV1 events.

## Scope (In)
- Add PixiJS to `apps/viewer`.
- Implement a layered Pixi scene graph with pannable/zoomable camera.
- Implement Patchling entities with `idle | walk | carry | interact` states.
- Implement stations + job system driven by normalized telemetry.
- Implement sprite loading from `patchling_characters/patchlings_branding_images/` with fallback.
- Wire Learn-lings overlay + timeline + Story Time export to existing runner APIs.
- Add asset sanity check warnings at startup.
- Update `docs/QUICKSTART.md` and `docs/THEMES.md`.

## Scope (Out)
- High-fidelity building art.
- Deep theme/plugin architecture changes.
- Any changes to security/privacy defaults.

## Constraints
- Privacy-first: metadata only, no raw prompts/tool payloads.
- Viewer talks only to runner (`/stream`, `/export/storytime`, `/patchlings-assets/*`).
- Keep scope tight and ship a functional colony loop.

## Plan
1. Add an asset route + sanity checks in the runner.
2. Add PixiJS to the viewer app.
3. Implement a Pixi colony simulation:
   - Scene graph layers
   - Camera pan/zoom + soft follow hotspot
   - Stations, districts, buildings, paths
   - Patchlings, jobs, and basic FX
4. Wire telemetry to jobs + hotspot + UI cues.
5. Update docs and validate with `pnpm demo`.

## Acceptance Criteria
- `pnpm demo` renders a top-down world and Patchlings move around doing jobs.
- Patchlings visually switch idle/walk/carry states.
- Chapter timeline updates on `turn.completed`.
- Learn-lings toggle works and remains metadata-only.
- Works without any sprite assets (fallback mode), but uses sprites when present.
- No secrets displayed.

## References
- Canonical asset root (default): `patchling_characters/patchlings_branding_images/`
- Sprite sheets: `patchling_characters/patchlings_branding_images/sprites_v1/sheets/`
- Individual frames: `patchling_characters/patchlings_branding_images/sprites_v1/sprites/`
