# Patchlings Sprite Pack (v1)

This pack contains 2D sprite frames derived from the canonical Patchling mascot.

## Directory layout
- `sprites/` individual frames (PNG, transparent)
- `sheets/` sprite sheets (PNG, transparent)

## Naming
`patchling_<action>_<dir>_<frame>_<size>.png`

- `<action>`: `idle` | `walk` | `carry`
- `<dir>`: `S` | `E` | `N` | `W`
- `<frame>`: zero-based frame index
- `<size>`: `256` | `128` | `64`

Examples:
- `patchling_walk_E_03_128.png`
- `patchling_carry_S_00_256.png`

## Sprite sheets
- `patchling_<action>_sheet_128.png`
- `patchling_<action>_sheet_64.png`

Sheet layout:
- Rows: directions in order `S, E, N, W`
- Columns: frame index increasing left→right

## Notes
- These are "chibi side-view" sprites intended to move on a 2D plane (top-down world). For strict top-down, we can create a dedicated top-down sprite set later.
- `carry` frames include a subtle block glow to read as "work in progress".
