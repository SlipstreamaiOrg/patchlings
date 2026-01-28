import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { TelemetryEventV1 } from "@patchlings/protocol";

import { PatchlingsEngine } from "../src/index.js";

const FIXTURE_PATH = new URL("./fixtures/replay.jsonl", import.meta.url);

function loadFixtureEvents(): TelemetryEventV1[] {
  const text = readFileSync(FIXTURE_PATH, "utf8").trim();
  if (!text) {
    return [];
  }
  return text.split(/\r?\n/).map((line) => JSON.parse(line) as TelemetryEventV1);
}

describe("PatchlingsEngine replay fixture", () => {
  it("replays fixture deterministically", async () => {
    const events = loadFixtureEvents();
    const runId = "run-fixture";

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

    expect(engineA.getChapters()).toEqual(engineB.getChapters());
    expect(engineA.getChapters().length).toBeGreaterThan(0);
  });
});
