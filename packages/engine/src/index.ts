import fs from "node:fs/promises";
import path from "node:path";

import type { TelemetryAttrs, TelemetryEventV1, TelemetryKind } from "@patchlings/protocol";
import { redactEvent, createSalt, hashWithSalt } from "@patchlings/redact";

export const WORLD_VERSION = 1 as const;

export type ChapterStatus = "completed" | "failed" | "interrupted";

export interface ChapterSummary {
  v: 1;
  run_id: string;
  chapter_id: string;
  turn_index: number;
  status: ChapterStatus;
  started_ts: string;
  completed_ts: string;
  duration_ms: number;
  seq_start: number;
  seq_end: number;
  files_touched: string[];
  tools_used: Record<string, number>;
  tests: {
    pass: number;
    fail: number;
  };
  errors: number;
  backpressure: {
    dropped_low_value: number;
    peak_events_per_sec: number;
    threshold: number;
    summaries_emitted: number;
  };
  title?: string;
}

export interface RunState {
  run_id: string;
  chapter_count: number;
  event_count: number;
  tool_count: number;
  file_touch_count: number;
  test_pass: number;
  test_fail: number;
  error_count: number;
  dropped_low_value_events: number;
  duplicate_events: number;
  peak_events_per_sec: number;
  last_upstream_seq: number;
  internal_seq: number;
  last_ts: string;
  recording_index: number;
  recording_bytes: number;
}

export interface RegionState {
  id: string;
  file_count: number;
  touch_count: number;
  last_ts: string;
}

export interface FileState {
  id: string;
  region_id: string;
  touch_count: number;
  last_ts: string;
  last_event_name: string;
}

export interface PatchlingState {
  id: string;
  tool_name: string;
  call_count: number;
  last_ts: string;
}

export interface WorldCounters {
  events: number;
  chapters: number;
  dropped_low_value_events: number;
  duplicate_events: number;
  backpressure_summaries: number;
}

export interface WorldState {
  v: 1;
  workspace_id: string;
  created_at: string;
  updated_at: string;
  counters: WorldCounters;
  runs: Record<string, RunState>;
  regions: Record<string, RegionState>;
  files: Record<string, FileState>;
  patchlings: Record<string, PatchlingState>;
}

export interface EngineOptions {
  workspaceRoot?: string;
  patchlingsDir?: string;
  eventsPerSecondThreshold?: number;
  recordTelemetry?: boolean;
  storageMode?: "fs" | "memory";
  maxChaptersInMemory?: number;
  maxRecordingBytes?: number;
  fixedSalts?: {
    workspaceSalt?: string;
    runSalts?: Record<string, string>;
  };
}

export interface EngineIngestResult {
  acceptedEvents: TelemetryEventV1[];
  closedChapters: ChapterSummary[];
  droppedLowValueEvents: number;
  droppedDuplicateEvents: number;
  world: WorldState;
}

interface SaltRecord {
  salt: string;
  created_at: string;
}

interface SaltsFile {
  workspace_salt: string;
  runs: Record<string, SaltRecord>;
}

interface ChapterState {
  run_id: string;
  chapter_id: string;
  turn_index: number;
  started_ts: string;
  started_seq: number;
  last_ts: string;
  last_seq: number;
  title?: string;
  files_touched: Set<string>;
  tools_used: Map<string, number>;
  test_pass: number;
  test_fail: number;
  errors: number;
  backpressure_dropped: number;
  backpressure_summaries: number;
  peak_events_per_sec: number;
  event_count: number;
}

interface BackpressureState {
  second: number | null;
  count: number;
}

interface AggregateBucket {
  run_id: string;
  second: number;
  kind: TelemetryKind;
  name: string;
  count: number;
  last_ts: string;
}

const DEFAULT_PATCHLINGS_DIR = ".patchlings";
const DEFAULT_THRESHOLD = 120;
const DEFAULT_MAX_CHAPTERS = 500;
const DEFAULT_MAX_RECORDING_BYTES = 2_000_000;
const INTERNAL_SEQ_OFFSET = 1_000_000_000;

function toIsoString(input: number | Date): string {
  const date = typeof input === "number" ? new Date(input) : input;
  return date.toISOString();
}

function parseTs(ts: string): number {
  const value = Date.parse(ts);
  return Number.isNaN(value) ? 0 : value;
}

function tsToSecond(ts: string): number {
  return Math.floor(parseTs(ts) / 1000);
}

function makeWorld(workspaceId: string): WorldState {
  const now = toIsoString(Date.now());
  return {
    v: WORLD_VERSION,
    workspace_id: workspaceId,
    created_at: now,
    updated_at: now,
    counters: {
      events: 0,
      chapters: 0,
      dropped_low_value_events: 0,
      duplicate_events: 0,
      backpressure_summaries: 0
    },
    runs: {},
    regions: {},
    files: {},
    patchlings: {}
  };
}

