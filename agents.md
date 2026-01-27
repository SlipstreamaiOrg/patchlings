# Agent Contract (Universal v1)

## 0) TL;DR
- Work only from a Work Packet (WP-###). One WP per branch and PR. :contentReference[oaicite:5]{index=5}
- Never change high-risk defaults (security, auth, prod deploy, money-moving, destructive ops) without explicit approval.
- Open a Draft PR early with WP + check-in scaffolding + Monitoring Status block.
- “Observability is required”: run Codex with machine-readable event output and checkpoint per turn.
- Stop on ambiguity, money/production risk without approval, or unexpected local changes.

---

## 1) Hard Rules (MUST / MUST NOT)

### Safety & approvals
- MUST NOT change security/authn/authz defaults, production deployment behavior, destructive operations defaults, or money-moving behavior without explicit approval.
- MUST NOT introduce secret leakage (keys/tokens/credentials) into commits, PRs, logs, or telemetry.
- MUST treat all telemetry/logs as potentially sensitive; default to metadata-only.

### Observability (required)
- MUST run Codex in machine-readable event mode for any non-trivial work:
  - Preferred: `codex exec --json "<prompt>"` to produce JSONL events (`turn.started`, `turn.completed`, `item.*`, `error`, etc.). :contentReference[oaicite:6]{index=6}
- MUST checkpoint at end-of-turn:
  - On `turn.completed` (or equivalent), write/update a “chapter” artifact (see Required Artifacts).
- If this repo includes a Patchlings/visualizer workflow, you MUST use it (do not “forget” observability):
  - If `patchlings` CLI exists or `.patchlings/` is present, run via the wrapper (e.g., `patchlings run -- "<prompt>"`) so the visualizer + recorder are always on.

### Git & change safety
- MUST NOT use destructive commands unless explicitly requested:
  - `git reset --hard`, `git clean`, `git restore`, `rm -rf`, force-push, rewrite history, delete branches.
- MUST NOT do broad search/replace across the repo without a WP-scoped plan and explicit approval.
- MUST stop and ask if unexpected changes appear in the worktree.

### Drift-free workflow (Work Packets)
- MUST map every change to a WP or an `[ambiguity]` issue before edits begin. :contentReference[oaicite:7]{index=7}
- MUST assign a new WP-### when none is provided; record it in branch name, check-in, and PR body. :contentReference[oaicite:8]{index=8}
- MUST keep one WP per branch/PR; use `wp/<id>-<slug>` naming. :contentReference[oaicite:9]{index=9}
- MUST NOT batch multiple WPs in one PR.
- MUST NOT cross-pollinate fixes between WPs; open a follow-up WP if needed.
- Advisory-only requests are allowed without a WP if you perform no edits and no stateful commands.

### Process invariants
- MUST keep `main` green; do not merge unless required checks are green and reporting. :contentReference[oaicite:10]{index=10}
- MUST treat `AGENTS.md` as enforced from repo root and nearest parent; add nested `AGENTS.md` for do-not-touch boundaries. :contentReference[oaicite:11]{index=11}
- MUST include a closing keyword in every WP PR body (e.g., `Fixes #<issue>`) so GitHub auto-closes the WP issue. :contentReference[oaicite:12]{index=12}
- SHOULD prefer `gh pr edit --body-file` / `gh pr comment --body-file` on Windows to avoid quoting issues. :contentReference[oaicite:13]{index=13}

### Branch protection expectation (repo owners should enable)
- Expect protected branches with required status checks and required reviews. :contentReference[oaicite:14]{index=14}
- If CODEOWNERS is used, expect code-owner review to be required for sensitive paths. :contentReference[oaicite:15]{index=15}

---

## 2) Default Flow
1. Read `AGENTS.md` (this file) + any repo-specific guardrails docs (e.g., `docs/PROJECT_GUARDRAILS.md`) + SSOT index if present.
2. Check for collisions:
   - `gh issue list -l status:in-progress`
   - `gh pr list`
3. Ensure the WP issue includes: requirements, scope, plan, do-not-touch boundaries, risks, acceptance criteria.
4. Claim the WP: assign yourself, add `status:in-progress`, comment:
   - `CLAIMED: WP-### (branch wp/<id>-<slug>)` :contentReference[oaicite:16]{index=16}
5. Create branch `wp/<id>-<slug>`.
6. Create required artifacts (WP doc + check-in + chapter/telemetry setup if needed).
7. Open a Draft PR within 30–60 minutes using the PR template + Monitoring Status block. :contentReference[oaicite:17]{index=17}
8. Implement strictly within scope; update check-in at milestones; post status updates at:
   - preflight complete, scope change, PR open, blocked/handoff.
9. Run required tests/validation; document commands/results (or justify skips).
10. After CI is green and the PR is stable with no unresolved threads, request ONE final `@codex` behavior-diff review (comment-only, non-gating). :contentReference[oaicite:18]{index=18}
11. Merge only when: no unresolved threads, CI green, artifacts finalized, and explicit approval recorded.

### Codex Review Protocol (Dynamic Behavior-Diff)
When requesting `@codex` review, do not ask for generic LGTM. Ask for a behavioral diff versus base, scoped to WP + diff. :contentReference[oaicite:19]{index=19}

Copy/paste comment template:
```md
@codex Final behavior-diff review (WP-###)

Context (from WP)
- Goal: <1–2 sentences>
- Acceptance criteria:
  - ...
- Out of scope / do-not-touch:
  - ...

Diff scope (from `git diff --name-only <base>...HEAD`)
- <top-level dirs + key files>
- ...

Request
1) Compare this PR to the base branch and list behavioral differences (before → after). Focus on runtime behavior, defaults, and edge cases.
2) Call out any unintended behavior changes outside WP scope.
3) Identify risk areas (security/privacy, data/migrations, ops) and any must-fix-before-merge items.
4) List missing/needed tests and docs updates required.
5) If something should block merge, say so explicitly.
