import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

import type { TelemetryEventV1 } from "@patchlings/protocol";
import type { ChapterSummary, WorldState } from "@patchlings/engine";
import { PatchlingsEngine } from "@patchlings/engine";
import { codexJsonlAdapter, demoAdapter, fileTailAdapter, stdinJsonlAdapter, type AdapterContext, type AdapterHandle } from "@patchlings/adapters";
import { WebSocketServer, type WebSocket } from "ws";

type RunnerCommand = "demo" | "run" | "replay" | "dev" | "stdin" | "help";
type RunStatus = "idle" | "running" | "completed" | "failed";

type StreamMessage =
  | {
      type: "snapshot";
      world: WorldState;
      chapters: ChapterSummary[];
      status: RunStatus;
      runId: string;
      viewerUrl: string;
      patchlingsDir: string;
    }
  | {
      type: "batch";
      world: WorldState;
      events: TelemetryEventV1[];
      closedChapters: ChapterSummary[];
      stats: {
        droppedLowValueEvents: number;
        droppedDuplicateEvents: number;
        droppedQueueEvents: number;
        queueSize: number;
      };
    }
  | {
      type: "status";
      status: RunStatus;
      runId: string;
      detail?: string;
    };

interface RunnerOptions {
  command: RunnerCommand;
  prompt?: string;
  replayPath?: string;
  port: number;
}

const DEFAULT_PORT = 4317;
const VIEWER_DEV_PORT = 5173;
const BATCH_INTERVAL_MS = 50;
const BATCH_SIZE = 250;
const MAX_QUEUE_SIZE = 5000;

function parseCommand(argv: string[]): RunnerOptions {
  const [, , rawCommand, ...rest] = argv;
  const command = (rawCommand ?? "demo") as RunnerCommand;
  const port = Number(process.env.PATCHLINGS_PORT ?? DEFAULT_PORT);

  if (command === "run") {
    const promptArgs = rest[0] === "--" ? rest.slice(1) : rest;
    const prompt = promptArgs.join(" ").trim();
    return { command, prompt, port };
  }

  if (command === "replay") {
    return { command, replayPath: rest[0], port };
  }

  return { command, port };
}

function makeRunId(prefix: string): string {
  const timePart = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${timePart}-${randomPart}`;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch (error) {
    return false;
  }
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, distDir: string): Promise<boolean> {
  const rawUrl = req.url ?? "/";
  const urlPath = rawUrl.split("?")[0] ?? "/";
  const relativePath = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
  const targetPath = path.resolve(distDir, relativePath);

  if (!targetPath.startsWith(distDir)) {
    res.writeHead(403).end("Forbidden");
    return true;
  }

  const hasTarget = await pathExists(targetPath);
  const hasIndex = await pathExists(path.join(distDir, "index.html"));
  const finalPath = hasTarget ? targetPath : hasIndex ? path.join(distDir, "index.html") : undefined;

  if (!finalPath) {
    return false;
  }

  try {
    const content = await fs.readFile(finalPath);
    res.writeHead(200, {
      "content-type": contentTypeFor(finalPath),
      "cache-control": "no-store"
    });
    res.end(content);
    return true;
  } catch (error) {
    res.writeHead(500).end("Failed to read viewer build.");
    return true;
  }
}

function serveFallback(res: http.ServerResponse, viewerUrl: string): void {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Patchlings Runner</title>
  </head>
  <body>
    <main style="font-family: system-ui, sans-serif; padding: 2rem; max-width: 48rem; margin: 0 auto;">
      <h1>Patchlings Runner Is Live</h1>
      <p>The viewer build was not found at <code>apps/viewer/dist</code>.</p>
      <p>Start the viewer dev server and open it directly:</p>
      <pre><code>pnpm --filter @patchlings/viewer dev
${viewerUrl}</code></pre>
      <p>The runner stream is available at <code>/stream</code> on this server.</p>
    </main>
  </body>
</html>`;

  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

function broadcast(clients: Set<WebSocket>, message: StreamMessage): void {
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState !== client.OPEN) {
      continue;
    }
    try {
      client.send(payload);
    } catch (error) {
      client.terminate();
    }
  }
}

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

function trimQueue(queue: TelemetryEventV1[]): number {
  if (queue.length <= MAX_QUEUE_SIZE) {
    return 0;
  }
  let dropped = 0;

  for (let i = queue.length - 1; i >= 0 && queue.length > MAX_QUEUE_SIZE; i -= 1) {
    if (!isLowValueEvent(queue[i])) {
      continue;
    }
    queue.splice(i, 1);
    dropped += 1;
  }

  if (queue.length > MAX_QUEUE_SIZE) {
    dropped += queue.length - MAX_QUEUE_SIZE;
    queue.splice(0, queue.length - MAX_QUEUE_SIZE);
  }

  return dropped;
}

function startViewerDevServer(): { child: ReturnType<typeof spawn>; url: string } {
  const url = `http://localhost:${VIEWER_DEV_PORT}`;
  const child = spawn(
    "pnpm",
    ["--filter", "@patchlings/viewer", "dev", "--", "--host", "--port", String(VIEWER_DEV_PORT)],
    {
      stdio: "ignore",
      shell: true
    }
  );

  return { child, url };
}

async function buildAdapterContext(engine: PatchlingsEngine, runId: string): Promise<AdapterContext> {
  const workspaceSalt = engine.getWorkspaceSalt();
  const runSalt = engine.getRunSalt(runId);
  const allowContent = process.env.PATCHLINGS_ALLOW_CONTENT === "true";
  return {
    runId,
    workspaceSalt,
    runSalt,
    allowContent
  };
}