function normalizeRunState(run: RunState & { last_seq?: number }): RunState {
  const lastSeq = typeof run.last_seq === "number" ? run.last_seq : -1;
  const lastUpstream = typeof run.last_upstream_seq === "number" ? run.last_upstream_seq : lastSeq;
  const internalSeqCandidate = typeof run.internal_seq === "number" ? run.internal_seq : INTERNAL_SEQ_OFFSET;
  const internalSeq = internalSeqCandidate < INTERNAL_SEQ_OFFSET ? INTERNAL_SEQ_OFFSET : internalSeqCandidate;

  return {
    ...run,
    last_upstream_seq: lastUpstream,
    internal_seq: internalSeq,
    recording_index: typeof run.recording_index === "number" ? run.recording_index : 0,
    recording_bytes: typeof run.recording_bytes === "number" ? run.recording_bytes : 0
  };
}

function normalizeWorld(world: WorldState | undefined, workspaceId: string): WorldState {
  if (!world || world.v !== WORLD_VERSION) {
    return makeWorld(workspaceId);
  }

  return {
    ...world,
    workspace_id: workspaceId,
    counters: {
      events: world.counters?.events ?? 0,
      chapters: world.counters?.chapters ?? 0,
      dropped_low_value_events: world.counters?.dropped_low_value_events ?? 0,
      duplicate_events: world.counters?.duplicate_events ?? 0,
      backpressure_summaries: world.counters?.backpressure_summaries ?? 0
    },
    runs: Object.fromEntries(
      Object.entries(world.runs ?? {}).map(([runId, run]) => [runId, normalizeRunState(run)])
    ),
    regions: world.regions ?? {},
    files: world.files ?? {},
    patchlings: world.patchlings ?? {}
  };
}

function normalizeChapterSummary(summary: ChapterSummary): ChapterSummary {
  const backpressure = summary.backpressure ?? {
    dropped_low_value: 0,
    peak_events_per_sec: 0,
    threshold: DEFAULT_THRESHOLD,
    summaries_emitted: 0
  };

  return {
    ...summary,
    backpressure: {
      dropped_low_value: backpressure.dropped_low_value ?? 0,
      peak_events_per_sec: backpressure.peak_events_per_sec ?? 0,
      threshold: backpressure.threshold ?? DEFAULT_THRESHOLD,
      summaries_emitted: backpressure.summaries_emitted ?? 0
    }
  };
}

function getPathLikeHashes(attrs: TelemetryAttrs | undefined): { pathId?: string; regionId?: string } {
  if (!attrs) {
    return {};
  }

  const keys = Object.keys(attrs);
  const stablePathKey = keys.find(
    (key) => key.endsWith("_stable_hash") && !key.endsWith("_stable_dir_hash")
  );
  const stableDirKey = keys.find((key) => key.endsWith("_stable_dir_hash"));
  const pathKey = keys.find(
    (key) => key.endsWith("_hash") && !key.endsWith("_dir_hash") && key.includes("path")
  );
  const dirKey = keys.find((key) => key.endsWith("_dir_hash"));

  const pathId = stablePathKey ? String(attrs[stablePathKey]) : pathKey ? String(attrs[pathKey]) : undefined;
  const regionId = stableDirKey ? String(attrs[stableDirKey]) : dirKey ? String(attrs[dirKey]) : undefined;

  const result: { pathId?: string; regionId?: string } = {};
  if (pathId) {
    result.pathId = pathId;
  }
  if (regionId) {
    result.regionId = regionId;
  }
  return result;
}

function getToolName(event: TelemetryEventV1): string {
  const attrs = event.attrs;
  const candidate = attrs?.tool_name ?? attrs?.tool ?? attrs?.adapter_tool ?? event.name;
  return String(candidate);
}

function isTurnStart(event: TelemetryEventV1): boolean {
  return event.kind === "turn" && event.name === "turn.started";
}

function isTurnEnd(event: TelemetryEventV1): { ended: boolean; status?: ChapterStatus } {
  if (event.kind !== "turn") {
    return { ended: false };
  }
  if (event.name === "turn.completed") {
    return { ended: true, status: "completed" };
  }
  if (event.name === "turn.failed") {
    return { ended: true, status: "failed" };
  }
  return { ended: false };
}

function isLowValueEvent(event: TelemetryEventV1): boolean {
  if (event.kind === "log") {
    return true;
  }
  if (event.severity === "debug") {
    return true;
  }
  const name = event.name.toLowerCase();
  return name.includes("progress") || name.includes("delta") || name.includes("heartbeat");
}

function isInternalEvent(event: TelemetryEventV1): boolean {
  return event.internal === true || event.attrs?.patchlings_internal === true;
}

function upstreamSeq(event: TelemetryEventV1): number {
  return typeof event.upstream_seq === "number" ? event.upstream_seq : event.seq;
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text) as T;
  } catch (error) {
    return undefined;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2);
  await fs.writeFile(filePath, text, "utf8");
}

async function appendNdjson(filePath: string, value: unknown): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  await fs.appendFile(filePath, line, "utf8");
}

async function readNdjson<T>(filePath: string): Promise<T[]> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    return lines.map((line) => JSON.parse(line) as T);
  } catch (error) {
    return [];
  }
}

