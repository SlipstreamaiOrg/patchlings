import type { TelemetryEventV1 } from "@patchlings/protocol";

export interface LearnlingMessage {
  id: string;
  ts: string;
  runId: string;
  kind: TelemetryEventV1["kind"];
  name: string;
  severity?: TelemetryEventV1["severity"];
  message: string;
}

export interface LearnlingRule {
  id: string;
  priority?: number;
  when(event: TelemetryEventV1): boolean;
  message: string | ((event: TelemetryEventV1) => string);
}

export interface LearnlingsOptions {
  limit?: number;
  includeInternal?: boolean;
  rules?: LearnlingRule[];
}

const DEFAULT_LIMIT = 12;

function readNumberAttr(event: TelemetryEventV1, key: string): number | undefined {
  const value = event.attrs?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringAttr(event: TelemetryEventV1, key: string): string | undefined {
  const value = event.attrs?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isInternalNoise(event: TelemetryEventV1, includeInternal: boolean): boolean {
  if (includeInternal) {
    return false;
  }
  if (event.internal !== true) {
    return false;
  }
  return event.name !== "metric.backpressure.summary";
}

function defaultMessage(event: TelemetryEventV1): string {
  switch (event.kind) {
    case "turn":
      return "The agent is working through a turn and keeping track of progress.";
    case "tool":
      return "A tool is being used to inspect or change the project safely.";
    case "file":
      return "A file was touched as part of the patching process.";
    case "test":
      return "Tests help confirm that changes still behave as expected.";
    case "git":
      return "Git activity helps track what changed and why.";
    case "spawn":
      return "A helper process was started to handle a sub-task.";
    case "error":
      return "An error occurred; the agent can often recover and try a different path.";
    case "metric":
      return "The system is measuring how the run is going.";
    case "log":
    default:
      return "Patchlings recorded a step in the agent's workflow.";
  }
}

export const defaultRules: LearnlingRule[] = [
  {
    id: "turn-started",
    priority: 10,
    when: (event) => event.kind === "turn" && event.name === "turn.started",
    message: "A new turn started. The agent is planning the next set of changes."
  },
  {
    id: "turn-completed",
    priority: 10,
    when: (event) => event.kind === "turn" && event.name === "turn.completed",
    message: "The turn completed. Patchlings checkpointed this chapter."
  },
  {
    id: "turn-failed",
    priority: 10,
    when: (event) => event.kind === "turn" && event.name === "turn.failed",
    message: "The turn failed. The agent will usually adapt and try another approach."
  },
  {
    id: "tool-shell",
    priority: 8,
    when: (event) => event.kind === "tool" && event.name.startsWith("tool.shell"),
    message: (event) => {
      const toolName = readStringAttr(event, "tool_name") ?? "shell tool";
      return `Running a terminal command with ${toolName} to inspect or update the repo.`;
    }
  },
  {
    id: "tool-generic",
    priority: 6,
    when: (event) => event.kind === "tool",
    message: "The agent is using a tool to gather info or apply a safe change."
  },
  {
    id: "file-write",
    priority: 8,
    when: (event) => event.kind === "file" && (event.name.includes("write") || event.name.includes("patch")),
    message: "A file is being updated. This is a patch applied to your project."
  },
  {
    id: "file-touch",
    priority: 6,
    when: (event) => event.kind === "file",
    message: "A file was touched as part of the current change."
  },
  {
    id: "test-pass",
    priority: 8,
    when: (event) => event.kind === "test" && event.name.endsWith("pass"),
    message: "Tests passed. This is a good signal that the change did not break expectations."
  },
  {
    id: "test-fail",
    priority: 8,
    when: (event) => event.kind === "test" && event.name.endsWith("fail"),
    message: "A test failed. The agent can use this feedback to fix regressions."
  },
  {
    id: "git-activity",
    priority: 6,
    when: (event) => event.kind === "git",
    message: "Git activity helps capture the story of what changed."
  },
  {
    id: "spawn-activity",
    priority: 6,
    when: (event) => event.kind === "spawn",
    message: "A helper process was started to work on a sub-task."
  },
  {
    id: "backpressure-summary",
    priority: 9,
    when: (event) => event.kind === "metric" && event.name === "metric.backpressure.summary",
    message: (event) => {
      const count = readNumberAttr(event, "count");
      const threshold = readNumberAttr(event, "threshold");
      if (typeof count === "number" && typeof threshold === "number") {
        return `Lots of events arrived quickly (${count} in a second). Patchlings summarized them to stay responsive.`;
      }
      return "Events arrived quickly, so Patchlings summarized them to keep the UI responsive.";
    }
  },
  {
    id: "error-activity",
    priority: 9,
    when: (event) => event.kind === "error",
    message: "An error occurred. Patchlings recorded it so you can debug safely."
  }
];

function sortRules(rules: LearnlingRule[]): LearnlingRule[] {
  return [...rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

export function explainEvent(event: TelemetryEventV1, rules: LearnlingRule[] = defaultRules): LearnlingMessage | null {
  const orderedRules = sortRules(rules);
  for (const rule of orderedRules) {
    if (!rule.when(event)) {
      continue;
    }
    const message = typeof rule.message === "function" ? rule.message(event) : rule.message;
    return {
      id: `${event.run_id}:${event.seq}:${rule.id}`,
      ts: event.ts,
      runId: event.run_id,
      kind: event.kind,
      name: event.name,
      ...(event.severity ? { severity: event.severity } : {}),
      message
    };
  }

  return {
    id: `${event.run_id}:${event.seq}:default`,
    ts: event.ts,
    runId: event.run_id,
    kind: event.kind,
    name: event.name,
    ...(event.severity ? { severity: event.severity } : {}),
    message: defaultMessage(event)
  };
}

export function explainEvents(events: TelemetryEventV1[], options: LearnlingsOptions = {}): LearnlingMessage[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const includeInternal = options.includeInternal ?? false;
  const rules = options.rules ?? defaultRules;

  const messages: LearnlingMessage[] = [];
  for (const event of events) {
    if (isInternalNoise(event, includeInternal)) {
      continue;
    }
    const message = explainEvent(event, rules);
    if (message) {
      messages.push(message);
    }
  }

  const deduped = new Map<string, LearnlingMessage>();
  for (const message of messages) {
    deduped.set(message.id, message);
  }

  return [...deduped.values()]
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(Math.max(0, deduped.size - limit));
}

