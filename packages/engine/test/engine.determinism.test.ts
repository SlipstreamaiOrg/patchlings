import { describe, expect, it } from "vitest";

import type { TelemetryEventV1 } from "@patchlings/protocol";

import { PatchlingsEngine } from "../src/index.js";

function makeEvent(partial: Omit<TelemetryEventV1, "v">): TelemetryEventV1 {
  return { v: 1, ...partial };
}

describe("PatchlingsEngine determinism", () => {
  it("produces identical chapter summaries on replay", async () => {
    const runId = "run-deterministic";
    const baseTs = new Date("2026-01-01T00:00:00.000Z").getTime();

    const events: TelemetryEventV1[] = [
      makeEvent({
        run_id: runId,
        seq: 0,
        ts: new Date(baseTs + 0).toISOString(),
        kind: "turn",
        name: "turn.started"
      }),
      ...Array.from({ length: 8 }, (_, index) =>
        makeEvent({
          run_id: runId,
          seq: 1 + index,
          ts: new Date(baseTs + 100).toISOString(),
          kind: "log",
          name: "log.progress",
          severity: "debug",
          attrs: { message: `tick-${index}` }
        })
      ),
      makeEvent({
        run_id: runId,
        seq: 20,
        ts: new Date(baseTs + 200).toISOString(),
        kind: "tool",
        name: "tool.shell.start",
        attrs: {
          tool_name: "shell",
          path: "src/example.ts"
        }
      }),
      makeEvent({
        run_id: runId,
        seq: 21,
        ts: new Date(baseTs + 300).toISOString(),
        kind: "file",
        name: "file.write",
        attrs: {
          path: "src/example.ts"
        }
      }),
      makeEvent({
        run_id: runId,
        seq: 22,
        ts: new Date(baseTs + 500).toISOString(),
        kind: "turn",
        name: "turn.completed"
      })
    ];

    const createEngine = () =>
      PatchlingsEngine.create({
        storageMode: "memory",
        eventsPerSecondThreshold: 3,
        fixedSalts: {
          workspaceSalt: "workspace-salt",
          runSalts: {
            [runId]: "run-salt"
          }
        }
      });

    const engineA = await createEngine();
    const engineB = await createEngine();

    await engineA.ingestBatch(events);
    await engineB.ingestBatch(events);

    const chaptersA = engineA.getChapters();
    const chaptersB = engineB.getChapters();

    expect(chaptersA).toEqual(chaptersB);
    expect(chaptersA[0]?.backpressure.dropped_low_value).toBeGreaterThan(0);
    expect(chaptersA[0]?.backpressure.summaries_emitted).toBeGreaterThan(0);
  });
});