class SaltManager {
  private salts: SaltsFile;
  private saltsPath?: string;
  private storageMode: "fs" | "memory";

  private constructor(salts: SaltsFile, storageMode: "fs" | "memory", saltsPath?: string) {
    this.salts = salts;
    this.storageMode = storageMode;
    if (saltsPath) {
      this.saltsPath = saltsPath;
    }
  }

  static async create(options: {
    storageMode: "fs" | "memory";
    saltsPath?: string;
    fixedSalts?: EngineOptions["fixedSalts"];
  }): Promise<SaltManager> {
    const { storageMode, saltsPath, fixedSalts } = options;

    if (fixedSalts?.workspaceSalt) {
      const salts: SaltsFile = {
        workspace_salt: fixedSalts.workspaceSalt,
        runs: Object.fromEntries(
          Object.entries(fixedSalts.runSalts ?? {}).map(([runId, salt]) => [
            runId,
            { salt, created_at: toIsoString(Date.now()) }
          ])
        )
      };
      return new SaltManager(salts, "memory");
    }

    if (storageMode === "fs" && saltsPath) {
      const existing = await readJson<SaltsFile>(saltsPath);
      if (existing?.workspace_salt) {
        return new SaltManager(existing, storageMode, saltsPath);
      }
    }

    const salts: SaltsFile = {
      workspace_salt: createSalt(),
      runs: {}
    };

    const manager = new SaltManager(salts, storageMode, saltsPath);
    await manager.persist();
    return manager;
  }

  getWorkspaceSalt(): string {
    return this.salts.workspace_salt;
  }

  getWorkspaceId(workspaceRoot: string): string {
    return hashWithSalt(workspaceRoot, this.getWorkspaceSalt());
  }

  getRunSalt(runId: string): string {
    const existing = this.salts.runs[runId];
    if (existing) {
      return existing.salt;
    }

    const record: SaltRecord = {
      salt: createSalt(),
      created_at: toIsoString(Date.now())
    };
    this.salts.runs[runId] = record;
    return record.salt;
  }

  async persist(): Promise<void> {
    if (this.storageMode !== "fs" || !this.saltsPath) {
      return;
    }
    await writeJson(this.saltsPath, this.salts);
  }
}

export class PatchlingsEngine {
  private workspaceRoot: string;
  private patchlingsDir: string;
  private worldPath?: string;
  private chaptersPath?: string;
  private recordingsDir?: string;
  private storyDir?: string;
  private storageMode: "fs" | "memory";
  private salts: SaltManager;
  private world: WorldState;
  private chapters: ChapterSummary[];
  private openChapters: Map<string, ChapterState>;
  private backpressure: Map<string, BackpressureState>;
  private aggregates: Map<string, Map<string, AggregateBucket>>;
  private pendingWrites: Promise<void>[];
  private eventsPerSecondThreshold: number;
  private recordTelemetry: boolean;
  private maxChaptersInMemory: number;
  private maxRecordingBytes: number;

  private constructor(params: {
    workspaceRoot: string;
    patchlingsDir: string;
    worldPath?: string;
    chaptersPath?: string;
    recordingsDir?: string;
    storyDir?: string;
    storageMode: "fs" | "memory";
    salts: SaltManager;
    world: WorldState;
    chapters: ChapterSummary[];
    eventsPerSecondThreshold: number;
    recordTelemetry: boolean;
    maxChaptersInMemory: number;
    maxRecordingBytes: number;
  }) {
    this.workspaceRoot = params.workspaceRoot;
    this.patchlingsDir = params.patchlingsDir;
    if (params.worldPath) {
      this.worldPath = params.worldPath;
    }
    if (params.chaptersPath) {
      this.chaptersPath = params.chaptersPath;
    }
    if (params.recordingsDir) {
      this.recordingsDir = params.recordingsDir;
    }
    if (params.storyDir) {
      this.storyDir = params.storyDir;
    }
    this.storageMode = params.storageMode;
    this.salts = params.salts;
    this.world = params.world;
    this.chapters = params.chapters;
    this.openChapters = new Map();
    this.backpressure = new Map();
    this.aggregates = new Map();
    this.pendingWrites = [];
    this.eventsPerSecondThreshold = params.eventsPerSecondThreshold;
    this.recordTelemetry = params.recordTelemetry;
    this.maxChaptersInMemory = params.maxChaptersInMemory;
    this.maxRecordingBytes = params.maxRecordingBytes;
  }

