# Quickstart

Patchlings is a standalone OSS repo. It does not assume anything about the host project beyond a working directory and an event stream.

Node 20+ is recommended.

## 1) Install (Pinned pnpm, No Corepack Required)

This repo pins pnpm via `packageManager`. On Windows, `corepack enable` can fail due to permissions; treat that as non-blocking and continue.

```bash
npx pnpm@9.12.0 install
```

## 2) Demo Mode (No Codex Required)

```bash
npx pnpm@9.12.0 demo
```

Open:

- Viewer (Vite dev server): `http://localhost:5173`
- Runner health: `http://localhost:4317/health`

The viewer dev server proxies `/stream`, `/export/storytime`, and `/patchlings-assets` to the runner.

If port `4317` is busy:

```bash
PATCHLINGS_PORT=4321 npx pnpm@9.12.0 demo
```

PowerShell:

```powershell
$env:PATCHLINGS_PORT=4321; npx pnpm@9.12.0 demo
```

## 3) Sprite Assets (Optional, Canonical Path)

By default, the runner serves sprite assets from:

- `patchling_characters/patchlings_branding_images/`

Expected subpaths:

- Sheets: `patchling_characters/patchlings_branding_images/sprites_v1/sheets/`
- Frames: `patchling_characters/patchlings_branding_images/sprites_v1/sprites/`

If assets are missing, the viewer falls back to simple placeholder Patchlings and logs a clear warning.

Overrides:

- Runner asset root: `PATCHLINGS_ASSETS_DIR`
- Viewer asset base URL: `VITE_PATCHLINGS_ASSET_BASE` (default `/patchlings-assets`)

## 4) Codex CLI Integration

Patchlings ingests machine-readable JSONL from:

```bash
codex exec --json "<prompt>"
```

Run it through Patchlings:

```bash
npx pnpm@9.12.0 run -- "Implement a demo adapter and render a persistent world."
```

Then open `http://localhost:5173`.

## 5) Replay A Recording

Recordings are stored under `.patchlings/recordings/`.

```bash
npx pnpm@9.12.0 replay -- .patchlings/recordings/<run_id>.jsonl
```

## 6) Export Story Time

```bash
npx pnpm@9.12.0 export-story -- latest
```

Output:

- `.patchlings/story/<run_id>.md`

## Useful Environment Variables

- `PATCHLINGS_PORT`: runner HTTP/WS port (default `4317`)
- `PATCHLINGS_ASSETS_DIR`: override the canonical asset root
- `VITE_PATCHLINGS_ASSET_BASE`: override the viewer asset base URL
- `PATCHLINGS_ALLOW_CONTENT`: opt into raw content display/storage (default `false`)
