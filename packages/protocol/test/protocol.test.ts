import { describe, expect, it } from "vitest";

import { validateTelemetryEventV1 } from "../src/index.js";

describe("TelemetryEventV1 validation", () => {
  it("accepts a valid event", () => {
    const result = validateTelemetryEventV1({
      v: 1,
      run_id: "run-1",
      seq: 0,
      ts: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      kind: "turn",
      name: "turn.started",
      attrs: {
        attempt: 1,
        ok: true,
        note: null
      }
    });

    expect(result.ok).toBe(true);
    expect(result.value?.kind).toBe("turn");
  });

  it("rejects missing required fields", () => {
    const result = validateTelemetryEventV1({
      v: 1,
      run_id: "",
      seq: -1,
      ts: "not-a-date",
      kind: "unknown",
      name: ""
    });

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects invalid attr types", () => {
    const result = validateTelemetryEventV1({
      v: 1,
      run_id: "run-2",
      seq: 1,
      ts: new Date().toISOString(),
      kind: "log",
      name: "log.message",
      attrs: {
        nested: { nope: true }
      }
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("attrs.nested"))).toBe(true);
  });
});