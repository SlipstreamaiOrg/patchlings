import { AnimatedSprite, Application, Container, Graphics, Text, Texture } from "pixi.js";

import type { ChapterSummary, WorldState } from "@patchlings/engine";
import type { TelemetryEventV1 } from "@patchlings/protocol";

import { loadPatchlingSprites, type PatchlingAction, type PatchlingDir, type PatchlingSpriteSet } from "./assets";
import { mapEventToJobSeed, type JobSeed, type JobType, type StationId } from "./jobs";
import type { SpriteStatus } from "../types";

export type RunStatus = "idle" | "running" | "completed" | "failed";

export interface ColonySimulationOptions {
  assetBase: string;
  followHotspot: boolean;
  onChapterSaved?: (runId: string) => void;
  onSpriteStatus?: (status: SpriteStatus) => void;
}

interface Layers {
  worldRoot: Container;
  groundLayer: Container;
  pathLayer: Container;
  buildingsLayer: Container;
  propsLayer: Container;
  agentsLayer: Container;
  fxLayer: Container;
  uiWorldLayer: Container;
  hudLayer: Container;
}

interface Vec2 {
  x: number;
  y: number;
}

interface CameraState {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  scale: number;
  targetScale: number;
  dragging: boolean;
  dragStart: Vec2;
  dragCameraStart: Vec2;
  followSuppressedUntil: number;
}

interface Station {
  id: StationId;
  label: string;
  position: Vec2;
  radius: number;
  container: Container;
  pad: Graphics;
  glow: Graphics;
  queueSpots?: Vec2[];
}

interface District {
  id: string;
  index: number;
  center: Vec2;
  radius: number;
  ring: Graphics;
}

interface Building {
  id: string;
  districtId: string;
  position: Vec2;
  writes: number;
  stage: number;
  sprite: Graphics;
  lastTs: string;
}

interface Job {
  id: string;
  seed: JobSeed;
  type: JobType;
  stationId: StationId;
  districtId: string;
  buildingId: string | undefined;
  createdAt: number;
  assignedAgentId?: string;
  step: "to_station" | "to_target" | "interact" | "done";
  stepStartedAt: number;
}

interface Agent {
  id: string;
  role: "builder" | "learner" | "narrator";
  state: "idle" | "walk" | "carry" | "interact";
  dir: PatchlingDir;
  animState: PatchlingAction;
  animDir: PatchlingDir;
  animKey: string;
  pos: Vec2;
  targetPos: Vec2;
  nextWanderAt: number;
  speed: number;
  payload: "none" | "block";
  jobId: string | undefined;
  anchorStationId?: StationId;
  container: Container;
  sprite: AnimatedSprite;
  shadow: Graphics;
  bubble?: Text;
  block?: Graphics;
}

interface PulseFx {
  id: string;
  position: Vec2;
  color: number;
  ttlMs: number;
  startedAt: number;
  graphic: Graphics;
}

interface PuffFx {
  id: string;
  position: Vec2;
  color: number;
  ttlMs: number;
  startedAt: number;
  graphic: Graphics;
}

const WORLD_HALF_SIZE = 2400;
const MAX_DISTRICTS = 120;
const MAX_BUILDINGS = 600;
const DISTRICT_SPACING = 160;
const BUILDING_MIN_RADIUS = 40;
const BUILDING_MAX_RADIUS = 120;
const MAX_AGENTS = 40;
const BASE_AGENT_COUNT = 8;
const JOB_SPAWN_THRESHOLD = 10;
const MAX_PULSES = 120;
const MAX_PUFFS = 80;
const HOTSPOT_LINGER_MS = 10_000;

const MIN_ZOOM = 0.45;
const MAX_ZOOM = 1.9;

const INITIAL_CAMERA = {
  x: -200,
  y: -400,
  scale: 0.88
} as const;

const STATION_LAYOUT: Record<StationId, Vec2> = {
  board: { x: -820, y: -420 },
  library: { x: -1220, y: -40 },
  forge: { x: -420, y: 380 },
  terminal: { x: 420, y: -380 },
  gate: { x: 1180, y: -10 },
  archive: { x: 220, y: 520 }
};

const STATION_COLORS: Record<StationId, { pad: number; glow: number }> = {
  board: { pad: 0x4f7bff, glow: 0x7aa0ff },
  library: { pad: 0x54c8ff, glow: 0x8cdbff },
  forge: { pad: 0xffa24a, glow: 0xffc180 },
  terminal: { pad: 0x7dffb2, glow: 0xa6ffcf },
  gate: { pad: 0xffd35a, glow: 0xffe28c },
  archive: { pad: 0xd68cff, glow: 0xe8b3ff }
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function distance(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function rngFromSeed(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(1664525, state) + 1013904223;
    return (state >>> 0) / 4294967296;
  };
}

function goldenSpiral(index: number, spacing: number): Vec2 {
  const angle = index * 2.399963229728653;
  const radius = spacing * Math.sqrt(index + 1);
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius
  };
}

function stageFromWrites(writes: number): number {
  if (writes <= 0) {
    return 0;
  }
  if (writes <= 2) {
    return 1;
  }
  if (writes <= 5) {
    return 2;
  }
  if (writes <= 10) {
    return 3;
  }
  return 4;
}

function directionFromDelta(dx: number, dy: number): PatchlingDir {
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx >= 0 ? "E" : "W";
  }
  return dy >= 0 ? "S" : "N";
}

export class ColonySimulation {
  private host: HTMLDivElement;

  private app: Application;

  private layers: Layers;

  private sprites: PatchlingSpriteSet | null = null;

  private placeholderTexture: Texture | null = null;

  private followHotspot = true;

  private onChapterSaved?: (runId: string) => void;

  private onSpriteStatus?: (status: SpriteStatus) => void;

  private runStatus: RunStatus = "idle";

  private runId = "pending";

  private runConnected = false;

  private chapterCount = 0;

  private world: WorldState | null = null;

  private chapters: ChapterSummary[] = [];

  private knownChapterIds = new Set<string>();

  private chaptersInitialized = false;

  private camera: CameraState;

  private stations = new Map<StationId, Station>();

  private stationGlowUntil = new Map<StationId, number>();

  private districtById = new Map<string, District>();

  private buildingById = new Map<string, Building>();

  private districtOrder: string[] = [];

  private worldDirty = true;

  private lastTouchedDistrictId: string | null = null;

  private lastTouchedBuildingId: string | null = null;

  private jobs: Job[] = [];

  private jobsById = new Map<string, Job>();

  private jobCounter = 0;

  private agents = new Map<string, Agent>();

  private agentCounter = 0;

  private gateQueue: string[] = [];

  private gateAssignments = new Map<string, number>();

  private pulses: PulseFx[] = [];

  private puffs: PuffFx[] = [];

  private relics: Graphics[] = [];

