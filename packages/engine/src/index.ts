import fs from "node:fs/promises";
import path from "node:path";

import type { TelemetryAttrs, TelemetryEventV1 } from "@patchlings/protocol";
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
  last_seq: number;
  last_ts: string;
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
  peak_events_per_sec: number;
  event_count: number;
}

interface BackpressureState {
  second: number | null;
  count: number;
}

const DEFAULT_PATCHLINGS_DIR = ".patchlings";
const DEFAULT_THRESHOLD = 120;
const DEFAULT_MAX_CHAPTERS = 500;

function toIsoString(input: number | Date): string {
  const date = typeof input === "number" ? new Date(input) : input;
  return date.toISOString();
}

function parseTs(ts: string): number {
  const value = Date.parse(ts);
  return Number.isNaN(value) ? 0 : value;
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
      duplicate_events: 0
    },
    runs: {},
    regions: {},
    files: {},
    patchlings: {}
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

  return {
    pathId,
    regionId
  };
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
    this.saltsPath = saltsPath;
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
  private storageMode: "fs" | "memory";
  private salts: SaltManager;
  private world: WorldState;
  private chapters: ChapterSummary[];
  private openChapters: Map<string, ChapterState>;
  private backpressure: Map<string, BackpressureState>;
  private pendingWrites: Promise<void>[];
  private eventsPerSecondThreshold: number;
  private recordTelemetry: boolean;
  private maxChaptersInMemory: number;

  private constructor(params: {
    workspaceRoot: string;
    patchlingsDir: string;
    worldPath?: string;
    chaptersPath?: string;
    recordingsDir?: string;
    storageMode: "fs" | "memory";
    salts: SaltManager;
    world: WorldState;
    chapters: ChapterSummary[];
    eventsPerSecondThreshold: number;
    recordTelemetry: boolean;
    maxChaptersInMemory: number;
  }) {
    this.workspaceRoot = params.workspaceRoot;
    this.patchlingsDir = params.patchlingsDir;
    this.worldPath = params.worldPath;
    this.chaptersPath = params.chaptersPath;
    this.recordingsDir = params.recordingsDir;
    this.storageMode = params.storageMode;
    this.salts = params.salts;
    this.world = params.world;
    this.chapters = params.chapters;
    this.openChapters = new Map();
    this.backpressure = new Map();
    this.pendingWrites = [];
    this.eventsPerSecondThreshold = params.eventsPerSecondThreshold;
    this.recordTelemetry = params.recordTelemetry;
    this.maxChaptersInMemory = params.maxChaptersInMemory;
  }

  static async create(options: EngineOptions = {}): Promise<PatchlingsEngine> {
    const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
    const patchlingsDirName = options.patchlingsDir ?? DEFAULT_PATCHLINGS_DIR;
    const patchlingsDir = path.join(workspaceRoot, patchlingsDirName);
    const storageMode = options.storageMode ?? "fs";
    const eventsPerSecondThreshold = options.eventsPerSecondThreshold ?? DEFAULT_THRESHOLD;
    const recordTelemetry = options.recordTelemetry ?? false;
    const maxChaptersInMemory = options.maxChaptersInMemory ?? DEFAULT_MAX_CHAPTERS;

    const worldPath = storageMode === "fs" ? path.join(patchlingsDir, "world.json") : undefined;
    const chaptersPath = storageMode === "fs" ? path.join(patchlingsDir, "chapters.ndjson") : undefined;
    const recordingsDir = storageMode === "fs" ? path.join(patchlingsDir, "recordings") : undefined;
    const saltsPath = storageMode === "fs" ? path.join(patchlingsDir, "salts.json") : undefined;

    if (storageMode === "fs") {
      await ensureDir(patchlingsDir);
      if (recordTelemetry && recordingsDir) {
        await ensureDir(recordingsDir);
      }
    }

    const salts = await SaltManager.create({
      storageMode,
      saltsPath,
      fixedSalts: options.fixedSalts
    });

    const workspaceId = salts.getWorkspaceId(workspaceRoot);

    let world = storageMode === "fs" && worldPath ? await readJson<WorldState>(worldPath) : undefined;
    if (!world || world.v !== WORLD_VERSION) {
      world = makeWorld(workspaceId);
    } else if (world.workspace_id !== workspaceId) {
      world.workspace_id = workspaceId;
    }

    const chapters = storageMode === "fs" && chaptersPath ? await readNdjson<ChapterSummary>(chaptersPath) : [];
    const trimmedChapters = chapters.slice(-maxChaptersInMemory);

    const engine = new PatchlingsEngine({
      workspaceRoot,
      patchlingsDir,
      worldPath,
      chaptersPath,
      recordingsDir,
      storageMode,
      salts,
      world,
      chapters: trimmedChapters,
      eventsPerSecondThreshold,
      recordTelemetry,
      maxChaptersInMemory
    });

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

  getWorkspaceSalt(): string {
    return this.salts.getWorkspaceSalt();
  }

  getRunSalt(runId: string): string {
    return this.salts.getRunSalt(runId);
  }

  getPatchlingsDir(): string {
    return this.patchlingsDir;
  }

  async ingestBatch(events: TelemetryEventV1[]): Promise<EngineIngestResult> {
    const acceptedEvents: TelemetryEventV1[] = [];
    const closedChapters: ChapterSummary[] = [];
    let droppedLowValueEvents = 0;
    let droppedDuplicateEvents = 0;

    for (const event of events) {
      const result = this.ingestOne(event);
      droppedLowValueEvents += result.droppedLowValue ? 1 : 0;
      droppedDuplicateEvents += result.droppedDuplicate ? 1 : 0;
      if (result.acceptedEvent) {
        acceptedEvents.push(result.acceptedEvent);
      }
      if (result.closedChapter) {
        closedChapters.push(result.closedChapter);
      }
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

  private ingestOne(event: TelemetryEventV1): {
    acceptedEvent?: TelemetryEventV1;
    closedChapter?: ChapterSummary;
    droppedLowValue: boolean;
    droppedDuplicate: boolean;
  } {
    const runSalt = this.salts.getRunSalt(event.run_id);
    const workspaceSalt = this.salts.getWorkspaceSalt();

    const safeEvent = redactEvent(event, runSalt, { stableSalt: workspaceSalt });

    const runState = this.ensureRunState(safeEvent.run_id, safeEvent.ts);
    const chapter = this.openChapters.get(safeEvent.run_id);

    if (this.shouldDropForBackpressure(safeEvent, runState, chapter)) {
      return { droppedLowValue: true, droppedDuplicate: false };
    }

    if (safeEvent.seq <= runState.last_seq) {
      runState.duplicate_events += 1;
      this.world.counters.duplicate_events += 1;
      return { droppedLowValue: false, droppedDuplicate: true };
    }

    runState.last_seq = safeEvent.seq;
    runState.last_ts = safeEvent.ts;
    runState.event_count += 1;
    this.world.counters.events += 1;
    this.world.updated_at = safeEvent.ts;

    const closedChapter = this.reduceEvent(safeEvent);

    if (this.recordTelemetry) {
      this.pendingWrites.push(this.recordEvent(safeEvent));
    }

    return {
      acceptedEvent: safeEvent,
      closedChapter,
      droppedLowValue: false,
      droppedDuplicate: false
    };
  }

  private shouldDropForBackpressure(
    event: TelemetryEventV1,
    runState: RunState,
    chapter: ChapterState | undefined
  ): boolean {
    const ts = parseTs(event.ts);
    const second = Math.floor(ts / 1000);

    const state = this.backpressure.get(event.run_id) ?? { second: null, count: 0 };
    if (state.second !== second) {
      state.second = second;
      state.count = 0;
    }

    state.count += 1;
    this.backpressure.set(event.run_id, state);

    runState.peak_events_per_sec = Math.max(runState.peak_events_per_sec, state.count);
    if (chapter) {
      chapter.peak_events_per_sec = Math.max(chapter.peak_events_per_sec, state.count);
    }

    if (state.count <= this.eventsPerSecondThreshold) {
      return false;
    }

    if (!isLowValueEvent(event)) {
      return false;
    }

    runState.dropped_low_value_events += 1;
    this.world.counters.dropped_low_value_events += 1;
    if (chapter) {
      chapter.backpressure_dropped += 1;
    }
    return true;
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
    const chapter: ChapterState = {
      run_id: event.run_id,
      chapter_id: chapterId,
      turn_index: turnIndex,
      started_ts: event.ts,
      started_seq: event.seq,
      last_ts: event.ts,
      last_seq: event.seq,
      title: this.deriveSafeTitle(event),
      files_touched: new Set(),
      tools_used: new Map(),
      test_pass: 0,
      test_fail: 0,
      errors: 0,
      backpressure_dropped: 0,
      peak_events_per_sec: 0,
      event_count: 1
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
      title: undefined,
      files_touched: new Set(),
      tools_used: new Map(),
      test_pass: 0,
      test_fail: 0,
      errors: 0,
      backpressure_dropped: 0,
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
        threshold: this.eventsPerSecondThreshold
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
      last_seq: -1,
      last_ts: ts
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

  private async recordEvent(event: TelemetryEventV1): Promise<void> {
    if (this.storageMode !== "fs" || !this.recordingsDir) {
      return;
    }
    await ensureDir(this.recordingsDir);
    const filePath = path.join(this.recordingsDir, `${event.run_id}.ndjson`);
    await appendNdjson(filePath, event);
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
