export const TELEMETRY_VERSION = 1 as const;

export type TelemetryKind =
  | "turn"
  | "tool"
  | "file"
  | "git"
  | "test"
  | "spawn"
  | "log"
  | "error"
  | "metric";

export type TelemetrySeverity = "debug" | "info" | "warn" | "error";

export type TelemetryAttrValue = string | number | boolean | null;
export type TelemetryAttrs = Record<string, TelemetryAttrValue>;

export interface TelemetryEventV1 {
  v: 1;
  run_id: string;
  seq: number;
  ts: string;
  kind: TelemetryKind;
  name: string;
  severity?: TelemetrySeverity;
  attrs?: TelemetryAttrs;
  // Forward compatibility: additional fields are allowed and ignored by default.
  [key: string]: unknown;
}

export interface TelemetryValidationResult {
  ok: boolean;
  errors: string[];
  value?: TelemetryEventV1;
}

const VALID_KINDS: TelemetryKind[] = [
  "turn",
  "tool",
  "file",
  "git",
  "test",
  "spawn",
  "log",
  "error",
  "metric"
];

const VALID_SEVERITIES: TelemetrySeverity[] = ["debug", "info", "warn", "error"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDateTime(value: string): boolean {
  // We accept any string that parses to a valid date. This is intentionally
  // permissive to maintain forward compatibility across emitters.
  return !Number.isNaN(Date.parse(value));
}

function isValidAttrValue(value: unknown): value is TelemetryAttrValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  );
}

function validateAttrs(value: unknown, errors: string[]): TelemetryAttrs | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    errors.push("attrs must be an object when provided");
    return undefined;
  }

  const attrs: TelemetryAttrs = {};
  for (const [key, attrValue] of Object.entries(value)) {
    if (!isValidAttrValue(attrValue)) {
      errors.push(`attrs.${key} must be string|number|boolean|null`);
      continue;
    }
    attrs[key] = attrValue;
  }
  return attrs;
}

export function validateTelemetryEventV1(input: unknown): TelemetryValidationResult {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: ["event must be an object"] };
  }

  const v = input.v;
  if (v !== TELEMETRY_VERSION) {
    errors.push("v must be 1");
  }

  const runId = input.run_id;
  if (typeof runId !== "string" || runId.length === 0) {
    errors.push("run_id must be a non-empty string");
  }

  const seq = input.seq;
  if (!Number.isInteger(seq) || seq < 0) {
    errors.push("seq must be a non-negative integer");
  }

  const ts = input.ts;
  if (typeof ts !== "string" || !isIsoDateTime(ts)) {
    errors.push("ts must be an ISO date-time string");
  }

  const kind = input.kind;
  if (typeof kind !== "string" || !VALID_KINDS.includes(kind as TelemetryKind)) {
    errors.push("kind must be one of the TelemetryKind values");
  }

  const name = input.name;
  if (typeof name !== "string" || name.length === 0) {
    errors.push("name must be a non-empty string");
  }

  const severity = input.severity;
  if (
    severity !== undefined &&
    (typeof severity !== "string" || !VALID_SEVERITIES.includes(severity as TelemetrySeverity))
  ) {
    errors.push("severity must be debug|info|warn|error when provided");
  }

  const attrs = validateAttrs(input.attrs, errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const value: TelemetryEventV1 = {
    ...(input as Record<string, unknown>),
    v: TELEMETRY_VERSION,
    run_id: runId as string,
    seq: seq as number,
    ts: ts as string,
    kind: kind as TelemetryKind,
    name: name as string,
    ...(severity ? { severity: severity as TelemetrySeverity } : {}),
    ...(attrs ? { attrs } : {})
  };

  return { ok: true, errors: [], value };
}

export function assertTelemetryEventV1(input: unknown): TelemetryEventV1 {
  const result = validateTelemetryEventV1(input);
  if (!result.ok || !result.value) {
    const message = result.errors.join("; ") || "Unknown validation error";
    throw new Error(`Invalid TelemetryEventV1: ${message}`);
  }
  return result.value;
}