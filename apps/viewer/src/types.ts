import type { ChapterSummary, WorldState } from "@patchlings/engine";
import type { TelemetryEventV1 } from "@patchlings/protocol";

export type RunStatus = "idle" | "running" | "completed" | "failed";

export interface StreamStats {
  droppedLowValueEvents: number;
  droppedDuplicateEvents: number;
  droppedQueueEvents: number;
  queueSize: number;
}

export type StreamMessage =
  | {
      type: "snapshot";
      world: WorldState;
      chapters: ChapterSummary[];
      status: RunStatus;
      runId: string;
      viewerUrl: string;
      patchlingsDir: string;
      events?: TelemetryEventV1[];
    }
  | {
      type: "batch";
      world: WorldState;
      events: TelemetryEventV1[];
      closedChapters: ChapterSummary[];
      stats: StreamStats;
    }
  | {
      type: "status";
      status: RunStatus;
      runId: string;
      detail?: string;
    };

export interface ViewerState {
  connected: boolean;
  status: RunStatus;
  runId: string;
  viewerUrl: string;
  patchlingsDir: string;
  world: WorldState | null;
  chapters: ChapterSummary[];
  recentEvents: TelemetryEventV1[];
  lastStats: StreamStats | null;
  lastDetail: string | null;
}
