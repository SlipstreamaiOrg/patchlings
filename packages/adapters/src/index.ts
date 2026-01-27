import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import type { TelemetryAttrs, TelemetryEventV1, TelemetryKind, TelemetrySeverity } from "@patchlings/protocol";
import { validateTelemetryEventV1 } from "@patchlings/protocol";
import { hashWithSalt, redactEvent } from "@patchlings/redact";

export interface AdapterContext {
  runId: string;
  workspaceSalt: string;
  runSalt: string;
  allowContent?: boolean;
  getRunSalt?: (runId: string) => string;
}

export interface AdapterHandle {
  stream: AsyncIterable<TelemetryEventV1>;
  stop: () => Promise<void>;
}

export interface CodexAdapterOptions {
  prompt: string;
  context: AdapterContext;
  codexCommand?: string;
  cwd?: string;
}

export interface StdinAdapterOptions {
  context: AdapterContext;
}

export interface FileTailAdapterOptions {
  filePath: string;
  context: AdapterContext;
  fromStart?: boolean;
  pollIntervalMs?: number;
}

export interface DemoAdapterOptions {
  context: AdapterContext;
  ratePerSecond?: number;
  totalTurns?: number;
  burstEveryTurns?: number;
  burstSize?: number;
  failureRate?: number;
}

const SAFE_ATTR_KEYS = new Set([
  "tool",
  "tool_name",
  "adapter_tool",
  "path",
  "file",
  "file_path",
  "target_path",
  "source_path",
  "cwd",
  "status",
  "exit_code",
  "duration_ms",
  "attempts",
  "bytes",
  "lines",
  "count",
  "changed_files",
  "added",
  "removed",
  "branch",
  "commit",
  "test_name",
  "suite",
  "result",
  "error_code",
  "severity",
  "level"
]);

type Primitive = string | number | boolean | null;

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;
  private failure: Error | undefined;

  push(value: T): void {
    if (this.ended) {
      return;
    }
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    for (const resolver of this.resolvers.splice(0)) {
      resolver({ value: undefined as T, done: true });
    }
  }

  fail(error: Error): void {
    this.failure = error;
    this.close();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.values.length > 0) {
          const value = this.values.shift() as T;
          return { value, done: false };
        }

        if (this.failure) {
          throw this.failure;
        }

        if (this.ended) {
          return { value: undefined as T, done: true };
        }

        return await new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
      }
    };
  }
}

class SeqSynthesizer {
  private lastSeqByRun = new Map<string, number>();

  next(runId: string, provided?: unknown): number {
    const last = this.lastSeqByRun.get(runId) ?? -1;
    const numericProvided = typeof provided === "number" && Number.isInteger(provided) ? provided : undefined;

    if (numericProvided !== undefined && numericProvided > last) {
      this.lastSeqByRun.set(runId, numericProvided);
      return numericProvided;
    }

    const nextSeq = last + 1;
    this.lastSeqByRun.set(runId, nextSeq);
    return nextSeq;
  }
}

function resolveRunSalt(context: AdapterContext, runId: string): string {
  const salt = context.getRunSalt ? context.getRunSalt(runId) : context.runSalt;
  if (!salt) {
    throw new Error(`Missing run salt for run_id=${runId}`);
  }
  return salt;
}

function deriveKind(name: string, providedKind?: unknown): TelemetryKind {
  const kind = typeof providedKind === "string" ? providedKind : undefined;
  if (kind && isTelemetryKind(kind)) {
    return kind;
  }

  if (name.startsWith("turn.")) {
    return "turn";
  }
  if (name.startsWith("tool.")) {
    return "tool";
  }
  if (name.startsWith("file.")) {
    return "file";
  }
  if (name.startsWith("git.")) {
    return "git";
  }
  if (name.startsWith("test.")) {
    return "test";
  }
  if (name.startsWith("spawn.")) {
    return "spawn";
  }
  if (name.startsWith("error.")) {
    return "error";
  }
  if (name.startsWith("metric.")) {
    return "metric";
  }
  return "log";
}

function isTelemetryKind(value: string): value is TelemetryKind {
  return (
    value === "turn" ||
    value === "tool" ||
    value === "file" ||
    value === "git" ||
    value === "test" ||
    value === "spawn" ||
    value === "log" ||
    value === "error" ||
    value === "metric"
  );
}

function deriveSeverity(input: Record<string, unknown>): TelemetrySeverity | undefined {
  const candidate = input.severity ?? input.level;
  if (candidate === "debug" || candidate === "info" || candidate === "warn" || candidate === "error") {
    return candidate;
  }
  return undefined;
}

function pickPrimitive(value: unknown): Primitive | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function sanitizeAttrs(input: Record<string, unknown>, runSalt: string): TelemetryAttrs | undefined {
  const attrs: TelemetryAttrs = {};

  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_ATTR_KEYS.has(key)) {
      continue;
    }
    const primitive = pickPrimitive(value);
    if (primitive !== undefined) {
      attrs[key] = primitive;
    }
  }

  if (typeof input.tool === "string" && !attrs.tool_name) {
    attrs.tool_name = input.tool;
  }

  if (typeof input.message === "string" && input.message.length > 0) {
    attrs.message_hash = hashWithSalt(input.message, runSalt);
  }

  attrs.adapter = "patchlings";

  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