async function selectAdapter(engine: PatchlingsEngine, options: RunnerOptions, runId: string): Promise<AdapterHandle> {
  const context = await buildAdapterContext(engine, runId);

  if (options.command === "demo" || options.command === "dev") {
    return demoAdapter({ context });
  }

  if (options.command === "stdin") {
    return stdinJsonlAdapter({ context });
  }

  if (options.command === "replay") {
    if (!options.replayPath) {
      throw new Error("Missing replay path. Usage: patchlings replay <path>");
    }
    return fileTailAdapter({ filePath: options.replayPath, context, fromStart: true });
  }

  if (options.command === "run") {
    const prompt = options.prompt?.trim();
    if (!prompt) {
      throw new Error("Missing prompt. Usage: patchlings run -- \"your prompt\"");
    }
    return codexJsonlAdapter({ prompt, context });
  }

  return demoAdapter({ context });
}

async function main(): Promise<void> {
  const options = parseCommand(process.argv);

  if (options.command === "help") {
    console.log("Patchlings commands: demo | dev | run -- \"prompt\" | replay <path> | stdin");
    return;
  }

  const workspaceRoot = process.cwd();
  const engine = await PatchlingsEngine.create({ workspaceRoot });

  const runId = makeRunId(options.command === "run" ? "codex" : options.command);
  let status: RunStatus = "idle";

  const viewerDist = path.join(workspaceRoot, "apps", "viewer", "dist");
  const hasViewerDist = await pathExists(viewerDist);

  let viewerDev: { child: ReturnType<typeof spawn>; url: string } | undefined;
  if (options.command === "dev") {
    viewerDev = startViewerDevServer();
  }

  const viewerUrl = hasViewerDist ? `http://localhost:${options.port}` : viewerDev?.url ?? `http://localhost:${VIEWER_DEV_PORT}`;

  const clients = new Set<WebSocket>();
  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url ?? "/").split("?")[0] ?? "/";

    if (urlPath === "/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, status, runId }));
      return;
    }

    if (urlPath === "/export/storytime") {
      res.writeHead(501, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "Story Time exporter not wired yet." }));
      return;
    }

    res.setHeader("access-control-allow-origin", "*");

    if (hasViewerDist) {
      const served = await serveStatic(req, res, viewerDist);
      if (served) {
        return;
      }
    }

    serveFallback(res, viewerUrl);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const urlPath = (req.url ?? "").split("?")[0] ?? "";
    if (urlPath !== "/stream") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    clients.add(ws);
    const snapshot: StreamMessage = {
      type: "snapshot",
      world: engine.getWorld(),
      chapters: engine.getChapters(),
      status,
      runId,
      viewerUrl,
      patchlingsDir: engine.getPatchlingsDir()
    };
    ws.send(JSON.stringify(snapshot));

    ws.on("close", () => {
      clients.delete(ws);
    });
  });

  const queue: TelemetryEventV1[] = [];
  let droppedQueueEvents = 0;
  let processing = false;
  let adapterDone = false;

  const processQueue = async (): Promise<void> => {
    if (processing) {
      return;
    }
    processing = true;
    try {
      while (queue.length > 0) {
        const batch = queue.splice(0, BATCH_SIZE);
        const result = await engine.ingestBatch(batch);
        status = updateStatusFromEvents(status, result.acceptedEvents);

        const message: StreamMessage = {
          type: "batch",
          world: result.world,
          events: result.acceptedEvents,
          closedChapters: result.closedChapters,
          stats: {
            droppedLowValueEvents: result.droppedLowValueEvents,
            droppedDuplicateEvents: result.droppedDuplicateEvents,
            droppedQueueEvents,
            queueSize: queue.length
          }
        };

        broadcast(clients, message);
        droppedQueueEvents = 0;
      }

      if (adapterDone && status === "running") {
        status = "completed";
        broadcast(clients, { type: "status", status, runId, detail: "Adapter stream ended." });
      }
    } finally {
      processing = false;
    }
  };

  const interval = setInterval(() => {
    void processQueue();
  }, BATCH_INTERVAL_MS);

  const adapter = await selectAdapter(engine, options, runId);

  const consume = async () => {
    try {
      for await (const event of adapter.stream) {
        queue.push(event);
        droppedQueueEvents += trimQueue(queue);
      }
      adapterDone = true;
      await processQueue();
    } catch (error) {
      status = "failed";
      broadcast(clients, {
        type: "status",
        status,
        runId,
        detail: error instanceof Error ? error.message : "Adapter failed"
      });
    }
  };

  void consume();

  server.listen(options.port, () => {
    const runnerUrl = `http://localhost:${options.port}`;
    console.log(`Patchlings runner listening at ${runnerUrl}`);
    if (hasViewerDist) {
      console.log(`Viewer served at ${runnerUrl}`);
    } else {
      console.log(`Viewer build not found. Start the viewer dev server and open ${viewerUrl}`);
    }
    console.log("Commands:");
    console.log("  pnpm demo");
    console.log('  pnpm run -- "Your prompt here"');
    console.log("  pnpm replay -- path/to/recording.ndjson");
  });

  const shutdown = async () => {
    clearInterval(interval);
    await adapter.stop();
    if (viewerDev?.child && !viewerDev.child.killed) {
      viewerDev.child.kill();
    }
    wss.close();
    server.close();
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

void main();