  private relicCount = 0;

  private hotspot: { position: Vec2; expiresAt: number } | null = null;

  private seenEventKeys = new Map<string, number>();

  private seenEventOrder: string[] = [];

  private eventTimes: number[] = [];

  private eventsPerSecond = 0;

  private statusText: Text;

  private pathGraphic: Graphics;

  private hotspotGraphic: Graphics;

  constructor(host: HTMLDivElement, options: ColonySimulationOptions) {
    this.host = host;
    this.followHotspot = options.followHotspot;
    if (options.onChapterSaved) {
      this.onChapterSaved = options.onChapterSaved;
    }
    if (options.onSpriteStatus) {
      this.onSpriteStatus = options.onSpriteStatus;
    }

    this.camera = {
      x: INITIAL_CAMERA.x,
      y: INITIAL_CAMERA.y,
      targetX: INITIAL_CAMERA.x,
      targetY: INITIAL_CAMERA.y,
      scale: INITIAL_CAMERA.scale,
      targetScale: INITIAL_CAMERA.scale,
      dragging: false,
      dragStart: { x: 0, y: 0 },
      dragCameraStart: { x: 0, y: 0 },
      followSuppressedUntil: 0
    };

    this.app = new Application({
      antialias: true,
      backgroundAlpha: 0,
      resizeTo: host
    });

    const view = this.app.view as HTMLCanvasElement;
    view.style.width = "100%";
    view.style.height = "100%";
    view.style.display = "block";
    view.style.touchAction = "none";
    host.appendChild(view);

    this.layers = this.createLayers();
    this.pathGraphic = new Graphics();
    this.layers.pathLayer.addChild(this.pathGraphic);
    this.hotspotGraphic = new Graphics();
    this.layers.fxLayer.addChild(this.hotspotGraphic);
    this.statusText = this.createHudText();
    this.updateHudText();
    this.bindCameraControls(view);

    this.drawGround();
    this.createStations();
    this.spawnInitialAgents();

    this.app.ticker.add((delta) => {
      this.tick(delta);
    });

    void this.setAssetBase(options.assetBase);
  }

  destroy(): void {
    this.app.ticker.stop();
    this.app.destroy(true, true);
    const view = this.app.view as HTMLCanvasElement;
    if (this.host.contains(view)) {
      this.host.removeChild(view);
    }
  }

  setFollowHotspot(enabled: boolean): void {
    this.followHotspot = enabled;
  }

  setConnection(connected: boolean, status: RunStatus, runId: string): void {
    this.runConnected = connected;
    this.runStatus = connected ? status : "idle";
    this.runId = runId || this.runId;
    this.updateHudText();
  }

  async setAssetBase(assetBase: string): Promise<void> {
    this.sprites = await loadPatchlingSprites({ assetBase });
    this.refreshAgentSprites();
    if (this.sprites) {
      this.onSpriteStatus?.({
        mode: this.sprites.mode,
        assetBase: this.sprites.assetBase
      });
    }
  }

  ingestWorld(world: WorldState | null): void {
    this.world = world;
    this.chapterCount = world?.counters.chapters ?? this.chapterCount;
    this.worldDirty = true;
    this.updateHudText();
  }

  ingestChapters(chapters: ChapterSummary[]): void {
    this.chapters = chapters;
    if (!this.chaptersInitialized) {
      for (const chapter of chapters) {
        this.knownChapterIds.add(chapter.chapter_id);
      }
      this.chaptersInitialized = true;
    } else {
      for (const chapter of chapters) {
        if (!this.knownChapterIds.has(chapter.chapter_id)) {
          this.knownChapterIds.add(chapter.chapter_id);
          this.onChapterSaved?.(chapter.run_id);
        }
      }
    }
    this.chapterCount = Math.max(this.chapterCount, chapters.length);
    this.updateHudText();
  }

  ingestEvents(events: TelemetryEventV1[]): void {
    const now = Date.now();
    for (const event of events) {
      if (!this.rememberEvent(event)) {
        continue;
      }
      this.recordEventTime(now);
      const seed = mapEventToJobSeed(event);
      if (!seed) {
        continue;
      }
      const job = this.createJobFromSeed(seed, now);
      if (!this.districtById.has(job.districtId) || (job.buildingId && !this.buildingById.has(job.buildingId))) {
        this.worldDirty = true;
      }
      this.jobs.push(job);
      this.jobsById.set(job.id, job);

      if (job.buildingId) {
        this.lastTouchedBuildingId = job.buildingId;
      }
      this.lastTouchedDistrictId = job.districtId;
      this.markHotspotForJob(job);
    }

    this.jobs.sort((a, b) => a.seed.seq - b.seed.seq);
    if (this.jobs.length >= JOB_SPAWN_THRESHOLD && this.agents.size < MAX_AGENTS) {
      this.spawnAgent();
    }
  }

  private createLayers(): Layers {
    const worldRoot = new Container();
    const groundLayer = new Container();
    const pathLayer = new Container();
    const buildingsLayer = new Container();
    const propsLayer = new Container();
    const agentsLayer = new Container();
    const fxLayer = new Container();
    const uiWorldLayer = new Container();
    const hudLayer = new Container();

    worldRoot.addChild(groundLayer);
    worldRoot.addChild(pathLayer);
    worldRoot.addChild(buildingsLayer);
    worldRoot.addChild(propsLayer);
    worldRoot.addChild(agentsLayer);
    worldRoot.addChild(fxLayer);
    worldRoot.addChild(uiWorldLayer);

    this.app.stage.addChild(worldRoot);
    this.app.stage.addChild(hudLayer);

    return {
      worldRoot,
      groundLayer,
      pathLayer,
      buildingsLayer,
      propsLayer,
      agentsLayer,
      fxLayer,
      uiWorldLayer,
      hudLayer
    };
  }

  private createHudText(): Text {
    const label = new Text("", {
      fill: 0xe6edff,
      fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial",
      fontSize: 12
    });
    label.position.set(12, 10);
    this.layers.hudLayer.addChild(label);
    return label;
  }

  private updateHudText(): void {
    const status = this.runConnected ? this.runStatus : "disconnected";
    const runId = this.runId;
    const chapters = this.chapterCount;
    const eps = this.eventsPerSecond.toFixed(1);
    this.statusText.text = `Run: ${runId} • ${status} • chapters: ${chapters} • ${eps} ev/s`;
  }

  private tick(delta: number): void {
    this.updateEventsPerSecond();
    if (this.worldDirty) {
      this.rebuildWorld();
    }
    this.assignJobs();
    this.updateAgents(delta);
    this.updateEffects();
    this.updateHotspotGraphic();
    this.applyCamera(delta);
  }

