# Quickstart

Patchlings is a standalone OSS repo. It does not assume anything about the host project beyond a working directory and an event stream.

## 1) Install

```bash
npm install -g pnpm
pnpm install
```

Node 20+ is recommended.

## 2) Demo Mode (No Codex Required)

```bash
pnpm demo
```

Open:

- Viewer: `http://localhost:5173`
- Runner health: `http://localhost:4317/health`

The viewer dev server proxies `/stream` and `/export/storytime` to the runner.

## 3) Codex CLI Integration

Patchlings ingests machine-readable JSONL from:

```bash
codex exec --json "<prompt>"
```

Run it through Patchlings:

```bash
pnpm run -- "Implement a demo adapter and render a persistent world."
```

Then open `http://localhost:5173`.

## 4) Replay A Recording

Recordings are stored under `.patchlings/recordings/`.

```bash
pnpm replay -- .patchlings/recordings/<run_id>.jsonl
```

## 5) Export Story Time

```bash
pnpm export-story -- latest
```

Output:

- `.patchlings/story/<run_id>.md`

## Useful Environment Variables

- `PATCHLINGS_PORT`: runner HTTP/WS port (default `4317`)
- `PATCHLINGS_ALLOW_CONTENT`: opt into raw content display/storage (default `false`)

