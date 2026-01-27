import { describe, expect, it } from "vitest";

import type { TelemetryEventV1 } from "@patchlings/protocol";
import { explainEvent, explainEvents } from "../src/index.js";

function makeEvent(overrides: Partial<TelemetryEventV1>): TelemetryEventV1 {
  return {
    v: 1,
    run_id: "run-1",
    seq: 1,
    ts: "2026-01-01T00:00:00.000Z",
    kind: "log",
    name: "log.note",
    attrs: {},
    ...overrides
  };
}

describe("@patchlings/learnlings", () => {
  it("explains common turn events without leaking content", () => {
    const event = makeEvent({
      kind: "turn",
      name: "turn.started",
      attrs: {
        prompt: "do not leak this",
        prompt_hash: "abc123"
      }
    });

    const explanation = explainEvent(event);
    expect(explanation?.message).toContain("turn");
    expect(explanation?.message).not.toContain("do not leak this");
  });

  it("filters internal noise by default but keeps backpressure summaries", () => {
    const internalNoise = makeEvent({
      kind: "metric",
      name: "metric.tick",
      internal: true
    });
    const backpressure = makeEvent({
      kind: "metric",
      name: "metric.backpressure.summary",
      internal: true,
      attrs: { count: 200, threshold: 120 }
    });

    const messages = explainEvents([internalNoise, backpressure]);
    expect(messages.some((message) => message.name === "metric.tick")).toBe(false);
    expect(messages.some((message) => message.name === "metric.backpressure.summary")).toBe(true);
  });
});