  static async create(options: EngineOptions = {}): Promise<PatchlingsEngine> {
    const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
    const patchlingsDirName = options.patchlingsDir ?? DEFAULT_PATCHLINGS_DIR;
    const patchlingsDir = path.join(workspaceRoot, patchlingsDirName);
    const storageMode = options.storageMode ?? "fs";
    const eventsPerSecondThreshold = options.eventsPerSecondThreshold ?? DEFAULT_THRESHOLD;
    const recordTelemetry = options.recordTelemetry ?? false;
    const maxChaptersInMemory = options.maxChaptersInMemory ?? DEFAULT_MAX_CHAPTERS;
    const maxRecordingBytes = options.maxRecordingBytes ?? DEFAULT_MAX_RECORDING_BYTES;

    const worldPath = storageMode === "fs" ? path.join(patchlingsDir, "world.json") : undefined;
    const chaptersPath = storageMode === "fs" ? path.join(patchlingsDir, "chapters.ndjson") : undefined;
    const recordingsDir = storageMode === "fs" ? path.join(patchlingsDir, "recordings") : undefined;
    const storyDir = storageMode === "fs" ? path.join(patchlingsDir, "story") : undefined;
    const saltsPath = storageMode === "fs" ? path.join(patchlingsDir, "salts.json") : undefined;

    if (storageMode === "fs") {
      await ensureDir(patchlingsDir);
      if (recordingsDir) {
        await ensureDir(recordingsDir);
      }
      if (storyDir) {
        await ensureDir(storyDir);
      }
    }

    const saltsOptions = saltsPath
      ? { storageMode, saltsPath, fixedSalts: options.fixedSalts }
      : { storageMode, fixedSalts: options.fixedSalts };
    const salts = await SaltManager.create(saltsOptions);

    const workspaceId = salts.getWorkspaceId(workspaceRoot);

    const existingWorld = storageMode === "fs" && worldPath ? await readJson<WorldState>(worldPath) : undefined;
    const world = normalizeWorld(existingWorld, workspaceId);

    const chaptersRaw =
      storageMode === "fs" && chaptersPath ? await readNdjson<ChapterSummary>(chaptersPath) : [];
    const chapters = chaptersRaw.map(normalizeChapterSummary);
    const trimmedChapters = chapters.slice(-maxChaptersInMemory);

    const engineParams = {
      workspaceRoot,
      patchlingsDir,
      storageMode,
      salts,
      world,
      chapters: trimmedChapters,
      eventsPerSecondThreshold,
      recordTelemetry,
      maxChaptersInMemory,
      maxRecordingBytes,
      ...(worldPath ? { worldPath } : {}),
      ...(chaptersPath ? { chaptersPath } : {}),
      ...(recordingsDir ? { recordingsDir } : {}),
      ...(storyDir ? { storyDir } : {})
    };

    const engine = new PatchlingsEngine(engineParams);

    await engine.persistWorld();
    await engine.salts.persist();

    return engine;
  }

  getWorld(): WorldState {
    return this.world;
  }

  getChapters(limit?: number): ChapterSummary[] {
    if (!limit || limit <= 0) {
      return [...this.chapters];
    }
    return this.chapters.slice(-limit);
  }

  getChaptersByRun(runId: string, limit?: number): ChapterSummary[] {
    const chapters = this.chapters.filter((chapter) => chapter.run_id === runId);
    if (!limit || limit <= 0) {
      return chapters;
    }
    return chapters.slice(-limit);
  }

  getWorkspaceSalt(): string {
    return this.salts.getWorkspaceSalt();
  }

  getRunSalt(runId: string): string {
    return this.salts.getRunSalt(runId);
  }

  getPatchlingsDir(): string {
    return this.patchlingsDir;
  }

  getStoryDir(): string | undefined {
    return this.storyDir;
  }

  getStoryPath(runId: string): string | undefined {
    if (!this.storyDir) {
      return undefined;
    }
    return path.join(this.storyDir, `${runId}.md`);
  }

  getRecordingsDir(): string | undefined {
    return this.recordingsDir;
  }

  async ingestBatch(events: TelemetryEventV1[]): Promise<EngineIngestResult> {
    const acceptedEvents: TelemetryEventV1[] = [];
    const closedChapters: ChapterSummary[] = [];
    let droppedLowValueEvents = 0;
    let droppedDuplicateEvents = 0;

    for (const event of events) {
      const result = this.ingestOne(event);
      acceptedEvents.push(...result.acceptedEvents);
      closedChapters.push(...result.closedChapters);
      droppedLowValueEvents += result.droppedLowValueEvents;
      droppedDuplicateEvents += result.droppedDuplicateEvents;
    }

    await this.persistWorld();
    await this.salts.persist();
    await this.flushPendingWrites();

    return {
      acceptedEvents,
      closedChapters,
      droppedLowValueEvents,
      droppedDuplicateEvents,
      world: this.world
    };
  }

  async flushRunAggregates(runId: string): Promise<EngineIngestResult> {
    const now = toIsoString(Date.now());
    const runState = this.ensureRunState(runId, this.world.runs[runId]?.last_ts ?? now);
    const flushedEvents = this.flushAggregatesForRun(runId, Number.POSITIVE_INFINITY, runState);

    const acceptedEvents: TelemetryEventV1[] = [];
    const closedChapters: ChapterSummary[] = [];

    for (const event of flushedEvents) {
      const result = this.ingestInternalEvent(event, runState);
      acceptedEvents.push(...result.acceptedEvents);
      closedChapters.push(...result.closedChapters);
    }

    await this.persistWorld();
    await this.salts.persist();
    await this.flushPendingWrites();

    return {
      acceptedEvents,
      closedChapters,
      droppedLowValueEvents: 0,
      droppedDuplicateEvents: 0,
      world: this.world
    };
  }

