# WP-005 — Canonical Patchlings Character Assets

## Goal
Check in the canonical Patchlings character assets for branding and the PixiJS Universe viewer.

## Scope (In)
- Add the provided branding images and character sprites under `patchling_characters/patchlings_branding_images/`.
- Include any accompanying brand notes provided with the assets.

## Scope (Out)
- Code or behavior changes
- Asset pipeline tooling

## Constraints
- Privacy-first: do not include any prompt/tool payloads or secrets.
- Keep the canonical asset root unchanged.

## Plan
1. Add asset files to the canonical root and verify structure.
2. Commit assets with a focused message.
3. Open a draft PR that closes WP-005.

## Acceptance Criteria
- Assets are tracked in git at `patchling_characters/patchlings_branding_images/`.
- Folder structure matches `README.md` conventions.
- No code or behavior changes are introduced.
