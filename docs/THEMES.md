# Themes

Patchlings is an engine plus themes. Themes are pluggable render reducers that convert persistent world state plus recent events into render state for the viewer.

The built-in theme is:

- Patchlings: Universe (default)

## Theme Interface

Themes live in `packages/themes` today, but the interface is designed so theme packs can be published independently later.

High-level contract:

- Input: `{ world, events, chapters }`
- Output: a render state the viewer can draw

Example skeleton:

```ts
import type { Theme } from "@patchlings/themes";

export const myTheme: Theme = {
  id: "my-theme",
  name: "My Theme",
  reduce({ world, events, chapters }) {
    return {
      meta: {
        workspaceId: world.workspace_id,
        updatedAt: world.updated_at,
        counters: world.counters,
        chapterCount: chapters.length
      },
      regions: [],
      files: [],
      patchlings: [],
      recentEvents: events.slice(-50).map((event) => ({
        runId: event.run_id,
        ts: event.ts,
        kind: event.kind,
        name: event.name
      }))
    };
  }
};
```

## Design Guidelines

- Do not assume raw content is available
- Expect identifiers to be hashed
- Cap entity counts to protect frame time
- Treat themes as pure reducers

## Learn-lings Overlay

Learn-lings is a UI overlay driven by event mappings. It is not baked into a theme and can be toggled independently.