  private ingestOne(event: TelemetryEventV1): {
    acceptedEvents: TelemetryEventV1[];
    closedChapters: ChapterSummary[];
    droppedLowValueEvents: number;
    droppedDuplicateEvents: number;
  } {
    if (isInternalEvent(event)) {
      const runState = this.ensureRunState(event.run_id, event.ts);
      return this.ingestInternalEvent(event, runState);
    }
    return this.ingestExternalEvent(event);
  }

  private ingestExternalEvent(event: TelemetryEventV1): {
    acceptedEvents: TelemetryEventV1[];
    closedChapters: ChapterSummary[];
    droppedLowValueEvents: number;
    droppedDuplicateEvents: number;
  } {
    const runSalt = this.salts.getRunSalt(event.run_id);
    const workspaceSalt = this.salts.getWorkspaceSalt();
    const safeEvent = redactEvent(event, runSalt, { stableSalt: workspaceSalt });
    const runState = this.ensureRunState(safeEvent.run_id, safeEvent.ts);

    const acceptedEvents: TelemetryEventV1[] = [];
    const closedChapters: ChapterSummary[] = [];
    let droppedLowValueEvents = 0;
    let droppedDuplicateEvents = 0;

    if (isTurnStart(safeEvent) || isTurnEnd(safeEvent).ended) {
      const boundaryFlush = this.flushAggregatesForRun(
        safeEvent.run_id,
        Number.POSITIVE_INFINITY,
        runState
      );
      for (const internalEvent of boundaryFlush) {
        const result = this.ingestInternalEvent(internalEvent, runState);
        acceptedEvents.push(...result.acceptedEvents);
        closedChapters.push(...result.closedChapters);
      }
    }

    const backpressureResult = this.applyBackpressure(safeEvent, runState);
    for (const internalEvent of backpressureResult.flushedEvents) {
      const result = this.ingestInternalEvent(internalEvent, runState);
      acceptedEvents.push(...result.acceptedEvents);
      closedChapters.push(...result.closedChapters);
    }

    if (backpressureResult.aggregated) {
      droppedLowValueEvents += 1;
      return { acceptedEvents, closedChapters, droppedLowValueEvents, droppedDuplicateEvents };
    }

    const upstream = upstreamSeq(safeEvent);
    if (upstream <= runState.last_upstream_seq) {
      runState.duplicate_events += 1;
      this.world.counters.duplicate_events += 1;
      droppedDuplicateEvents += 1;
      return { acceptedEvents, closedChapters, droppedLowValueEvents, droppedDuplicateEvents };
    }

    runState.last_upstream_seq = upstream;
    this.bumpInternalSeq(runState, safeEvent.seq);

    const acceptedResult = this.acceptEvent(safeEvent, runState);
    acceptedEvents.push(...acceptedResult.acceptedEvents);
    closedChapters.push(...acceptedResult.closedChapters);

    return { acceptedEvents, closedChapters, droppedLowValueEvents, droppedDuplicateEvents };
  }

  private ingestInternalEvent(
    event: TelemetryEventV1,
    runState: RunState
  ): {
    acceptedEvents: TelemetryEventV1[];
    closedChapters: ChapterSummary[];
    droppedLowValueEvents: number;
    droppedDuplicateEvents: number;
  } {
    this.bumpInternalSeq(runState, event.seq);
    const acceptedResult = this.acceptEvent(event, runState, { internal: true });
    return {
      acceptedEvents: acceptedResult.acceptedEvents,
      closedChapters: acceptedResult.closedChapters,
      droppedLowValueEvents: 0,
      droppedDuplicateEvents: 0
    };
  }

  private acceptEvent(
    event: TelemetryEventV1,
    runState: RunState,
    _options: { internal?: boolean } = {}
  ): { acceptedEvents: TelemetryEventV1[]; closedChapters: ChapterSummary[] } {
    runState.event_count += 1;
    runState.last_ts = event.ts;
    this.world.counters.events += 1;
    this.world.updated_at = event.ts;

    const closedChapter = this.reduceEvent(event);

    if (this.recordTelemetry) {
      this.pendingWrites.push(this.recordEvent(event, runState));
    }

    return {
      acceptedEvents: [event],
      closedChapters: closedChapter ? [closedChapter] : []
    };
  }

  private applyBackpressure(
    event: TelemetryEventV1,
    runState: RunState
  ): { aggregated: boolean; flushedEvents: TelemetryEventV1[] } {
    if (isInternalEvent(event)) {
      return { aggregated: false, flushedEvents: [] };
    }

    const runId = event.run_id;
    const second = tsToSecond(event.ts);
    const state = this.backpressure.get(runId) ?? { second: null, count: 0 };
    const flushedEvents: TelemetryEventV1[] = [];

    if (state.second !== null && state.second !== second) {
      flushedEvents.push(...this.flushAggregatesForRun(runId, second, runState));
      state.second = second;
      state.count = 0;
    }

    if (state.second === null) {
      state.second = second;
    }

    state.count += 1;
    this.backpressure.set(runId, state);

    runState.peak_events_per_sec = Math.max(runState.peak_events_per_sec, state.count);
    const chapter = this.openChapters.get(runId);
    if (chapter) {
      chapter.peak_events_per_sec = Math.max(chapter.peak_events_per_sec, state.count);
    }

    if (state.count <= this.eventsPerSecondThreshold) {
      return { aggregated: false, flushedEvents };
    }

    if (!isLowValueEvent(event)) {
      return { aggregated: false, flushedEvents };
    }

    this.aggregateLowValueEvent(event, runState, chapter);
    return { aggregated: true, flushedEvents };
  }

