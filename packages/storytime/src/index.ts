import fs from "node:fs/promises";
import path from "node:path";

import type { ChapterSummary, WorldState } from "@patchlings/engine";

export interface StoryTimeOptions {
  runId: string;
  chapters: ChapterSummary[];
  world: WorldState;
  outputPath: string;
  generatedAt?: string;
}

export interface StoryTimeResult {
  runId: string;
  path: string;
  markdown: string;
  chapterCount: number;
  generatedAt: string;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0s";
  }
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function sortChapters(chapters: ChapterSummary[]): ChapterSummary[] {
  return [...chapters].sort((a, b) => {
    if (a.turn_index !== b.turn_index) {
      return a.turn_index - b.turn_index;
    }
    return a.started_ts.localeCompare(b.started_ts);
  });
}

function summarizeTools(tools: Record<string, number>): string {
  const entries = Object.entries(tools).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return "No tools recorded.";
  }
  const parts = entries.slice(0, 6).map(([name, count]) => `${name} ×${count}`);
  return parts.join(", ");
}

function summarizeFiles(filesTouched: string[]): { count: number; sample: string[] } {
  const unique = [...new Set(filesTouched)];
  const sample = unique.slice(0, 10);
  return { count: unique.length, sample };
}

function chapterHeading(chapter: ChapterSummary): string {
  const baseTitle = chapter.title && chapter.title.trim().length > 0 ? chapter.title : `Turn ${chapter.turn_index}`;
  return `## ${baseTitle} — ${chapter.status}`;
}

export function generateStoryMarkdown(options: StoryTimeOptions): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const chapters = sortChapters(options.chapters);
  const runState = options.world.runs[options.runId];

  const lines: string[] = [];
  lines.push("# Patchlings Story Time");
  lines.push("");
  lines.push(`- Run: \`${options.runId}\``);
  lines.push(`- Workspace: \`${options.world.workspace_id}\``);
  lines.push(`- Chapters: ${chapters.length}`);
  lines.push(`- Generated: ${generatedAt}`);

  if (runState) {
    lines.push(`- Events: ${runState.event_count}`);
    lines.push(`- Tools: ${runState.tool_count}`);
    lines.push(`- Files Touched: ${runState.file_touch_count}`);
    lines.push(`- Tests: ${runState.test_pass} passed, ${runState.test_fail} failed`);
  }

  lines.push("");
  lines.push("---");
  lines.push("");

  chapters.forEach((chapter, index) => {
    const files = summarizeFiles(chapter.files_touched);
    const toolsSummary = summarizeTools(chapter.tools_used);

    lines.push(chapterHeading(chapter));
    lines.push("");
    lines.push(`- Chapter Index: ${index + 1}`);
    lines.push(`- Duration: ${formatDuration(chapter.duration_ms)}`);
    lines.push(`- Started: ${chapter.started_ts}`);
    lines.push(`- Completed: ${chapter.completed_ts}`);
    lines.push(`- Files Touched: ${files.count}`);
    if (files.sample.length > 0) {
      const sampleList = files.sample.map((fileId) => `\`${fileId}\``).join(", ");
      lines.push(`- File IDs (sample): ${sampleList}`);
    }
    lines.push(`- Tools Used: ${toolsSummary}`);
    lines.push(`- Tests: ${chapter.tests.pass} passed, ${chapter.tests.fail} failed`);
    lines.push(`- Errors: ${chapter.errors}`);
    lines.push(
      `- Backpressure: dropped ${chapter.backpressure.dropped_low_value}, summaries ${chapter.backpressure.summaries_emitted}, peak ${chapter.backpressure.peak_events_per_sec}/s`
    );
    lines.push("");
    lines.push("### What Changed (High-Level)");
    lines.push("");
    lines.push("- Patchlings recorded the agent's progress using privacy-safe telemetry.");
    lines.push("- File updates and tool usage were summarized from metadata, not raw content.");
    lines.push("- Chapter boundaries were derived from turn.started → turn.completed/failed events.");
    lines.push("");
  });

  if (chapters.length === 0) {
    lines.push("## No Chapters Yet");
    lines.push("");
    lines.push("Patchlings did not find any completed turns for this run.");
    lines.push("");
  }

  return lines.join("\n");
}

export async function exportStoryTime(options: StoryTimeOptions): Promise<StoryTimeResult> {
  const markdown = generateStoryMarkdown(options);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const outputDir = path.dirname(options.outputPath);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(options.outputPath, markdown, "utf8");

  return {
    runId: options.runId,
    path: options.outputPath,
    markdown,
    chapterCount: options.chapters.length,
    generatedAt
  };
}

