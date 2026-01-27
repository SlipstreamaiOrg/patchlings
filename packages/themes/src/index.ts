import type { ChapterSummary, WorldState } from "@patchlings/engine";
import type { TelemetryEventV1 } from "@patchlings/protocol";

export interface ThemeContext {
  world: WorldState;
  events: TelemetryEventV1[];
  chapters: ChapterSummary[];
}

export interface ThemeRegion {
  id: string;
  fileCount: number;
  touchCount: number;
  lastTs: string;
}

export interface ThemeFileEntity {
  id: string;
  regionId: string;
  touchCount: number;
  lastTs: string;
  lastEventName: string;
}

export interface ThemePatchlingEntity {
  id: string;
  toolName: string;
  callCount: number;
  lastTs: string;
}

export interface ThemeRenderState {
  meta: {
    workspaceId: string;
    updatedAt: string;
    counters: WorldState["counters"];
    chapterCount: number;
  };
  regions: ThemeRegion[];
  files: ThemeFileEntity[];
  patchlings: ThemePatchlingEntity[];
  recentEvents: Array<{
    runId: string;
    ts: string;
    kind: string;
    name: string;
    internal?: boolean;
  }>;
}

export interface Theme {
  id: string;
  name: string;
  reduce(context: ThemeContext): ThemeRenderState;
}

const MAX_FILES = 1500;
const MAX_PATCHLINGS = 200;
const MAX_RECENT_EVENTS = 200;

function sortDescByNumber<T>(items: T[], value: (item: T) => number): T[] {
  return [...items].sort((a, b) => value(b) - value(a));
}

function mapRegions(world: WorldState): ThemeRegion[] {
  return Object.values(world.regions)
    .map((region) => ({
      id: region.id,
      fileCount: region.file_count,
      touchCount: region.touch_count,
      lastTs: region.last_ts
    }))
    .sort((a, b) => b.touchCount - a.touchCount);
}

function mapFiles(world: WorldState): ThemeFileEntity[] {
  const files = Object.values(world.files).map((file) => ({
    id: file.id,
    regionId: file.region_id,
    touchCount: file.touch_count,
    lastTs: file.last_ts,
    lastEventName: file.last_event_name
  }));

  return sortDescByNumber(files, (file) => file.touchCount).slice(0, MAX_FILES);
}

function mapPatchlings(world: WorldState): ThemePatchlingEntity[] {
  const patchlings = Object.values(world.patchlings).map((patchling) => ({
    id: patchling.id,
    toolName: patchling.tool_name,
    callCount: patchling.call_count,
    lastTs: patchling.last_ts
  }));

  return sortDescByNumber(patchlings, (patchling) => patchling.callCount).slice(0, MAX_PATCHLINGS);
}

function mapRecentEvents(events: TelemetryEventV1[]): ThemeRenderState["recentEvents"] {
  return events.slice(-MAX_RECENT_EVENTS).map((event) => ({
    runId: event.run_id,
    ts: event.ts,
    kind: event.kind,
    name: event.name,
    ...(event.internal === true ? { internal: true } : {})
  }));
}

export function createUniverseTheme(): Theme {
  return {
    id: "patchlings-universe",
    name: "Patchlings: Universe",
    reduce(context: ThemeContext): ThemeRenderState {
      const { world, events, chapters } = context;

      return {
        meta: {
          workspaceId: world.workspace_id,
          updatedAt: world.updated_at,
          counters: world.counters,
          chapterCount: chapters.length
        },
        regions: mapRegions(world),
        files: mapFiles(world),
        patchlings: mapPatchlings(world),
        recentEvents: mapRecentEvents(events)
      };
    }
  };
}

export const universeTheme = createUniverseTheme();

export type ThemeRegistry = Record<string, Theme>;

export const defaultThemes: ThemeRegistry = {
  universe: universeTheme
};