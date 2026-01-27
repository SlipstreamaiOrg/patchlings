import { useMemo, useState } from "react";

import { explainEvents } from "@patchlings/learnlings";
import { universeTheme, type ThemeRenderState } from "@patchlings/themes";

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

export function App(): JSX.Element {
  const state = usePatchlingsStream();
  const [learnlingsEnabled, setLearnlingsEnabled] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportDetail, setExportDetail] = useState<string | null>(null);

  const renderState: ThemeRenderState | null = useMemo(() => {
    if (!state.world) {
      return null;
    }
    return universeTheme.reduce({
      world: state.world,
      events: state.recentEvents,
      chapters: state.chapters
    });
  }, [state.world, state.recentEvents, state.chapters]);

  const timelineChapters = useMemo(() => sortChaptersForTimeline(state.chapters), [state.chapters]);
  const learnlingMessages = useMemo(
    () => explainEvents(state.recentEvents.slice(-120), { limit: 7 }),
    [state.recentEvents]
  );

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
          <UniverseCanvas renderState={renderState} connected={state.connected} status={state.status} runId={state.runId} />

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
            {renderState ? (
              <ul className="kv-list">
                <li>
                  <span>Workspace</span>
                  <strong>{renderState.meta.workspaceId}</strong>
                </li>
                <li>
                  <span>Chapters</span>
                  <strong>{renderState.meta.chapterCount}</strong>
                </li>
                <li>
                  <span>Events</span>
                  <strong>{renderState.meta.counters.events}</strong>
                </li>
                <li>
                  <span>Patchlings</span>
                  <strong>{Object.keys(state.world?.patchlings ?? {}).length}</strong>
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
