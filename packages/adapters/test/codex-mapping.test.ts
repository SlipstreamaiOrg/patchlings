import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { hashPath, hashWithSalt } from "@patchlings/redact";
import { __test__ } from "../src/index.js";

const FIXTURE_PATH = new URL("./fixtures/codex.jsonl", import.meta.url);

function loadFixtureLines(): string[] {
  const text = readFileSync(FIXTURE_PATH, "utf8").trim();
  return text.length === 0 ? [] : text.split(/\r?\n/);
}

describe("codex JSONL mapping", () => {
  it("maps fixture events into Telemetry v1 safely", () => {
    const lines = loadFixtureLines();
    const context = {
      runId: "fallback-run",
      workspaceSalt: "workspace-salt",
      runSalt: "run-salt",
      getRunSalt: () => "run-salt"
    };
    const prompt = "sample prompt";
    const seqSynth = new __test__.SeqSynthesizer();

    const events = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .map((raw) => {
        const mapped = __test__.mapCodexRawEvent(raw, prompt, context);
        return __test__.normalizeInputEvent(mapped, context, seqSynth);
      })
      .filter((event): event is NonNullable<typeof event> => Boolean(event));

    expect(events.length).toBeGreaterThan(0);
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5]);

    const threadStart = events.find((event) => event.name === "thread.started");
    expect(threadStart?.kind).toBe("spawn");
    expect(threadStart?.run_id).toBe("thread-1");

    const turnStart = events.find((event) => event.name === "turn.started");
    expect(turnStart?.kind).toBe("turn");
    expect(turnStart?.attrs?.prompt_hash).toBe(hashWithSalt(prompt, "run-salt"));

    const fileEvent = events.find((event) => event.kind === "file");
    expect(fileEvent?.name).toBe("file.write");
    expect(fileEvent?.attrs?.path).toBeUndefined();
    expect(fileEvent?.attrs?.path_hash).toBe(hashPath("src/index.ts", "run-salt"));
    expect(fileEvent?.attrs?.path_stable_hash).toBe(hashPath("src/index.ts", "workspace-salt"));

    const toolEvent = events.find((event) => event.name === "tool.shell.start");
    expect(toolEvent?.kind).toBe("tool");

    const testEvent = events.find((event) => event.kind === "test");
    expect(testEvent?.name).toBe("test.pass");

    const errorEvent = events.find((event) => event.kind === "error");
    expect(errorEvent?.severity).toBe("error");
    expect(errorEvent?.attrs?.error_code).toBe(hashWithSalt("boom", "run-salt"));
  });
});