  private drawGround(): void {
    if (this.layers.groundLayer.children.length > 0) {
      return;
    }
    const ground = new Graphics();
    ground.beginFill(0x0b1a10, 1);
    ground.drawRect(-WORLD_HALF_SIZE, -WORLD_HALF_SIZE, WORLD_HALF_SIZE * 2, WORLD_HALF_SIZE * 2);
    ground.endFill();
    this.layers.groundLayer.addChild(ground);
  }

  private bindCameraControls(view: HTMLCanvasElement): void {
    const onPointerDown = (event: PointerEvent) => {
      this.camera.dragging = true;
      this.camera.dragStart = { x: event.clientX, y: event.clientY };
      this.camera.dragCameraStart = { x: this.camera.targetX, y: this.camera.targetY };
      this.camera.followSuppressedUntil = Date.now() + 2000;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!this.camera.dragging) {
        return;
      }
      const dx = event.clientX - this.camera.dragStart.x;
      const dy = event.clientY - this.camera.dragStart.y;
      const scale = this.camera.targetScale;
      this.camera.targetX = this.camera.dragCameraStart.x - dx / scale;
      this.camera.targetY = this.camera.dragCameraStart.y - dy / scale;
    };

    const endDrag = () => {
      this.camera.dragging = false;
      this.camera.followSuppressedUntil = Date.now() + 1200;
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const zoomFactor = event.deltaY < 0 ? 1.1 : 0.92;
      const before = this.screenToWorld({ x: event.offsetX, y: event.offsetY });
      const nextScale = clamp(this.camera.targetScale * zoomFactor, MIN_ZOOM, MAX_ZOOM);
      this.camera.targetScale = nextScale;

      const { width, height } = this.getScreenSize();
      const nextX = before.x - (event.offsetX - width / 2) / nextScale;
      const nextY = before.y - (event.offsetY - height / 2) / nextScale;
      this.camera.targetX = nextX;
      this.camera.targetY = nextY;
      this.camera.followSuppressedUntil = Date.now() + 1600;
    };

