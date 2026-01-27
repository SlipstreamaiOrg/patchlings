import { useCallback, useMemo, useRef, useState } from "react";

import { explainEvents } from "@patchlings/learnlings";

import { usePatchlingsStream } from "./usePatchlingsStream";
import type { ViewerState } from "./types";
import { UniverseCanvas } from "./UniverseCanvas";

function sortChaptersForTimeline(chapters: ViewerState["chapters"]): ViewerState["chapters"] {
  return [...chapters].sort((a, b) => b.started_ts.localeCompare(a.started_ts));
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0s";
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return ts;
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function computeEventsPerSecond(events: ViewerState["recentEvents"], windowMs = 5000): number {
  if (events.length === 0) {
    return 0;
  }
  const now = Date.now();
  const minTs = now - windowMs;
  let count = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) {
      continue;
    }
    const parsed = Date.parse(event.ts);
    if (!Number.isFinite(parsed)) {
      continue;
    }
    if (parsed < minTs) {
      break;
    }
    count += 1;
  }
  return count / (windowMs / 1000);
}

export function App(): JSX.Element {
  const state = usePatchlingsStream();
  const [learnlingsEnabled, setLearnlingsEnabled] = useState(true);
  const [followHotspotEnabled, setFollowHotspotEnabled] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportDetail, setExportDetail] = useState<string | null>(null);
  const [chapterNotice, setChapterNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  const assetBase = (import.meta.env.VITE_PATCHLINGS_ASSET_BASE as string | undefined) ?? "/patchlings-assets";

  const timelineChapters = useMemo(() => sortChaptersForTimeline(state.chapters), [state.chapters]);
  const lastTurnIndex = timelineChapters[0]?.turn_index ?? null;
  const learnlingMessages = useMemo(
    () => explainEvents(state.recentEvents.slice(-120), { limit: 7 }),
    [state.recentEvents]
  );
  const eventsPerSecond = useMemo(() => computeEventsPerSecond(state.recentEvents), [state.recentEvents]);

  const handleChapterSaved = useCallback((runId: string) => {
    if (noticeTimerRef.current) {
      window.clearTimeout(noticeTimerRef.current);
    }
    const label = lastTurnIndex ? `Turn ${lastTurnIndex}` : "Latest turn";
    setChapterNotice(`Chapter saved for ${label} (${runId}).`);
    noticeTimerRef.current = window.setTimeout(() => {
      setChapterNotice(null);
      noticeTimerRef.current = null;
    }, 2000);
  }, [lastTurnIndex]);

  const handleExportStory = async () => {
    if (exporting) {
      return;
    }
    setExporting(true);
    setExportDetail(null);
    try {
      const runId = state.runId && state.runId !== "pending" ? state.runId : "latest";
      const response = await fetch(`/export/storytime?runId=${encodeURIComponent(runId)}`);
      const payload = (await response.json()) as { ok: boolean; path?: string; error?: string };
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error ?? "Story export failed.");
      }
      setExportDetail(payload.path ? `Story saved: ${payload.path}` : "Story exported.");
    } catch (error) {
      setExportDetail(error instanceof Error ? error.message : "Story export failed.");
    } finally {
      setExporting(false);
    }
  };

  const workspaceId = state.world?.workspace_id ?? "unknown";
  const worldChapters = state.world?.counters.chapters ?? state.chapters.length;
  const worldEvents = state.world?.counters.events ?? state.recentEvents.length;
  const regionCount = Object.keys(state.world?.regions ?? {}).length;
  const fileCount = Object.keys(state.world?.files ?? {}).length;
  const enginePatchlings = Object.keys(state.world?.patchlings ?? {}).length;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__title">
          <h1>Patchlings</h1>
          <p>Give your coding agent a soul — watch it work, learn as it patches.</p>
        </div>

        <div className="topbar__controls">
          <div className={`status-pill status-pill--${state.status}`}>
            <span className={`status-dot ${state.connected ? "status-dot--connected" : "status-dot--disconnected"}`} />
            {state.connected ? state.status : "disconnected"}
          </div>

          <div className="metric-pill">{eventsPerSecond.toFixed(1)} ev/s</div>
          <div className="metric-pill">Turn {lastTurnIndex ?? "—"}</div>

          <label className="toggle">
            <input
              type="checkbox"
              checked={followHotspotEnabled}
              onChange={(event) => setFollowHotspotEnabled(event.currentTarget.checked)}
            />
            <span>Follow Hotspot</span>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={learnlingsEnabled}
              onChange={(event) => setLearnlingsEnabled(event.currentTarget.checked)}
            />
            <span>Learn-lings</span>
          </label>

          <button className="button" type="button" onClick={handleExportStory} disabled={exporting}>
            {exporting ? "Exporting…" : "Export Story Time"}
          </button>
        </div>
      </header>

      <main className="layout">
        <section className="canvas-panel">
          <UniverseCanvas
            world={state.world}
            events={state.recentEvents}
            chapters={state.chapters}
            connected={state.connected}
            status={state.status}
            runId={state.runId}
            followHotspot={followHotspotEnabled}
            assetBase={assetBase}
            onChapterSaved={handleChapterSaved}
          />

          {chapterNotice ? <div className="chapter-notice">{chapterNotice}</div> : null}

          {learnlingsEnabled ? (
            <aside className="learnlings-panel">
              <h2>Learn-lings</h2>
              {learnlingMessages.length === 0 ? (
                <p className="muted">Friendly explanations will appear here as events arrive.</p>
              ) : (
                <ul className="learnlings-list">
                  {[...learnlingMessages].reverse().map((message) => (
                    <li key={message.id}>
                      <span className="learnlings-list__name">{message.name}</span>
                      <p>{message.message}</p>
                    </li>
                  ))}
                </ul>
              )}
              {state.lastDetail ? <p className="learnlings-panel__detail">{state.lastDetail}</p> : null}
            </aside>
          ) : null}
        </section>

        <aside className="sidebar">
          <section className="panel">
            <h2>World</h2>
            {state.world ? (
              <ul className="kv-list">
                <li>
                  <span>Workspace</span>
                  <strong>{workspaceId}</strong>
                </li>
                <li>
                  <span>Chapters</span>
                  <strong>{worldChapters}</strong>
                </li>
                <li>
                  <span>Events</span>
                  <strong>{worldEvents}</strong>
                </li>
                <li>
                  <span>Regions</span>
                  <strong>{regionCount}</strong>
                </li>
                <li>
                  <span>Files</span>
                  <strong>{fileCount}</strong>
                </li>
                <li>
                  <span>Engine Patchlings</span>
                  <strong>{enginePatchlings}</strong>
                </li>
                <li>
                  <span>Assets</span>
                  <strong>{assetBase}</strong>
                </li>
              </ul>
            ) : (
              <p className="muted">Waiting for world state…</p>
            )}

            {exportDetail ? <p className="export-detail">{exportDetail}</p> : null}
          </section>

          <section className="panel">
            <h2>Chapters</h2>
            {timelineChapters.length === 0 ? (
              <p className="muted">No turns yet. Try demo mode.</p>
            ) : (
              <div className="chapter-list">
                {timelineChapters.map((chapter) => (
                  <article key={chapter.chapter_id} className={`chapter-card chapter-card--${chapter.status}`}>
                    <header className="chapter-card__header">
                      <strong>Turn {chapter.turn_index}</strong>
                      <span>{chapter.status}</span>
                    </header>
                    <p className="chapter-card__meta">
                      {formatTimestamp(chapter.started_ts)} • {formatDuration(chapter.duration_ms)}
                    </p>
                    <p className="chapter-card__meta">
                      Tools: {Object.keys(chapter.tools_used).length} • Files: {chapter.files_touched.length}
                    </p>
                  </article>
                ))}
              </div>
            )}
          </section>
        </aside>
      </main>
    </div>
  );
}