function coerceTs(input: Record<string, unknown>): string {
  const candidate = input.ts ?? input.timestamp ?? input.time;
  if (typeof candidate === "string" && !Number.isNaN(Date.parse(candidate))) {
    return candidate;
  }
  if (typeof candidate === "number") {
    return new Date(candidate).toISOString();
  }
  return new Date().toISOString();
}

function coerceName(input: Record<string, unknown>): string {
  const candidate = input.name ?? input.type ?? input.event;
  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }
  return "log.unknown";
}

function normalizeInputEvent(
  raw: Record<string, unknown>,
  context: AdapterContext,
  seqSynth: SeqSynthesizer
): TelemetryEventV1 | undefined {
  const runId = typeof raw.run_id === "string" && raw.run_id.length > 0 ? raw.run_id : context.runId;
  const runSalt = resolveRunSalt(context, runId);
  const name = coerceName(raw);
  const kind = deriveKind(name, raw.kind);
  const seq = seqSynth.next(runId, raw.seq);
  const ts = coerceTs(raw);
  const severity = deriveSeverity(raw);
  const attrs = sanitizeAttrs(raw, runSalt);

  const candidate: TelemetryEventV1 = {
    v: 1,
    run_id: runId,
    seq,
    ts,
    kind,
    name,
    ...(severity ? { severity } : {}),
    ...(attrs ? { attrs } : {})
  };

  const redacted = redactEvent(candidate, runSalt, {
    allowContent: context.allowContent,
    stableSalt: context.workspaceSalt
  });

  const validation = validateTelemetryEventV1(redacted);
  if (!validation.ok || !validation.value) {
    return makeAdapterErrorEvent(context, seqSynth, {
      name: "error.invalid_event",
      attrs: {
        reason: validation.errors.join("; ")
      }
    });
  }

  return validation.value;
}

function makeAdapterErrorEvent(
  context: AdapterContext,
  seqSynth: SeqSynthesizer,
  options: { name: string; attrs?: TelemetryAttrs }
): TelemetryEventV1 {
  const runSalt = resolveRunSalt(context, context.runId);
  const seq = seqSynth.next(context.runId);
  const candidate: TelemetryEventV1 = {
    v: 1,
    run_id: context.runId,
    seq,
    ts: new Date().toISOString(),
    kind: "error",
    name: options.name,
    severity: "error",
    ...(options.attrs ? { attrs: options.attrs } : {})
  };
  return redactEvent(candidate, runSalt, {
    allowContent: context.allowContent,
    stableSalt: context.workspaceSalt
  });
}

function makeUnparsedLineEvent(
  context: AdapterContext,
  seqSynth: SeqSynthesizer,
  line: string
): TelemetryEventV1 {
  const runSalt = resolveRunSalt(context, context.runId);
  const seq = seqSynth.next(context.runId);
  const attrs: TelemetryAttrs = {
    line_hash: hashWithSalt(line, runSalt)
  };
  const candidate: TelemetryEventV1 = {
    v: 1,
    run_id: context.runId,
    seq,
    ts: new Date().toISOString(),
    kind: "log",
    name: "log.unparsed_line",
    severity: "warn",
    attrs
  };
  return redactEvent(candidate, runSalt, {
    allowContent: context.allowContent,
    stableSalt: context.workspaceSalt
  });
}

async function readLinesFromProcess(
  onLine: (line: string) => void,
  options: { command: string; args: string[]; cwd?: string }
): Promise<{ child: ReturnType<typeof spawn>; stop: () => Promise<void> }> {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdoutBuffer = "";

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        onLine(line);
      }
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", () => {
    // We intentionally ignore stderr content by default to avoid leaking data.
  });

  const stop = async () => {
    if (!child.killed) {
      child.kill();
    }
  };

  return { child, stop };
}

export async function codexJsonlAdapter(options: CodexAdapterOptions): Promise<AdapterHandle> {
  const { prompt, context } = options;
  const queue = new AsyncQueue<TelemetryEventV1>();
  const seqSynth = new SeqSynthesizer();
  const runSalt = resolveRunSalt(context, context.runId);

  const command = options.codexCommand ?? "codex";
  const args = ["exec", "--json", prompt];

  const processHandle = await readLinesFromProcess(
    (line) => {
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        const event = normalizeInputEvent(raw, context, seqSynth);
        if (event) {
          queue.push(event);
        }
      } catch (error) {
        queue.push(makeUnparsedLineEvent(context, seqSynth, line));
      }
    },
    { command, args, cwd: options.cwd }
  );

  processHandle.child.on("exit", () => {
    queue.close();
  });

  processHandle.child.on("error", (error: Error) => {
    queue.push(
      makeAdapterErrorEvent(context, seqSynth, {
        name: "error.adapter.codex",
        attrs: {
          error_hash: hashWithSalt(error.message ?? "codex_error", runSalt)
        }
      })
    );
    queue.close();
  });

  const stop = async () => {
    await processHandle.stop();
    queue.close();
  };

  return { stream: queue, stop };
}

