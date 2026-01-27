import { useEffect, useMemo, useReducer, useRef } from "react";

import type { ChapterSummary } from "@patchlings/engine";
import type { TelemetryEventV1 } from "@patchlings/protocol";

import type { RunStatus, StreamMessage, StreamStats, ViewerState } from "./types";

const MAX_RECENT_EVENTS = 600;
const MAX_MESSAGES_PER_FRAME = 200;
const MAX_PENDING_MESSAGES = 1000;
const MAX_EVENTS_IN_COMPRESSION = 300;

const INITIAL_STATE: ViewerState = {
  connected: false,
  status: "idle",
  runId: "pending",
  viewerUrl: typeof window !== "undefined" ? window.location.origin : "",
  patchlingsDir: ".patchlings",
  world: null,
  chapters: [],
  recentEvents: [],
  lastStats: null,
  lastDetail: null
};

type ViewerAction =
  | { type: "connection"; connected: boolean; detail?: string | null }
  | { type: "messages"; messages: StreamMessage[] };

function updateStatusFromEvents(current: RunStatus, events: TelemetryEventV1[]): RunStatus {
  let status = current;
  for (const event of events) {
    if (event.name === "turn.started") {
      status = "running";
    } else if (event.name === "turn.completed") {
      status = "completed";
    } else if (event.name === "turn.failed") {
      status = "failed";
    }
  }
  return status;
}

function mergeChapters(prev: ChapterSummary[], incoming: ChapterSummary[]): ChapterSummary[] {
  const byId = new Map<string, ChapterSummary>();
  for (const chapter of prev) {
    byId.set(chapter.chapter_id, chapter);
  }
  for (const chapter of incoming) {
    byId.set(chapter.chapter_id, chapter);
  }
  return [...byId.values()].sort((a, b) => a.started_ts.localeCompare(b.started_ts));
}

function appendRecentEvents(prev: TelemetryEventV1[], events: TelemetryEventV1[]): TelemetryEventV1[] {
  if (events.length === 0) {
    return prev;
  }
  const next = [...prev, ...events];
  return next.length > MAX_RECENT_EVENTS ? next.slice(next.length - MAX_RECENT_EVENTS) : next;
}

function reduceMessage(state: ViewerState, message: StreamMessage): ViewerState {
  if (message.type === "snapshot") {
    return {
      ...state,
      connected: true,
      status: message.status,
      runId: message.runId,
      viewerUrl: message.viewerUrl,
      patchlingsDir: message.patchlingsDir,
      world: message.world,
      chapters: message.chapters,
      lastDetail: null
    };
  }

  if (message.type === "status") {
    return {
      ...state,
      status: message.status,
      runId: message.runId,
      lastDetail: message.detail ?? null
    };
  }

  const nextStatus = updateStatusFromEvents(state.status, message.events);
  return {
    ...state,
    connected: true,
    status: nextStatus,
    world: message.world,
    chapters: mergeChapters(state.chapters, message.closedChapters),
    recentEvents: appendRecentEvents(state.recentEvents, message.events),
    lastStats: message.stats,
    lastDetail: null
  };
}

function reduceMessages(state: ViewerState, messages: StreamMessage[]): ViewerState {
  let nextState = state;
  for (const message of messages) {
    nextState = reduceMessage(nextState, message);
  }
  return nextState;
}

function reducer(state: ViewerState, action: ViewerAction): ViewerState {
  if (action.type === "connection") {
    return {
      ...state,
      connected: action.connected,
      lastDetail: action.detail === undefined ? state.lastDetail : action.detail
    };
  }
  return reduceMessages(state, action.messages);
}

function streamUrlFromWindow(): string {
  const base = typeof window !== "undefined" ? window.location.href : "http://localhost";
  const url = new URL("/stream", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function compressPendingMessages(messages: StreamMessage[]): StreamMessage[] {
  const latestSnapshotIndex = [...messages].reverse().findIndex((message) => message.type === "snapshot");
  const startIndex = latestSnapshotIndex >= 0 ? messages.length - 1 - latestSnapshotIndex : 0;
  const relevant = messages.slice(startIndex);

  let snapshot: StreamMessage | undefined;
  let latestWorldMessage: StreamMessage | undefined;
  let latestStatus: StreamMessage | undefined;
  const closedChapters: ChapterSummary[] = [];
  const events: TelemetryEventV1[] = [];
  let latestStats: StreamStats | undefined;

  for (const message of relevant) {
    if (message.type === "snapshot") {
      snapshot = message;
      latestWorldMessage = message;
      continue;
    }
    if (message.type === "status") {
      latestStatus = message;
      continue;
    }
    latestWorldMessage = message;
    closedChapters.push(...message.closedChapters);
    events.push(...message.events);
    latestStats = message.stats;
  }

  const compressed: StreamMessage[] = [];

  if (snapshot) {
    compressed.push(snapshot);
  }

  if (latestWorldMessage && latestWorldMessage.type === "batch") {
    compressed.push({
      type: "batch",
      world: latestWorldMessage.world,
      events: events.slice(Math.max(0, events.length - MAX_EVENTS_IN_COMPRESSION)),
      closedChapters,
      stats: latestStats ?? latestWorldMessage.stats
    });
  }

  if (latestStatus) {
    compressed.push(latestStatus);
  }

  return compressed.length > 0 ? compressed : relevant.slice(-MAX_MESSAGES_PER_FRAME);
}

export function usePatchlingsStream(): ViewerState {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  const pendingRef = useRef<StreamMessage[]>([]);
  const processingRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<{ attempts: number; timer: ReturnType<typeof setTimeout> | null }>({
    attempts: 0,
    timer: null
  });

  const streamUrl = useMemo(streamUrlFromWindow, []);

  const scheduleProcess = () => {
    if (processingRef.current) {
      return;
    }
    processingRef.current = true;

    requestAnimationFrame(() => {
      processingRef.current = false;
      const pending = pendingRef.current;
      if (pending.length === 0) {
        return;
      }

      const chunk = pending.splice(0, MAX_MESSAGES_PER_FRAME);
      dispatch({ type: "messages", messages: chunk });

      if (pending.length > 0) {
        scheduleProcess();
      }
    });
  };

  const enqueue = (message: StreamMessage) => {
    pendingRef.current.push(message);
    if (pendingRef.current.length > MAX_PENDING_MESSAGES) {
      pendingRef.current = compressPendingMessages(pendingRef.current);
    }
    scheduleProcess();
  };

  useEffect(() => {
    let stopped = false;

    const connect = () => {
      if (stopped) {
        return;
      }

      if (reconnectRef.current.timer) {
        clearTimeout(reconnectRef.current.timer);
        reconnectRef.current.timer = null;
      }

      const ws = new WebSocket(streamUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectRef.current.attempts = 0;
        dispatch({ type: "connection", connected: true, detail: null });
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as StreamMessage;
          enqueue(message);
        } catch (error) {
          dispatch({ type: "connection", connected: true, detail: "Invalid stream message" });
        }
      };

      ws.onclose = () => {
        dispatch({ type: "connection", connected: false, detail: "Disconnected" });
        if (stopped) {
          return;
        }
        reconnectRef.current.attempts += 1;
        const delay = Math.min(5000, 250 * 2 ** reconnectRef.current.attempts);
        reconnectRef.current.timer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectRef.current.timer) {
        clearTimeout(reconnectRef.current.timer);
      }
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.close();
      }
    };
  }, [streamUrl]);

  return state;
}