  private aggregateLowValueEvent(
    event: TelemetryEventV1,
    runState: RunState,
    chapter: ChapterState | undefined
  ): void {
    const runId = event.run_id;
    const second = tsToSecond(event.ts);
    const key = `${second}:${event.kind}:${event.name}`;

    const perRun = this.aggregates.get(runId) ?? new Map<string, AggregateBucket>();
    const bucket = perRun.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.last_ts = event.ts;
    } else {
      perRun.set(key, {
        run_id: runId,
        second,
        kind: event.kind,
        name: event.name,
        count: 1,
        last_ts: event.ts
      });
    }
    this.aggregates.set(runId, perRun);

    runState.dropped_low_value_events += 1;
    this.world.counters.dropped_low_value_events += 1;
    if (chapter) {
      chapter.backpressure_dropped += 1;
    }
  }

  private flushAggregatesForRun(runId: string, uptoSecond: number, runState: RunState): TelemetryEventV1[] {
    const perRun = this.aggregates.get(runId);
    if (!perRun || perRun.size === 0) {
      return [];
    }

    const buckets = [...perRun.values()]
      .filter((bucket) => bucket.second < uptoSecond)
      .sort((a, b) => {
        if (a.second !== b.second) return a.second - b.second;
        if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
        return a.name.localeCompare(b.name);
      });

    if (buckets.length === 0) {
      return [];
    }

    const runSalt = this.salts.getRunSalt(runId);
    const workspaceSalt = this.salts.getWorkspaceSalt();
    const events: TelemetryEventV1[] = [];

    for (const bucket of buckets) {
      perRun.delete(`${bucket.second}:${bucket.kind}:${bucket.name}`);
      const internalEvent = this.makeBackpressureSummaryEvent(bucket, runState, runSalt, workspaceSalt);
      events.push(internalEvent);

      const chapter = this.openChapters.get(runId);
      if (chapter) {
        chapter.backpressure_summaries += 1;
      }

      this.world.counters.backpressure_summaries += 1;
    }

    if (perRun.size === 0) {
      this.aggregates.delete(runId);
    } else {
      this.aggregates.set(runId, perRun);
    }

    return events;
  }

  private makeBackpressureSummaryEvent(
    bucket: AggregateBucket,
    runState: RunState,
    runSalt: string,
    workspaceSalt: string
  ): TelemetryEventV1 {
    const seq = this.nextInternalSeq(runState);
    const upstream = runState.last_upstream_seq;
    const candidate: TelemetryEventV1 = {
      v: 1,
      run_id: bucket.run_id,
      seq,
      ...(upstream >= 0 ? { upstream_seq: upstream } : {}),
      ts: bucket.last_ts,
      kind: "metric",
      name: "metric.backpressure.summary",
      severity: "info",
      internal: true,
      attrs: {
        patchlings_internal: true,
        second: bucket.second,
        source_kind: bucket.kind,
        source_name: bucket.name,
        count: bucket.count,
        threshold: this.eventsPerSecondThreshold
      }
    };

    return redactEvent(candidate, runSalt, { stableSalt: workspaceSalt });
  }

  private bumpInternalSeq(runState: RunState, seq: number): void {
    if (seq > runState.internal_seq) {
      runState.internal_seq = seq;
    }
  }

  private nextInternalSeq(runState: RunState): number {
    runState.internal_seq += 1;
    return runState.internal_seq;
  }

  private reduceEvent(event: TelemetryEventV1): ChapterSummary | undefined {
    const runState = this.ensureRunState(event.run_id, event.ts);
    const existingChapter = this.openChapters.get(event.run_id);

    if (isTurnStart(event)) {
      if (existingChapter) {
        const interrupted = this.closeChapter(event.run_id, event.ts, event.seq, "interrupted");
        this.openChapters.delete(event.run_id);
        if (interrupted) {
          return this.openNewChapter(event, runState, interrupted);
        }
      }
      return this.openNewChapter(event, runState);
    }

    const { ended, status } = isTurnEnd(event);
    if (ended && status) {
      const closed = this.closeChapter(event.run_id, event.ts, event.seq, status);
      this.openChapters.delete(event.run_id);
      return closed;
    }

    const chapter = this.ensureOpenChapter(event, runState);
    chapter.event_count += 1;
    chapter.last_ts = event.ts;
    chapter.last_seq = event.seq;

    this.reduceNonTurnEvent(event, runState, chapter);

    return undefined;
  }

  private openNewChapter(event: TelemetryEventV1, runState: RunState, closedChapter?: ChapterSummary): ChapterSummary | undefined {
    const turnIndex = runState.chapter_count + 1;
    runState.chapter_count = turnIndex;

    const chapterId = `${event.run_id}:${turnIndex}`;
    const title = this.deriveSafeTitle(event);
    const chapter: ChapterState = {
      run_id: event.run_id,
      chapter_id: chapterId,
      turn_index: turnIndex,
      started_ts: event.ts,
      started_seq: event.seq,
      last_ts: event.ts,
      last_seq: event.seq,
      files_touched: new Set(),
      tools_used: new Map(),
      test_pass: 0,
      test_fail: 0,
      errors: 0,
      backpressure_dropped: 0,
      backpressure_summaries: 0,
      peak_events_per_sec: 0,
      event_count: 1,
      ...(title ? { title } : {})
    };

    this.openChapters.set(event.run_id, chapter);

    // If we closed an interrupted chapter due to a new turn starting, we return it
    // immediately so the caller can stream it to the viewer.
    return closedChapter;
  }

  private ensureOpenChapter(event: TelemetryEventV1, runState: RunState): ChapterState {
    const existing = this.openChapters.get(event.run_id);
    if (existing) {
      return existing;
    }

    const turnIndex = runState.chapter_count + 1;
    runState.chapter_count = turnIndex;

    const chapterId = `${event.run_id}:${turnIndex}`;
    const chapter: ChapterState = {
      run_id: event.run_id,
      chapter_id: chapterId,
      turn_index: turnIndex,
      started_ts: event.ts,
      started_seq: event.seq,
      last_ts: event.ts,
      last_seq: event.seq,
      files_touched: new Set(),
      tools_used: new Map(),
      test_pass: 0,
      test_fail: 0,
      errors: 0,
      backpressure_dropped: 0,
      backpressure_summaries: 0,
      peak_events_per_sec: 0,
      event_count: 0
    };

    this.openChapters.set(event.run_id, chapter);
    return chapter;
  }

  private reduceNonTurnEvent(event: TelemetryEventV1, runState: RunState, chapter: ChapterState): void {
    if (event.kind === "tool") {
      runState.tool_count += 1;
      const toolName = getToolName(event);
      chapter.tools_used.set(toolName, (chapter.tools_used.get(toolName) ?? 0) + 1);
      this.bumpPatchling(toolName, event.ts);
    }

    if (event.kind === "file") {
      runState.file_touch_count += 1;
      this.bumpFile(event, chapter);
    }

    if (event.kind === "test") {
      const name = event.name.toLowerCase();
      if (name.includes("pass")) {
        runState.test_pass += 1;
        chapter.test_pass += 1;
      } else if (name.includes("fail")) {
        runState.test_fail += 1;
        chapter.test_fail += 1;
      }
    }

    let errorCounted = false;
    if (event.kind === "error") {
      runState.error_count += 1;
      chapter.errors += 1;
      errorCounted = true;
    }

    if (event.severity === "error" && !errorCounted) {
      runState.error_count += 1;
      chapter.errors += 1;
    }
  }

  private bumpPatchling(toolName: string, ts: string): void {
    const id = hashWithSalt(toolName, this.salts.getWorkspaceSalt());
    const existing = this.world.patchlings[id];
    if (existing) {
      existing.call_count += 1;
      existing.last_ts = ts;
      return;
    }
    this.world.patchlings[id] = {
      id,
      tool_name: toolName,
      call_count: 1,
      last_ts: ts
    };
  }

  private bumpFile(event: TelemetryEventV1, chapter: ChapterState): void {
    const { pathId, regionId } = getPathLikeHashes(event.attrs);
    if (!pathId) {
      return;
    }

    const region = regionId ?? "region.unknown";
    const regionState = this.ensureRegion(region, event.ts);

    const existing = this.world.files[pathId];
    if (existing) {
      existing.touch_count += 1;
      existing.last_ts = event.ts;
      existing.last_event_name = event.name;
    } else {
      this.world.files[pathId] = {
        id: pathId,
        region_id: region,
        touch_count: 1,
        last_ts: event.ts,
        last_event_name: event.name
      };
      regionState.file_count += 1;
    }

    regionState.touch_count += 1;
    regionState.last_ts = event.ts;
    chapter.files_touched.add(pathId);
  }

  private ensureRegion(regionId: string, ts: string): RegionState {
    const existing = this.world.regions[regionId];
    if (existing) {
      return existing;
    }
    const region: RegionState = {
      id: regionId,
      file_count: 0,
      touch_count: 0,
      last_ts: ts
    };
    this.world.regions[regionId] = region;
    return region;
  }

  private closeChapter(runId: string, completedTs: string, completedSeq: number, status: ChapterStatus): ChapterSummary | undefined {
    const chapter = this.openChapters.get(runId);
    if (!chapter) {
      return undefined;
    }

    const startedMs = parseTs(chapter.started_ts);
    const completedMs = parseTs(completedTs);
    const durationMs = Math.max(0, completedMs - startedMs);

    const toolsUsed = Object.fromEntries(
      [...chapter.tools_used.entries()].sort(([a], [b]) => a.localeCompare(b))
    );

    const filesTouched = [...chapter.files_touched.values()].sort();

    const summary: ChapterSummary = {
      v: 1,
      run_id: runId,
      chapter_id: chapter.chapter_id,
      turn_index: chapter.turn_index,
      status,
      started_ts: chapter.started_ts,
      completed_ts: completedTs,
      duration_ms: durationMs,
      seq_start: chapter.started_seq,
      seq_end: completedSeq,
      files_touched: filesTouched,
      tools_used: toolsUsed,
      tests: {
        pass: chapter.test_pass,
        fail: chapter.test_fail
      },
      errors: chapter.errors,
      backpressure: {
        dropped_low_value: chapter.backpressure_dropped,
        peak_events_per_sec: chapter.peak_events_per_sec,
        threshold: this.eventsPerSecondThreshold,
        summaries_emitted: chapter.backpressure_summaries
      },
      ...(chapter.title ? { title: chapter.title } : {})
    };

    this.chapters.push(summary);
    if (this.chapters.length > this.maxChaptersInMemory) {
      this.chapters = this.chapters.slice(-this.maxChaptersInMemory);
    }

    this.world.counters.chapters += 1;
    this.world.updated_at = completedTs;

    this.pendingWrites.push(this.appendChapter(summary));
    return summary;
  }

  private deriveSafeTitle(event: TelemetryEventV1): string | undefined {
    const attrs = event.attrs;
    if (!attrs) {
      return undefined;
    }
    const promptHash = attrs.prompt_hash ?? attrs.prompt_stable_hash ?? attrs.prompt_id;
    if (typeof promptHash === "string" && promptHash.length > 0) {
      return `Prompt ${promptHash}`;
    }
    const label = attrs.label ?? attrs.turn_label;
    if (typeof label === "string" && label.length > 0) {
      return label;
    }
    return undefined;
  }

  private ensureRunState(runId: string, ts: string): RunState {
    const existing = this.world.runs[runId];
    if (existing) {
      const legacyLastSeqValue = (existing as { last_seq?: number }).last_seq;
      const legacyLastSeq = typeof legacyLastSeqValue === "number" ? legacyLastSeqValue : -1;
      if (typeof existing.last_upstream_seq !== "number") {
        existing.last_upstream_seq = legacyLastSeq;
      }
      if (typeof existing.internal_seq !== "number") {
        const lastUpstream = typeof existing.last_upstream_seq === "number" ? existing.last_upstream_seq : -1;
        existing.internal_seq = Math.max(existing.event_count, lastUpstream, INTERNAL_SEQ_OFFSET);
      }
      if (typeof existing.recording_index !== "number") {
        existing.recording_index = 0;
      }
      if (typeof existing.recording_bytes !== "number") {
        existing.recording_bytes = 0;
      }
      existing.last_ts = ts;
      return existing;
    }
    const runState: RunState = {
      run_id: runId,
      chapter_count: 0,
      event_count: 0,
      tool_count: 0,
      file_touch_count: 0,
      test_pass: 0,
      test_fail: 0,
      error_count: 0,
      dropped_low_value_events: 0,
      duplicate_events: 0,
      peak_events_per_sec: 0,
      last_upstream_seq: -1,
      internal_seq: INTERNAL_SEQ_OFFSET,
      last_ts: ts,
      recording_index: 0,
      recording_bytes: 0
    };
    this.world.runs[runId] = runState;
    return runState;
  }

  private async persistWorld(): Promise<void> {
    if (this.storageMode !== "fs" || !this.worldPath) {
      return;
    }
    await writeJson(this.worldPath, this.world);
  }

  private async appendChapter(summary: ChapterSummary): Promise<void> {
    if (this.storageMode !== "fs" || !this.chaptersPath) {
      return;
    }
    await appendNdjson(this.chaptersPath, summary);
  }

  private recordingPath(runId: string, index: number): string | undefined {
    if (!this.recordingsDir) {
      return undefined;
    }
    const suffix = index <= 0 ? "" : `-${index}`;
    return path.join(this.recordingsDir, `${runId}${suffix}.jsonl`);
  }

  private async recordEvent(event: TelemetryEventV1, runState: RunState): Promise<void> {
    if (this.storageMode !== "fs") {
      return;
    }
    if (!this.recordingsDir) {
      return;
    }
    await ensureDir(this.recordingsDir);

    const line = `${JSON.stringify(event)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");

    if (runState.recording_bytes + lineBytes > this.maxRecordingBytes) {
      runState.recording_index += 1;
      runState.recording_bytes = 0;
    }

    const filePath = this.recordingPath(runState.run_id, runState.recording_index);
    if (!filePath) {
      return;
    }

    await fs.appendFile(filePath, line, "utf8");
    runState.recording_bytes += lineBytes;
  }

  private async flushPendingWrites(): Promise<void> {
    if (this.pendingWrites.length === 0) {
      return;
    }
    const writes = this.pendingWrites;
    this.pendingWrites = [];
    await Promise.allSettled(writes);
  }
}
