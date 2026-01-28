import type { TelemetryAttrs, TelemetryEventV1 } from "@patchlings/protocol";

export type StationId = "board" | "library" | "forge" | "terminal" | "gate" | "archive";

export type JobType =
  | "TURN_START"
  | "TURN_COMPLETE"
  | "FILE_READ"
  | "FILE_WRITE"
  | "TEST_RUN"
  | "TEST_PASS"
  | "TEST_FAIL"
  | "APPROVAL_WAIT"
  | "TOOL_RUN";

export interface JobSeed {
  id: string;
  eventKey: string;
  type: JobType;
  stationId: StationId;
  runId: string;
  seq: number;
  ts: string;
  eventName: string;
  severity?: TelemetryEventV1["severity"];
  districtId?: string;
  buildingId?: string;
  metadata: {
    kind: TelemetryEventV1["kind"];
    name: string;
  };
}

function pickString(attrs: TelemetryAttrs | undefined, keys: string[]): string | undefined {
  if (!attrs) {
    return undefined;
  }
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export function stableRegionId(attrs: TelemetryAttrs | undefined): string | undefined {
  return pickString(attrs, [
    "path_stable_dir_hash",
    "file_path_stable_dir_hash",
    "target_path_stable_dir_hash",
    "source_path_stable_dir_hash",
    "path_dir_hash",
    "file_path_dir_hash",
    "target_path_dir_hash",
    "source_path_dir_hash"
  ]);
}

export function stablePathId(attrs: TelemetryAttrs | undefined): string | undefined {
  return pickString(attrs, [
    "path_stable_hash",
    "file_path_stable_hash",
    "target_path_stable_hash",
    "source_path_stable_hash",
    "path_hash",
    "file_path_hash",
    "target_path_hash",
    "source_path_hash"
  ]);
}

function looksLikeApproval(event: TelemetryEventV1): boolean {
  const name = event.name.toLowerCase();
  if (name.includes("approval") || name.includes("gate")) {
    return true;
  }
  const attrs = event.attrs;
  if (!attrs) {
    return false;
  }
  return (
    attrs.approval === true ||
    attrs.approval_state === "wait" ||
    attrs.approval_state === "pending"
  );
}

function fileJobType(name: string): JobType {
  if (name.includes("read")) {
    return "FILE_READ";
  }
  return "FILE_WRITE";
}

function testJobType(name: string): JobType {
  if (name.includes("fail")) {
    return "TEST_FAIL";
  }
  if (name.includes("pass")) {
    return "TEST_PASS";
  }
  return "TEST_RUN";
}

export function mapEventToJobSeed(event: TelemetryEventV1): JobSeed | null {
  const eventKey = `${event.run_id}:${event.seq}`;
  const nameLower = event.name.toLowerCase();

  if (event.kind === "turn") {
    if (event.name === "turn.started") {
      return {
        id: `job:${eventKey}`,
        eventKey,
        type: "TURN_START",
        stationId: "board",
        runId: event.run_id,
        seq: event.seq,
        ts: event.ts,
        eventName: event.name,
        metadata: { kind: event.kind, name: event.name }
      };
    }

    if (event.name === "turn.completed" || event.name === "turn.failed") {
      return {
        id: `job:${eventKey}`,
        eventKey,
        type: "TURN_COMPLETE",
        stationId: "archive",
        runId: event.run_id,
        seq: event.seq,
        ts: event.ts,
        eventName: event.name,
        severity: event.severity,
        metadata: { kind: event.kind, name: event.name }
      };
    }
  }

  if (looksLikeApproval(event)) {
    return {
      id: `job:${eventKey}`,
      eventKey,
      type: "APPROVAL_WAIT",
      stationId: "gate",
      runId: event.run_id,
      seq: event.seq,
      ts: event.ts,
      eventName: event.name,
      severity: event.severity,
      metadata: { kind: event.kind, name: event.name }
    };
  }

  if (event.kind === "file") {
    const regionId = stableRegionId(event.attrs) ?? "region.unknown";
    const pathId = stablePathId(event.attrs) ?? `file:${eventKey}`;
    return {
      id: `job:${eventKey}`,
      eventKey,
      type: fileJobType(nameLower),
      stationId: fileJobType(nameLower) === "FILE_READ" ? "library" : "forge",
      runId: event.run_id,
      seq: event.seq,
      ts: event.ts,
      eventName: event.name,
      severity: event.severity,
      districtId: regionId,
      buildingId: pathId,
      metadata: { kind: event.kind, name: event.name }
    };
  }

  if (event.kind === "test") {
    const type = testJobType(nameLower);
    return {
      id: `job:${eventKey}`,
      eventKey,
      type,
      stationId: "terminal",
      runId: event.run_id,
      seq: event.seq,
      ts: event.ts,
      eventName: event.name,
      severity: event.severity,
      metadata: { kind: event.kind, name: event.name }
    };
  }

  if (event.kind === "tool") {
    return {
      id: `job:${eventKey}`,
      eventKey,
      type: "TOOL_RUN",
      stationId: "terminal",
      runId: event.run_id,
      seq: event.seq,
      ts: event.ts,
      eventName: event.name,
      severity: event.severity,
      metadata: { kind: event.kind, name: event.name }
    };
  }

  if (event.kind === "error") {
    return {
      id: `job:${eventKey}`,
      eventKey,
      type: "TEST_FAIL",
      stationId: "terminal",
      runId: event.run_id,
      seq: event.seq,
      ts: event.ts,
      eventName: event.name,
      severity: "error",
      metadata: { kind: event.kind, name: event.name }
    };
  }

  return null;
}

