import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { TelemetryEventV1 } from "@patchlings/protocol";
import { fileTailAdapter } from "../src/index.js";

describe("fileTailAdapter", () => {
  it("handles truncated lines without crashing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "patchlings-tail-"));
    const filePath = path.join(dir, "recording.jsonl");

    const goodLine = JSON.stringify({
      v: 1,
      run_id: "run-tail",
      seq: 0,
      ts: "2026-01-01T00:00:00.000Z",
      kind: "turn",
      name: "turn.started"
    });
    const truncatedLine = "{\"v\":1,\"run_id\":\"run-tail\",\"seq\":1";

    await writeFile(filePath, `${goodLine}\n${truncatedLine}`);

    const context = {
      runId: "run-tail",
      workspaceSalt: "workspace-salt",
      runSalt: "run-salt",
      getRunSalt: () => "run-salt"
    };

    const handle = await fileTailAdapter({
      filePath,
      context,
      fromStart: true,
      pollIntervalMs: 10,
      endOnIdleMs: 50
    });

    const events: TelemetryEventV1[] = [];
    for await (const event of handle.stream) {
      events.push(event);
    }
    await handle.stop();

    expect(events.some((event) => event.name === "turn.started")).toBe(true);
    expect(events.some((event) => event.name === "log.unparsed_line")).toBe(true);
  });
});
