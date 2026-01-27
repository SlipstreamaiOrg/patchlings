# Security And Privacy

Patchlings is privacy-first by default. It is designed to be safe to run in public OSS repos without leaking prompts, tool payloads, or secrets.

## Threat Model (Telemetry-Centric)

Risks:

- Prompts and tool payloads can contain secrets
- File paths can reveal sensitive project structure
- High-volume streams can cause UI stalls or crashes

Mitigations:

- Redaction is on by default
- Sensitive keys are stripped from `attrs`
- Paths and identifiers are hashed with salts
- Backpressure aggregates low-value spam into metric summaries

## Safe Defaults

- Raw prompt and tool content is not displayed or stored by default
- File and region identifiers are hashed
- Workspace salt is stable across sessions
- Run salts isolate runs from each other

Opting into content requires:

```bash
PATCHLINGS_ALLOW_CONTENT=true
```

This is intentionally off by default.

## How To Verify You Are Not Leaking Content

1. Run a demo or Codex run
2. Inspect `.patchlings/recordings/` and `.patchlings/world.json`
3. Search for obvious sensitive terms:

```bash
rg -n "prompt|token|secret|authorization|cookie|password|api[_-]?key" .patchlings
```

You should see hashed identifiers and metadata, not raw payloads.

## Reporting Security Issues

Until a dedicated channel exists, open a GitHub issue and avoid posting secrets. If you discover a leak vector, describe the class of issue and provide a minimal repro without sensitive data.