async function readStdinAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function stdinJsonlAdapter(options: StdinAdapterOptions): Promise<AdapterHandle> {
  const queue = new AsyncQueue<TelemetryEventV1>();
  const seqSynth = new SeqSynthesizer();
  const text = await readStdinAll();

  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const line of lines) {
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const event = normalizeInputEvent(raw, options.context, seqSynth);
      if (event) {
        queue.push(event);
      }
    } catch (error) {
      queue.push(makeUnparsedLineEvent(options.context, seqSynth, line));
    }
  }

  queue.close();

  return {
    stream: queue,
    stop: async () => {
      queue.close();
    }
  };
}

async function statFile(filePath: string): Promise<{ size: number }> {
  try {
    const stats = await fs.stat(filePath);
    return { size: stats.size };
  } catch (error) {
    return { size: 0 };
  }
}

async function readFileSlice(filePath: string, start: number, end: number): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const length = Math.max(0, end - start);
    if (length === 0) {
      return "";
    }
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function fileTailAdapter(options: FileTailAdapterOptions): Promise<AdapterHandle> {
  const queue = new AsyncQueue<TelemetryEventV1>();
  const seqSynth = new SeqSynthesizer();
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const absolutePath = path.resolve(options.filePath);

  let position = 0;
  const initialStats = await statFile(absolutePath);
  position = options.fromStart ? 0 : initialStats.size;

  let remainder = "";
  const interval = setInterval(async () => {
    const stats = await statFile(absolutePath);
    if (stats.size <= position) {
      return;
    }

    const slice = await readFileSlice(absolutePath, position, stats.size);
    position = stats.size;

    const text = remainder + slice;
    const lines = text.split(/\r?\n/);
    remainder = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        const event = normalizeInputEvent(raw, options.context, seqSynth);
        if (event) {
          queue.push(event);
        }
      } catch (error) {
        queue.push(makeUnparsedLineEvent(options.context, seqSynth, line));
      }
    }
  }, pollIntervalMs);

  const stop = async () => {
    clearInterval(interval);
    queue.close();
  };

  return { stream: queue, stop };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function demoTs(base: number, offsetMs: number): string {
  return new Date(base + offsetMs).toISOString();
}

export async function demoAdapter(options: DemoAdapterOptions): Promise<AdapterHandle> {
  const queue = new AsyncQueue<TelemetryEventV1>();
  const seqSynth = new SeqSynthesizer();
  const ratePerSecond = options.ratePerSecond ?? 20;
  const totalTurns = options.totalTurns ?? 4;
  const burstEveryTurns = options.burstEveryTurns ?? 2;
  const burstSize = options.burstSize ?? 40;
  const failureRate = options.failureRate ?? 0.15;

  let stopped = false;
  const baseTs = Date.now();

  const emit = (raw: Record<string, unknown>) => {
    const event = normalizeInputEvent(raw, options.context, seqSynth);
    if (event) {
      queue.push(event);
    }
  };

  const run = async () => {
    const tickMs = Math.max(1, Math.floor(1000 / ratePerSecond));
    let offset = 0;

    for (let turn = 1; turn <= totalTurns && !stopped; turn += 1) {
      emit({
        ts: demoTs(baseTs, offset),
        kind: "turn",
        name: "turn.started",
        label: `Turn ${turn}`
      });
      offset += tickMs;

      const toolCalls = 3 + (turn % 3);
      for (let toolIndex = 0; toolIndex < toolCalls && !stopped; toolIndex += 1) {
        emit({
          ts: demoTs(baseTs, offset),
          kind: "tool",
          name: "tool.shell.start",
          tool_name: toolIndex % 2 === 0 ? "shell" : "apply_patch",
          duration_ms: 20 + toolIndex * 5
        });
        offset += tickMs;

        emit({
          ts: demoTs(baseTs, offset),
          kind: "file",
          name: "file.write",
          path: `src/module-${turn}-${toolIndex}.ts`,
          lines: 10 + toolIndex
        });
        offset += tickMs;
      }

      const burst = turn % burstEveryTurns === 0 ? burstSize : 0;
      for (let i = 0; i < burst && !stopped; i += 1) {
        emit({
          ts: demoTs(baseTs, offset),
          kind: "log",
          name: "log.progress",
          severity: "debug",
          message: `burst-${turn}-${i}`
        });
        offset += tickMs;
      }

      const testFailed = Math.random() < failureRate;
      emit({
        ts: demoTs(baseTs, offset),
        kind: "test",
        name: testFailed ? "test.fail" : "test.pass",
        result: testFailed ? "fail" : "pass",
        count: 12 + turn
      });
      offset += tickMs;

      emit({
        ts: demoTs(baseTs, offset),
        kind: "turn",
        name: testFailed ? "turn.failed" : "turn.completed"
      });
      offset += tickMs * 2;

      await sleep(Math.min(200, tickMs * 4));
    }

    queue.close();
  };

  void run();

  const stop = async () => {
    stopped = true;
    queue.close();
  };

  return { stream: queue, stop };
}
