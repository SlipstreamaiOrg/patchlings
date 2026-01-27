import { describe, expect, it } from "vitest";

import type { ChapterSummary, WorldState } from "@patchlings/engine";
import { generateStoryMarkdown } from "../src/index.js";

function makeWorld(runId: string): WorldState {
  return {
    v: 1,
    workspace_id: "ws-123",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:10:00.000Z",
    counters: {
      events: 10,
      chapters: 1,
      dropped_low_value_events: 0,
      duplicate_events: 0,
      backpressure_summaries: 1
    },
    runs: {
      [runId]: {
        run_id: runId,
        chapter_count: 1,
        event_count: 10,
        tool_count: 2,
        file_touch_count: 3,
        test_pass: 1,
        test_fail: 0,
        error_count: 0,
        dropped_low_value_events: 0,
        duplicate_events: 0,
        peak_events_per_sec: 120,
        last_upstream_seq: 9,
        internal_seq: 1_000_000_010,
        last_ts: "2026-01-01T00:09:00.000Z",
        recording_index: 0,
        recording_bytes: 1024
      }
    },
    regions: {},
    files: {},
    patchlings: {}
  };
}

function makeChapter(runId: string): ChapterSummary {
  return {
    v: 1,
    run_id: runId,
    chapter_id: "chap-1",
    turn_index: 1,
    status: "completed",
    started_ts: "2026-01-01T00:00:00.000Z",
    completed_ts: "2026-01-01T00:01:00.000Z",
    duration_ms: 60_000,
    seq_start: 1,
    seq_end: 10,
    files_touched: ["file_a", "file_b", "file_a"],
    tools_used: { shell: 2 },
    tests: { pass: 1, fail: 0 },
    errors: 0,
    backpressure: {
      dropped_low_value: 0,
      peak_events_per_sec: 120,
      threshold: 120,
      summaries_emitted: 1
    }
  };
}

describe("@patchlings/storytime", () => {
  it("generates deterministic markdown with a fixed timestamp", () => {
    const runId = "run-1";
    const world = makeWorld(runId);
    const chapters = [makeChapter(runId)];
    const generatedAt = "2026-01-01T12:00:00.000Z";

    const first = generateStoryMarkdown({
      runId,
      chapters,
      world,
      outputPath: ".patchlings/story/run-1.md",
      generatedAt
    });
    const second = generateStoryMarkdown({
      runId,
      chapters,
      world,
      outputPath: ".patchlings/story/run-1.md",
      generatedAt
    });

    expect(first).toBe(second);
    expect(first).toContain("Patchlings Story Time");
    expect(first).toContain("Backpressure: dropped 0, summaries 1");
  });
});

