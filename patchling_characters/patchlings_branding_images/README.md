# Patchlings Branding + Character Assets (Canonical)

This folder is the canonical source of truth for Patchlings character assets. Codex and contributors should look here first for 2D animation assets used by the PixiJS Universe viewer.

Scope:
- Patchlings branding images (logos, marks, variants)
- Patchling character sprites and animation assets
- Any 2D character assets referenced by the viewer

## Expected Structure

```text
patchling_characters/
  patchlings_branding_images/
    sprites_v1/
      sprites/   # individual frames
      sheets/    # sprite sheets
```

## Sprite Conventions (v1)

### Individual Frames

Frames live under:
- `sprites_v1/sprites/`

Filename convention:
- `patchling_<action>_<dir>_<frame>_<size>.png`

Allowed values:
- actions: `idle` | `walk` | `carry`
- dirs: `S` | `E` | `N` | `W`
- sizes: `256` | `128` | `64`

Important loader note:
- The current viewer probes lowercase direction tokens and two-digit frame numbers.
- Example the loader expects: `patchling_idle_s_01_128.png`

### Sprite Sheets

Sheets live under:
- `sprites_v1/sheets/`

Filename convention:
- `patchling_<action>_sheet_128.png`

Layout convention:
- rows = `S, E, N, W` (in that order)
- cols = frame index (left to right)

## How The Viewer Loads Assets

The viewer loads sprites from the runner's asset route (default `/patchlings-assets`), which is served from this canonical folder.

Load order:
1. Prefer sprite sheets for performance.
2. Fall back to individual frames.
3. If neither exists, enter placeholder mode.

When assets are missing, the viewer prints exact expected paths in the browser console.

## DO NOT

- Do not rename `patchling_characters/patchlings_branding_images/`.
- Do not change naming conventions without updating the loader in `apps/viewer/src/colony/assets.ts`.
- Do not place raw prompt/tool output or sensitive telemetry here.

## Quick Test

1. Run the demo:

```bash
npx pnpm@9.12.0 demo
```

2. Open the viewer (see terminal output for the URL).
3. In the browser console:
- You should not see sprite-missing warnings.
- A success signal (if present) should look like: `Loaded Patchlings sprites v1`.

If you see warnings about missing sheets or frames, check:
- `patchling_characters/patchlings_branding_images/sprites_v1/sheets/`
- `patchling_characters/patchlings_branding_images/sprites_v1/sprites/`