    view.addEventListener("pointerdown", onPointerDown);
    view.addEventListener("pointermove", onPointerMove);
    view.addEventListener("pointerup", endDrag);
    view.addEventListener("pointerleave", endDrag);
    view.addEventListener("wheel", onWheel, { passive: false });
  }

  private getScreenSize(): { width: number; height: number } {
    return {
      width: this.app.screen.width,
      height: this.app.screen.height
    };
  }

  private screenToWorld(point: Vec2): Vec2 {
    const { width, height } = this.getScreenSize();
    return {
      x: this.camera.x + (point.x - width / 2) / this.camera.scale,
      y: this.camera.y + (point.y - height / 2) / this.camera.scale
    };
  }

  private applyCamera(delta: number): void {
    const now = Date.now();
    if (this.hotspot && this.hotspot.expiresAt <= now) {
      this.hotspot = null;
    }

    const followAllowed = this.followHotspot && now >= this.camera.followSuppressedUntil;
    if (followAllowed && this.hotspot) {
      const strength = 0.06;
      this.camera.targetX = lerp(this.camera.targetX, this.hotspot.position.x, strength);
      this.camera.targetY = lerp(this.camera.targetY, this.hotspot.position.y, strength);
    }

    const bound = WORLD_HALF_SIZE - 140;
    this.camera.targetX = clamp(this.camera.targetX, -bound, bound);
    this.camera.targetY = clamp(this.camera.targetY, -bound, bound);

    const dt = clamp(delta / 60, 0.5, 2);
    const ease = clamp(0.18 * dt, 0.05, 0.28);
    this.camera.x = clamp(lerp(this.camera.x, this.camera.targetX, ease), -bound, bound);
    this.camera.y = clamp(lerp(this.camera.y, this.camera.targetY, ease), -bound, bound);
    this.camera.scale = lerp(this.camera.scale, this.camera.targetScale, ease * 0.9);

    const { width, height } = this.getScreenSize();
    const scale = this.camera.scale;
    this.layers.worldRoot.scale.set(scale, scale);
    this.layers.worldRoot.position.set(width / 2 - this.camera.x * scale, height / 2 - this.camera.y * scale);
    this.layers.hudLayer.position.set(0, 0);
  }

  private createStations(): void {
    this.stations.clear();
    const labels: Record<StationId, string> = {
      board: "Board",
      library: "Library",
      forge: "Forge",
      terminal: "Terminal",
      gate: "Gate",
      archive: "Archive"
    };

    (Object.keys(STATION_LAYOUT) as StationId[]).forEach((stationId) => {
      const station = this.createStation(stationId, labels[stationId]);
      this.stations.set(stationId, station);
      this.layers.buildingsLayer.addChild(station.container);
    });
  }

  private createStation(id: StationId, label: string): Station {
    const position = STATION_LAYOUT[id];
    const colors = STATION_COLORS[id];
    const container = new Container();
    container.position.set(position.x, position.y);

    const glow = new Graphics();
    glow.beginFill(colors.glow, 0.12);
    glow.drawCircle(0, 0, 92);
    glow.endFill();
    container.addChild(glow);

    const pad = new Graphics();
    pad.beginFill(colors.pad, 0.42);
    pad.lineStyle(2, colors.glow, 0.75);
    pad.drawRoundedRect(-52, -44, 104, 88, 16);
    pad.endFill();
    container.addChild(pad);

    const ring = new Graphics();
    ring.lineStyle(2, colors.glow, 0.6);
    ring.drawCircle(0, 0, 58);
    container.addChild(ring);

    const title = new Text(label, {
      fill: 0xe6edff,
      fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial",
      fontSize: 12,
      fontWeight: "600"
    });
    title.anchor.set(0.5, 0);
    title.position.set(0, 54);
    container.addChild(title);

    const queueSpots =
      id === "gate"
        ? Array.from({ length: 6 }, (_, index) => ({
            x: position.x - 120 - index * 32,
            y: position.y + 94
          }))
        : undefined;

    const baseStation = {
      id,
      label,
      position,
      radius: 64,
      container,
      pad,
      glow
    };
    return queueSpots ? { ...baseStation, queueSpots } : baseStation;
  }

  private getPlaceholderTexture(): Texture {
    if (this.placeholderTexture) {
      return this.placeholderTexture;
    }
    const g = new Graphics();
    g.beginFill(0x7dffb2, 1);
    g.drawCircle(16, 16, 16);
    g.endFill();
    this.placeholderTexture = this.app.renderer.generateTexture(g);
    g.destroy();
    return this.placeholderTexture;
  }

  private createAgentSprite(): AnimatedSprite {
    const fallback = this.getPlaceholderTexture();
    const spriteSet = this.sprites;
    const usingSprites = spriteSet?.mode === "sprites";
    const idleSouth = usingSprites && spriteSet ? spriteSet.animations.idle.S : [fallback];
    const sprite = new AnimatedSprite(idleSouth);
    sprite.anchor.set(0.5, 1);
    sprite.position.set(0, 0);
    sprite.animationSpeed = 0.1;
    sprite.play();
    const scale = usingSprites ? 0.72 : 1.2;
    sprite.scale.set(scale, scale);
    sprite.tint = usingSprites ? 0xffffff : 0x7dffb2;
    return sprite;
  }

  private randomAround(center: Vec2, radius: number): Vec2 {
    const angle = Math.random() * Math.PI * 2;
    const r = radius * (0.25 + Math.random() * 0.75);
    return {
      x: center.x + Math.cos(angle) * r,
      y: center.y + Math.sin(angle) * r
    };
  }

  private scheduleAgentWander(agent: Agent, now: number): void {
    const minDelay = 900;
    const maxDelay = 2400;
    agent.nextWanderAt = now + minDelay + Math.random() * (maxDelay - minDelay);
  }

  private updateAgentDirection(agent: Agent): void {
    const dx = agent.targetPos.x - agent.pos.x;
    const dy = agent.targetPos.y - agent.pos.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      return;
    }
    agent.dir = directionFromDelta(dx, dy);
  }

  private animationForState(agent: Agent): PatchlingAction {
    if (agent.payload === "block" || agent.state === "carry") {
      return "carry";
    }
    if (agent.state === "walk") {
      return "walk";
    }
    return "idle";
  }

  private updateAgentAnimation(agent: Agent): void {
    this.updateAgentDirection(agent);
    const action = this.animationForState(agent);
    const dir = agent.dir;
    const spriteSet = this.sprites;
    const useSprites = spriteSet?.mode === "sprites";
    const modeKey = useSprites ? "sprites" : "placeholder";
    const animKey = `${modeKey}:${action}:${dir}:${agent.state}:${agent.payload}`;
    if (agent.animKey === animKey) {
      return;
    }
    const textures = useSprites && spriteSet ? spriteSet.animations[action][dir] : [this.getPlaceholderTexture()];
    agent.sprite.textures = textures;
    agent.sprite.animationSpeed = action === "idle" ? 0.08 : 0.16;
    if (!agent.sprite.playing) {
      agent.sprite.play();
    }
    if (useSprites) {
      agent.sprite.tint = 0xffffff;
    } else {
      let tint = 0x7dffb2;
      if (agent.payload === "block") {
        tint = 0xffc180;
      } else if (agent.state === "interact") {
        tint = 0xe8b3ff;
      } else if (agent.state === "walk") {
        tint = 0x7db4ff;
      }
      agent.sprite.tint = tint;
    }
    agent.animState = action;
    agent.animDir = dir;
    agent.animKey = animKey;
  }

  private setAgentState(agent: Agent, state: Agent["state"], payload: Agent["payload"]): void {
    agent.state = state;
    agent.payload = payload;
    if (agent.block) {
      agent.block.visible = payload === "block";
      agent.block.tint = payload === "block" ? 0xffc180 : 0xffffff;
    }
    this.updateAgentAnimation(agent);
  }

  private resetAgentDisplay(agent: Agent): void {
    const children = [agent.shadow, agent.sprite, agent.block, agent.bubble].filter(
      (child): child is NonNullable<typeof child> => Boolean(child)
    );
    agent.container.removeChildren();
    for (const child of children) {
      agent.container.addChild(child);
    }
    agent.container.position.set(agent.pos.x, agent.pos.y);
  }

  private refreshAgentSprites(): void {
    for (const agent of this.agents.values()) {
      if (agent.sprite.parent === agent.container) {
        agent.container.removeChild(agent.sprite);
      }
      if (!agent.sprite.destroyed) {
        agent.sprite.stop();
        agent.sprite.destroy({ children: true, texture: false, baseTexture: false });
      }
      agent.sprite = this.createAgentSprite();
      agent.animState = "walk";
      agent.animDir = agent.animDir === "S" ? "N" : "S";
      agent.animKey = "";
      this.resetAgentDisplay(agent);
      this.updateAgentAnimation(agent);
    }
  }

  private spawnInitialAgents(): void {
    for (let i = 0; i < BASE_AGENT_COUNT; i += 1) {
      this.spawnAgent();
    }
  }

  private spawnAgent(): Agent {
    const board = this.stations.get("board");
    const base = board?.position ?? { x: 0, y: 0 };
    const spawnPos = this.randomAround(base, 140);
    const agent = this.createAgent(spawnPos);
    this.agents.set(agent.id, agent);
    return agent;
  }

  private createAgent(spawnPos: Vec2): Agent {
    this.agentCounter += 1;
    const id = `patchling-${this.agentCounter}`;
    const board = this.stations.get("board");
    const base = board?.position ?? { x: 0, y: 0 };
    const container = new Container();
    container.position.set(spawnPos.x, spawnPos.y);

    const shadow = new Graphics();
    shadow.beginFill(0x05090f, 0.55);
    shadow.drawEllipse(0, 8, 18, 9);
    shadow.endFill();
    shadow.zIndex = 0;

    const sprite = this.createAgentSprite();
    sprite.zIndex = 2;

    const block = new Graphics();
    block.beginFill(0xffc180, 0.9);
    block.lineStyle(2, 0xffe6c8, 0.8);
    block.drawRoundedRect(-10, -12, 20, 20, 6);
    block.endFill();
    block.position.set(0, -46);
    block.visible = false;
    block.zIndex = 3;

    container.sortableChildren = true;
    container.addChild(shadow);
    container.addChild(sprite);
    container.addChild(block);

    this.layers.agentsLayer.addChild(container);

    const agent: Agent = {
      id,
      role: "builder",
      state: "idle",
      dir: "S",
      animState: "walk",
      animDir: "N",
      animKey: "",
      pos: { ...spawnPos },
      targetPos: this.randomAround(base, 180),
      nextWanderAt: Date.now() + 1200 + Math.random() * 1200,
      speed: 96,
      payload: "none",
      jobId: undefined,
      anchorStationId: "board",
      container,
      sprite,
      shadow,
      block
    };

    this.resetAgentDisplay(agent);
    this.updateAgentAnimation(agent);
    return agent;
  }

  private districtRadius(regionId: string): number {
    const region = this.world?.regions[regionId];
    if (!region) {
      return 92;
    }
    const fileFactor = Math.sqrt(region.file_count + 1) * 6.5;
    const touchFactor = Math.log10(region.touch_count + 10) * 18;
    return clamp(78 + fileFactor + touchFactor, 82, 168);
  }

  private ensureDistrict(regionId: string, index: number): District {
    const existing = this.districtById.get(regionId);
    const radius = this.districtRadius(regionId);
    if (existing) {
      existing.radius = radius;
      existing.index = index;
      existing.ring.position.set(existing.center.x, existing.center.y);
      this.drawDistrict(existing);
      return existing;
    }

    const ring = new Graphics();
    const center = this.positionDistrict(regionId, index);
    ring.position.set(center.x, center.y);
    this.layers.buildingsLayer.addChild(ring);

    const district: District = {
      id: regionId,
      index,
      center,
      radius,
      ring
    };
    this.drawDistrict(district);
    this.districtById.set(regionId, district);
    return district;
  }

  private positionDistrict(regionId: string, index: number): Vec2 {
    const seedIndex = hashString(regionId) % 20;
    const seedPos = goldenSpiral(seedIndex, DISTRICT_SPACING);
    const offset = goldenSpiral(index, DISTRICT_SPACING * 0.25);
    const bound = WORLD_HALF_SIZE - 180;
    const centerX = INITIAL_CAMERA.x;
    const centerY = INITIAL_CAMERA.y;
    const rawX = centerX + seedPos.x * 0.9 + offset.x * 0.25;
    const rawY = centerY + seedPos.y * 0.9 + offset.y * 0.25;
    return {
      x: clamp(rawX, -bound, bound),
      y: clamp(rawY, -bound, bound)
    };
  }

  private drawDistrict(district: District): void {
    const { ring, radius, id } = district;
    const seed = hashString(id);
    const tint = 0x1a2d52 + (seed % 0x003333);
    ring.clear();
    ring.beginFill(tint, 0.58);
    ring.lineStyle(2, 0x6ba3ff, 0.7);
    ring.drawCircle(0, 0, radius);
    ring.endFill();

    ring.lineStyle(1, 0x9bc8ff, 0.4);
    ring.drawCircle(0, 0, radius * 0.68);
  }

  private ensureDistrictForId(districtId: string): District {
    const existing = this.districtById.get(districtId);
    if (existing) {
      return existing;
    }
    const knownIndex = this.districtOrder.indexOf(districtId);
    const index = knownIndex >= 0 ? knownIndex : this.districtById.size;
    return this.ensureDistrict(districtId, index);
  }

  private ensureBuilding(buildingId: string, districtId: string, baseWrites: number, ts: string): Building {
    const existing = this.buildingById.get(buildingId);
    const writes = Math.max(baseWrites, existing?.writes ?? 0);
    if (existing) {
      existing.writes = writes;
      existing.stage = stageFromWrites(writes);
      existing.lastTs = ts;
      this.drawBuilding(existing);
      return existing;
    }

    const district = this.ensureDistrictForId(districtId);
    const position = this.positionBuilding(buildingId, district);
    const sprite = new Graphics();
    sprite.position.set(position.x, position.y);
    this.layers.buildingsLayer.addChild(sprite);

    const building: Building = {
      id: buildingId,
      districtId,
      position,
      writes,
      stage: stageFromWrites(writes),
      sprite,
      lastTs: ts
    };
    this.drawBuilding(building);
    this.buildingById.set(buildingId, building);
    return building;
  }

  private positionBuilding(buildingId: string, district: District): Vec2 {
    const seed = hashString(buildingId);
    const rnd = rngFromSeed(seed);
    const angle = rnd() * Math.PI * 2;
    const radius = BUILDING_MIN_RADIUS + rnd() * (BUILDING_MAX_RADIUS - BUILDING_MIN_RADIUS);
    return {
      x: district.center.x + Math.cos(angle) * radius,
      y: district.center.y + Math.sin(angle) * radius
    };
  }

  private drawBuilding(building: Building): void {
    const { sprite, stage, id } = building;
    const seed = hashString(id);
    const tint = 0x2d4f7d + (seed % 0x002222);
    const width = 26 + stage * 8;
    const height = 18 + stage * 11;

    sprite.clear();
    sprite.beginFill(0x0e1628, 0.5);
    sprite.drawEllipse(0, 6, width * 0.55, 10);
    sprite.endFill();

    sprite.beginFill(tint, 0.92);
    sprite.lineStyle(2, 0x9bc8ff, 0.6);
    sprite.drawRoundedRect(-width / 2, -height, width, height, 8);
    sprite.endFill();

    if (stage >= 3) {
      sprite.beginFill(0xcfe6ff, 0.7);
      sprite.drawRoundedRect(-width * 0.15, -height * 0.85, width * 0.3, height * 0.24, 5);
      sprite.endFill();
    }

    if (stage >= 4) {
      sprite.lineStyle(2, 0x6ba3ff, 0.8);
      sprite.moveTo(0, -height - 10);
      sprite.lineTo(0, -height - 34);
      sprite.beginFill(0x9bc8ff, 0.9);
      sprite.drawCircle(0, -height - 38, 5);
      sprite.endFill();
    }
  }

  private bumpBuildingWrites(buildingId: string, districtId: string, ts: string): void {
    const building = this.ensureBuilding(buildingId, districtId, 0, ts);
    building.writes += 1;
    building.stage = stageFromWrites(building.writes);
    building.lastTs = ts;
    this.drawBuilding(building);
  }

  private rebuildWorld(): void {
    const regionIds = new Set<string>();
    if (this.world) {
      for (const regionId of Object.keys(this.world.regions)) {
        regionIds.add(regionId);
      }
    }
    for (const job of this.jobs) {
      regionIds.add(job.districtId);
    }
    for (const building of this.buildingById.values()) {
      regionIds.add(building.districtId);
    }

    const ordered = [...regionIds].sort();
    const limited = ordered.slice(0, MAX_DISTRICTS);
    this.districtOrder = limited;

    limited.forEach((regionId, index) => {
      this.ensureDistrict(regionId, index);
    });

    let buildingCount = 0;
    const worldFiles = this.world ? Object.values(this.world.files) : [];
    worldFiles.sort((a, b) => a.id.localeCompare(b.id));
    for (const file of worldFiles) {
      if (buildingCount >= MAX_BUILDINGS) {
        break;
      }
      const districtId = file.region_id ?? "region.unknown";
      if (!this.districtById.has(districtId)) {
        this.ensureDistrictForId(districtId);
      }
      this.ensureBuilding(file.id, districtId, file.touch_count, file.last_ts);
      buildingCount += 1;
    }

    for (const job of this.jobs) {
      if (buildingCount >= MAX_BUILDINGS) {
        break;
      }
      if (!this.districtById.has(job.districtId)) {
        this.ensureDistrictForId(job.districtId);
      }
      if (job.buildingId && !this.buildingById.has(job.buildingId)) {
        this.ensureBuilding(job.buildingId, job.districtId, 0, job.seed.ts);
        buildingCount += 1;
      }
    }

    this.drawPaths(limited);
    this.worldDirty = false;
  }

  private drawPaths(activeDistrictIds: string[]): void {
    this.pathGraphic.clear();
    const baseColor = 0x6c5a2f;
    const edgeColor = 0xb9984d;
    const drawSegment = (from: Vec2, to: Vec2, alpha = 0.32) => {
      this.pathGraphic.lineStyle(14, baseColor, alpha, 0.5);
      this.pathGraphic.moveTo(from.x, from.y);
      this.pathGraphic.lineTo(to.x, to.y);
      this.pathGraphic.lineStyle(4, edgeColor, alpha * 0.9, 0.5);
      this.pathGraphic.moveTo(from.x, from.y);
      this.pathGraphic.lineTo(to.x, to.y);
    };

    const board = this.stations.get("board");
    if (board) {
      for (const station of this.stations.values()) {
        if (station.id === "board") {
          continue;
        }
        drawSegment(board.position, station.position, 0.38);
      }
    }

    const districtLimit = activeDistrictIds.slice(0, 80);
    for (const districtId of districtLimit) {
      const district = this.districtById.get(districtId);
      if (!district) {
        continue;
      }
      const station = this.nearestStation(district.center);
      if (station) {
        drawSegment(station.position, district.center, 0.24);
      }
    }
  }

  private nearestStation(point: Vec2): Station | null {
    let best: Station | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const station of this.stations.values()) {
      const d = distance(point, station.position);
      if (d < bestDistance) {
        bestDistance = d;
        best = station;
      }
    }
    return best;
  }

  private recomputeGateAssignments(): void {
    const gate = this.stations.get("gate");
    const spots = gate?.queueSpots ?? [];
    this.gateAssignments.clear();
    const nextQueue: string[] = [];
    for (const agentId of this.gateQueue) {
      if (!this.agents.has(agentId)) {
        continue;
      }
      const index = Math.min(nextQueue.length, Math.max(0, spots.length - 1));
      nextQueue.push(agentId);
      this.gateAssignments.set(agentId, index);
    }
    this.gateQueue = nextQueue;
  }

  private enqueueGate(agentId: string): void {
    if (!this.gateQueue.includes(agentId)) {
      this.gateQueue.push(agentId);
      this.recomputeGateAssignments();
    }
  }

  private dequeueGate(agentId: string): void {
    const next = this.gateQueue.filter((id) => id !== agentId);
    if (next.length !== this.gateQueue.length) {
      this.gateQueue = next;
      this.recomputeGateAssignments();
    }
  }

  private gateTarget(agentId: string): Vec2 | null {
    const gate = this.stations.get("gate");
    if (!gate) {
      return null;
    }
    const spots = gate.queueSpots;
    if (!spots || spots.length === 0) {
      return gate.position;
    }
    const index = this.gateAssignments.get(agentId) ?? 0;
    const spot = spots[Math.min(index, spots.length - 1)];
    return spot ?? gate.position;
  }

  private assignJobs(): void {
    const idleAgents = [...this.agents.values()].filter((agent) => !agent.jobId);
    if (idleAgents.length === 0) {
      return;
    }
    const availableJobs = this.jobs.filter((job) => !job.assignedAgentId && job.step !== "done");
    if (availableJobs.length === 0) {
      return;
    }
    availableJobs.sort((a, b) => a.seed.seq - b.seed.seq);
    const now = Date.now();
    for (const job of availableJobs) {
      const agent = idleAgents.shift();
      if (!agent) {
        break;
      }
      this.beginJob(agent, job, now);
    }
  }

  private beginJob(agent: Agent, job: Job, now: number): void {
    job.assignedAgentId = agent.id;
    job.step = "to_station";
    job.stepStartedAt = now;
    agent.jobId = job.id;
    agent.anchorStationId = job.stationId;
    if (job.stationId === "gate") {
      this.enqueueGate(agent.id);
    }
    const station = this.stations.get(job.stationId);
    agent.targetPos = station ? { ...station.position } : { ...agent.pos };
    this.setAgentState(agent, "walk", "none");
  }

  private jobStationTarget(agent: Agent, job: Job): Vec2 {
    if (job.stationId === "gate") {
      return this.gateTarget(agent.id) ?? this.stations.get("gate")?.position ?? { ...agent.pos };
    }
    const station = this.stations.get(job.stationId);
    return station ? station.position : { ...agent.pos };
  }

  private jobTargetPosition(job: Job): Vec2 {
    const district = this.ensureDistrictForId(job.districtId);
    if (job.buildingId) {
      const building = this.ensureBuilding(job.buildingId, job.districtId, 0, job.seed.ts);
      return building.position;
    }
    return district.center;
  }

  private moveAgentTowards(agent: Agent, target: Vec2, stepDistance: number): boolean {
    agent.targetPos = { ...target };
    const dx = target.x - agent.pos.x;
    const dy = target.y - agent.pos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= Math.max(2, stepDistance)) {
      agent.pos = { ...target };
      agent.container.position.set(agent.pos.x, agent.pos.y);
      this.updateAgentAnimation(agent);
      return true;
    }
    const nx = dx / dist;
    const ny = dy / dist;
    agent.pos = {
      x: agent.pos.x + nx * stepDistance,
      y: agent.pos.y + ny * stepDistance
    };
    agent.container.position.set(agent.pos.x, agent.pos.y);
    this.updateAgentAnimation(agent);
    return false;
  }

  private interactionDurationMs(type: JobType): number {
    switch (type) {
      case "FILE_WRITE":
        return 1400;
      case "APPROVAL_WAIT":
        return 2800;
      case "TURN_COMPLETE":
        return 1200;
      case "TURN_START":
        return 900;
      case "TEST_FAIL":
        return 1400;
      case "TEST_PASS":
        return 1000;
      case "TEST_RUN":
        return 1000;
      case "FILE_READ":
        return 900;
      case "TOOL_RUN":
        return 950;
      default:
        return 1000;
    }
  }

  private anchorPointForAgent(agent: Agent): Vec2 {
    if (agent.anchorStationId) {
      const station = this.stations.get(agent.anchorStationId);
      if (station) {
        return station.position;
      }
    }
    if (this.lastTouchedDistrictId) {
      const district = this.districtById.get(this.lastTouchedDistrictId);
      if (district) {
        return district.center;
      }
    }
    return this.stations.get("board")?.position ?? { x: 0, y: 0 };
  }

  private updateAgents(delta: number): void {
    const now = Date.now();
    const dt = clamp(delta / 60, 0.6, 2.2);
    const approvalActive = this.jobs.some((job) => job.type === "APPROVAL_WAIT" && job.step !== "done");
    const speedFactor = approvalActive ? 0.86 : 1;
    const completedJobIds = new Set<string>();

    for (const agent of this.agents.values()) {
      const job = agent.jobId ? this.jobsById.get(agent.jobId) : undefined;
      if (!job || job.step === "done") {
        agent.jobId = undefined;
        this.updateAgentIdle(agent, now, dt, speedFactor);
        continue;
      }
      this.updateAgentJob(agent, job, now, dt, speedFactor, completedJobIds);
    }

    if (completedJobIds.size > 0) {
      this.pruneCompletedJobs(completedJobIds);
    }
    this.recomputeGateAssignments();
  }

  private updateAgentIdle(agent: Agent, now: number, dt: number, speedFactor: number): void {
    const anchor = this.anchorPointForAgent(agent);
    const stepDistance = agent.speed * dt * speedFactor * 0.55;
    const toTarget = distance(agent.pos, agent.targetPos);
    if (toTarget < 12 || now >= agent.nextWanderAt) {
      agent.targetPos = this.randomAround(anchor, 220);
      this.scheduleAgentWander(agent, now);
    }
    const shouldMove = distance(agent.pos, agent.targetPos) > 14;
    if (!shouldMove) {
      this.setAgentState(agent, "idle", "none");
      agent.container.position.set(agent.pos.x, agent.pos.y);
      return;
    }
    this.setAgentState(agent, "walk", "none");
    this.moveAgentTowards(agent, agent.targetPos, stepDistance);
  }

  private updateAgentJob(
    agent: Agent,
    job: Job,
    now: number,
    dt: number,
    speedFactor: number,
    completedJobIds: Set<string>
  ): void {
    const stepDistance = agent.speed * dt * speedFactor;
    switch (job.step) {
      case "to_station": {
        const stationTarget = this.jobStationTarget(agent, job);
        this.setAgentState(agent, "walk", agent.payload);
        const reached = this.moveAgentTowards(agent, stationTarget, stepDistance);
        if (reached) {
          this.handleStationArrival(agent, job);
          const fileJob = job.type === "FILE_READ" || job.type === "FILE_WRITE";
          job.step = fileJob ? "to_target" : "interact";
          job.stepStartedAt = now;
        }
        break;
      }
      case "to_target": {
        const target = this.jobTargetPosition(job);
        const carryPayload = agent.payload === "block" ? "block" : "none";
        const state = carryPayload === "block" ? "carry" : "walk";
        this.setAgentState(agent, state, carryPayload);
        const reached = this.moveAgentTowards(agent, target, stepDistance);
        if (reached) {
          job.step = "interact";
          job.stepStartedAt = now;
        }
        break;
      }
      case "interact": {
        this.setAgentState(agent, "interact", agent.payload);
        if (now - job.stepStartedAt >= this.interactionDurationMs(job.type)) {
          this.completeJob(agent, job, now, completedJobIds);
        }
        break;
      }
      case "done":
      default: {
        agent.jobId = undefined;
        this.updateAgentIdle(agent, now, dt, speedFactor);
        break;
      }
    }
  }

  private handleStationArrival(agent: Agent, job: Job): void {
    this.pingStation(job.stationId);
    if (job.type === "FILE_WRITE") {
      this.setAgentState(agent, "carry", "block");
    }
  }

  private completeJob(agent: Agent, job: Job, now: number, completedJobIds: Set<string>): void {
    const station = this.stations.get(job.stationId);
    const stationPos = station?.position;
    const district = this.ensureDistrictForId(job.districtId);
    const districtPos = district.center;
    const buildingPos = job.buildingId ? this.jobTargetPosition(job) : districtPos;

    const pulse = (pos: Vec2, color: number) => this.addPulse(pos, color, 1100);
    const puff = (pos: Vec2, color: number) => this.addPuff(pos, color, 1300);

    switch (job.type) {
      case "FILE_WRITE": {
        if (job.buildingId) {
          this.bumpBuildingWrites(job.buildingId, job.districtId, job.seed.ts);
          this.lastTouchedBuildingId = job.buildingId;
        }
        this.lastTouchedDistrictId = job.districtId;
        if (stationPos) {
          pulse(stationPos, 0xffc180);
        }
        pulse(buildingPos, 0xffe1b8);
        puff(buildingPos, 0xffa24a);
        break;
      }
      case "FILE_READ": {
        if (stationPos) {
          pulse(stationPos, 0x8cdbff);
        }
        pulse(districtPos, 0x7db4ff);
        break;
      }
      case "TEST_PASS": {
        if (stationPos) {
          pulse(stationPos, 0x7dffb2);
        }
        break;
      }
      case "TEST_FAIL": {
        if (stationPos) {
          pulse(stationPos, 0xff7a7a);
          puff(stationPos, 0xff7a7a);
        }
        const lastBuilding = this.lastTouchedBuildingId ? this.buildingById.get(this.lastTouchedBuildingId) : undefined;
        const lastDistrict = this.lastTouchedDistrictId ? this.districtById.get(this.lastTouchedDistrictId) : undefined;
        const impactPos = lastBuilding?.position ?? lastDistrict?.center ?? districtPos;
        puff(impactPos, 0xff4d4d);
        break;
      }
      case "TEST_RUN":
      case "TOOL_RUN": {
        if (stationPos) {
          pulse(stationPos, 0x9bc8ff);
        }
        break;
      }
      case "APPROVAL_WAIT": {
        if (stationPos) {
          pulse(stationPos, 0xffd35a);
        }
        this.dequeueGate(agent.id);
        break;
      }
      case "TURN_START": {
        if (stationPos) {
          pulse(stationPos, 0x7aa0ff);
        }
        break;
      }
      case "TURN_COMPLETE": {
        if (stationPos) {
          pulse(stationPos, 0xe8b3ff);
        }
        this.createRelic();
        break;
      }
      default:
        break;
    }

    job.step = "done";
    job.stepStartedAt = now;
    completedJobIds.add(job.id);
    agent.jobId = undefined;
    agent.payload = "none";
    this.setAgentState(agent, "idle", "none");
    const anchor = this.anchorPointForAgent(agent);
    agent.targetPos = this.randomAround(anchor, 200);
    this.scheduleAgentWander(agent, now);
    agent.container.position.set(agent.pos.x, agent.pos.y);
  }

  private pruneCompletedJobs(completedJobIds: Set<string>): void {
    for (const id of completedJobIds) {
      this.jobsById.delete(id);
    }
    this.jobs = this.jobs.filter((job) => !completedJobIds.has(job.id));
  }

  private pingStation(id: StationId): void {
    const station = this.stations.get(id);
    if (!station) {
      return;
    }
    const now = Date.now();
    this.stationGlowUntil.set(id, now + 1200);
    this.addPulse(station.position, STATION_COLORS[id].glow, 950);
  }

  private addPulse(position: Vec2, color: number, ttlMs: number): void {
    const fx: PulseFx = {
      id: `pulse:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
      position: { ...position },
      color,
      ttlMs,
      startedAt: Date.now(),
      graphic: new Graphics()
    };
    this.layers.fxLayer.addChild(fx.graphic);
    this.pulses.push(fx);
    while (this.pulses.length > MAX_PULSES) {
      const oldest = this.pulses.shift();
      if (oldest) {
        this.layers.fxLayer.removeChild(oldest.graphic);
        oldest.graphic.destroy();
      }
    }
  }

  private addPuff(position: Vec2, color: number, ttlMs: number): void {
    const fx: PuffFx = {
      id: `puff:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
      position: { ...position },
      color,
      ttlMs,
      startedAt: Date.now(),
      graphic: new Graphics()
    };
    this.layers.fxLayer.addChild(fx.graphic);
    this.puffs.push(fx);
    while (this.puffs.length > MAX_PUFFS) {
      const oldest = this.puffs.shift();
      if (oldest) {
        this.layers.fxLayer.removeChild(oldest.graphic);
        oldest.graphic.destroy();
      }
    }
  }

  private createRelic(): void {
    const archive = this.stations.get("archive");
    if (!archive) {
      return;
    }
    this.relicCount += 1;
    const index = this.relicCount;
    const angle = index * 0.85;
    const radius = 86 + Math.sqrt(index) * 10;
    const position = {
      x: archive.position.x + Math.cos(angle) * radius,
      y: archive.position.y + Math.sin(angle) * radius * 0.7
    };

    const relic = new Graphics();
    relic.position.set(position.x, position.y);
    relic.beginFill(0xe8b3ff, 0.9);
    relic.lineStyle(2, 0xffffff, 0.75);
    relic.moveTo(0, -12);
    relic.lineTo(10, 0);
    relic.lineTo(0, 12);
    relic.lineTo(-10, 0);
    relic.closePath();
    relic.endFill();
    this.layers.propsLayer.addChild(relic);
    this.relics.push(relic);

    const maxRelics = 80;
    while (this.relics.length > maxRelics) {
      const oldest = this.relics.shift();
      if (oldest) {
        this.layers.propsLayer.removeChild(oldest);
        oldest.destroy();
      }
    }
  }

  private updateEffects(): void {
    const now = Date.now();

    const nextPulses: PulseFx[] = [];
    for (const pulse of this.pulses) {
      const elapsed = now - pulse.startedAt;
      const progress = elapsed / pulse.ttlMs;
      if (progress >= 1) {
        this.layers.fxLayer.removeChild(pulse.graphic);
        pulse.graphic.destroy();
        continue;
      }
      const radius = 14 + progress * 62;
      const alpha = clamp(1 - progress, 0, 1) * 0.72;
      pulse.graphic.clear();
      pulse.graphic.lineStyle(3, pulse.color, alpha);
      pulse.graphic.drawCircle(pulse.position.x, pulse.position.y, radius);
      nextPulses.push(pulse);
    }
    this.pulses = nextPulses;

    const nextPuffs: PuffFx[] = [];
    for (const puff of this.puffs) {
      const elapsed = now - puff.startedAt;
      const progress = elapsed / puff.ttlMs;
      if (progress >= 1) {
        this.layers.fxLayer.removeChild(puff.graphic);
        puff.graphic.destroy();
        continue;
      }
      const radius = 18 + progress * 48;
      const alpha = clamp(1 - progress, 0, 1) * 0.45;
      puff.graphic.clear();
      puff.graphic.beginFill(puff.color, alpha * 0.6);
      puff.graphic.drawCircle(puff.position.x, puff.position.y, radius * 0.55);
      puff.graphic.endFill();
      puff.graphic.lineStyle(2, puff.color, alpha);
      puff.graphic.drawCircle(puff.position.x, puff.position.y, radius);
      nextPuffs.push(puff);
    }
    this.puffs = nextPuffs;

    for (const station of this.stations.values()) {
      const until = this.stationGlowUntil.get(station.id);
      if (!until || until <= now) {
        station.glow.alpha = 0.12;
        if (until && until <= now) {
          this.stationGlowUntil.delete(station.id);
        }
        continue;
      }
      const remaining = until - now;
      const alpha = 0.12 + clamp(remaining / 1200, 0, 1) * 0.2;
      station.glow.alpha = alpha;
    }
  }

  private updateHotspotGraphic(): void {
    const now = Date.now();
    const hotspot = this.hotspot && this.hotspot.expiresAt > now ? this.hotspot : null;
    this.hotspotGraphic.clear();
    if (!hotspot) {
      return;
    }
    const ttl = hotspot.expiresAt - now;
    const life = clamp(ttl / HOTSPOT_LINGER_MS, 0.05, 1);
    const pulse = Math.sin(now / 220) * 6;
    const radius = 32 + pulse;
    const alpha = life * 0.55;
    this.hotspotGraphic.lineStyle(2, 0x9bc8ff, alpha);
    this.hotspotGraphic.drawCircle(hotspot.position.x, hotspot.position.y, radius);
  }

  private rememberEvent(event: TelemetryEventV1): boolean {
    const key = `${event.run_id}:${event.seq}:${event.name}`;
    if (this.seenEventKeys.has(key)) {
      return false;
    }
    this.seenEventKeys.set(key, event.seq);
    this.seenEventOrder.push(key);
    const maxSeen = 4000;
    while (this.seenEventOrder.length > maxSeen) {
      const oldest = this.seenEventOrder.shift();
      if (oldest) {
        this.seenEventKeys.delete(oldest);
      }
    }
    return true;
  }

  private recordEventTime(now: number): void {
    this.eventTimes.push(now);
    const windowMs = 6000;
    const minTs = now - windowMs;
    while (this.eventTimes.length > 0) {
      const first = this.eventTimes[0];
      if (first === undefined || first >= minTs) {
        break;
      }
      this.eventTimes.shift();
    }
  }

  private updateEventsPerSecond(): void {
    const now = Date.now();
    const windowMs = 5000;
    const minTs = now - windowMs;
    while (this.eventTimes.length > 0) {
      const first = this.eventTimes[0];
      if (first === undefined || first >= minTs) {
        break;
      }
      this.eventTimes.shift();
    }
    this.eventsPerSecond = this.eventTimes.length / (windowMs / 1000);
    this.updateHudText();
  }

  private createJobFromSeed(seed: JobSeed, now: number): Job {
    this.jobCounter += 1;
    const districtId = seed.districtId ?? "region.unknown";
    return {
      id: `${seed.id}:${this.jobCounter}`,
      seed,
      type: seed.type,
      stationId: seed.stationId,
      districtId,
      buildingId: seed.buildingId,
      createdAt: now,
      step: "to_station",
      stepStartedAt: now
    };
  }

  private markHotspotForJob(job: Job): void {
    const position = this.positionForJob(job);
    if (!position) {
      return;
    }
    this.hotspot = {
      position,
      expiresAt: Date.now() + HOTSPOT_LINGER_MS
    };
  }

  private positionForJob(job: Job): Vec2 | null {
    if (job.buildingId) {
      const building = this.buildingById.get(job.buildingId);
      if (building) {
        return building.position;
      }
    }
    const district = this.districtById.get(job.districtId);
    if (district) {
      return district.center;
    }
    const station = this.stations.get(job.stationId);
    return station ? station.position : null;
  }
}
