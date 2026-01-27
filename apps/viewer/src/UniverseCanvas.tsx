import { useEffect, useMemo, useRef } from "react";

import type { ThemeRenderState, ThemeRegion } from "@patchlings/themes";

import type { RunStatus } from "./types";

interface UniverseCanvasProps {
  renderState: ThemeRenderState | null;
  connected: boolean;
  status: RunStatus;
  runId: string;
}

interface Vec2 {
  x: number;
  y: number;
}

const STAR_COUNT = 120;
const FILES_PER_REGION_LIMIT = 220;

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(1664525, state) + 1013904223;
    return (state >>> 0) / 4294967296;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function regionRadius(region: ThemeRegion): number {
  const base = 26;
  const sizeFactor = Math.sqrt(region.fileCount + 1) * 2.2;
  const touchFactor = Math.log10(region.touchCount + 10) * 8;
  return clamp(base + sizeFactor + touchFactor, 28, 92);
}

function positionRegions(regions: ThemeRegion[], center: Vec2, radius: number): Map<string, Vec2> {
  const positions = new Map<string, Vec2>();
  const count = Math.max(1, regions.length);
  regions.forEach((region, index) => {
    const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
    const r = radius * (0.72 + (index % 3) * 0.08);
    positions.set(region.id, {
      x: center.x + Math.cos(angle) * r,
      y: center.y + Math.sin(angle) * r
    });
  });
  return positions;
}

function positionFile(fileId: string, regionCenter: Vec2, regionR: number): Vec2 {
  const seed = hashString(fileId);
  const rnd = lcg(seed);
  const angle = rnd() * Math.PI * 2;
  const radius = regionR * (0.3 + rnd() * 0.65);
  return {
    x: regionCenter.x + Math.cos(angle) * radius,
    y: regionCenter.y + Math.sin(angle) * radius
  };
}

function drawBackground(ctx: CanvasRenderingContext2D, width: number, height: number, seed: number): void {
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "#05070f");
  gradient.addColorStop(1, "#0b1021");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const rnd = lcg(seed);
  for (let i = 0; i < STAR_COUNT; i += 1) {
    const x = rnd() * width;
    const y = rnd() * height;
    const alpha = 0.2 + rnd() * 0.6;
    const size = 0.8 + rnd() * 1.8;
    ctx.fillStyle = `rgba(180, 210, 255, ${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawStatusOverlay(ctx: CanvasRenderingContext2D, width: number, connected: boolean, status: RunStatus, runId: string): void {
  const text = connected ? `Run: ${runId} • ${status}` : "Waiting for runner…";
  ctx.save();
  ctx.font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.fillStyle = "rgba(210, 225, 255, 0.85)";
  ctx.fillText(text, 16, 24);
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = connected ? "rgba(90, 200, 140, 0.8)" : "rgba(255, 120, 120, 0.8)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(width - 24, 24, 8, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

export function UniverseCanvas({ renderState, connected, status, runId }: UniverseCanvasProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });

  const backgroundSeed = useMemo(() => hashString(renderState?.meta.workspaceId ?? "patchlings"), [renderState?.meta.workspaceId]);

  const scheduleDraw = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }

      const { width, height, dpr } = sizeRef.current;
      ctx.save();
      ctx.scale(dpr, dpr);
      drawBackground(ctx, width, height, backgroundSeed);

      if (renderState) {
        const center: Vec2 = { x: width / 2, y: height / 2 };
        const ringRadius = Math.min(width, height) * 0.32;
        const regions = renderState.regions.slice(0, 18);
        const regionPositions = positionRegions(regions, center, ringRadius);

        for (const region of regions) {
          const position = regionPositions.get(region.id);
          if (!position) {
            continue;
          }
          const r = regionRadius(region);
          const glow = ctx.createRadialGradient(position.x, position.y, r * 0.2, position.x, position.y, r * 1.6);
          glow.addColorStop(0, "rgba(120, 180, 255, 0.28)");
          glow.addColorStop(1, "rgba(40, 70, 130, 0.02)");
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(position.x, position.y, r * 1.6, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = "rgba(120, 180, 255, 0.5)";
          ctx.beginPath();
          ctx.arc(position.x, position.y, r, 0, Math.PI * 2);
          ctx.fill();

          ctx.strokeStyle = "rgba(190, 220, 255, 0.7)";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(position.x, position.y, r, 0, Math.PI * 2);
          ctx.stroke();
        }

        const filesByRegion = new Map<string, typeof renderState.files>();
        for (const file of renderState.files) {
          const list = filesByRegion.get(file.regionId);
          if (list) {
            list.push(file);
          } else {
            filesByRegion.set(file.regionId, [file]);
          }
        }

        for (const region of regions) {
          const regionCenter = regionPositions.get(region.id);
          if (!regionCenter) {
            continue;
          }
          const r = regionRadius(region);
          const files = (filesByRegion.get(region.id) ?? []).slice(0, FILES_PER_REGION_LIMIT);
          for (const file of files) {
            const position = positionFile(file.id, regionCenter, r);
            const intensity = clamp(Math.log10(file.touchCount + 10) / 2.2, 0.15, 1);
            ctx.fillStyle = `rgba(255, 230, 180, ${0.22 + intensity * 0.6})`;
            ctx.beginPath();
            ctx.arc(position.x, position.y, 1.6 + intensity * 1.8, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        const patchlings = renderState.patchlings.slice(0, 80);
        const patchlingOrbit = Math.min(width, height) * 0.42;
        patchlings.forEach((patchling, index) => {
          const seed = hashString(patchling.id);
          const rnd = lcg(seed);
          const angle = (index / Math.max(1, patchlings.length)) * Math.PI * 2 + rnd() * 0.3;
          const radius = patchlingOrbit * (0.82 + rnd() * 0.12);
          const x = center.x + Math.cos(angle) * radius;
          const y = center.y + Math.sin(angle) * radius;
          const size = 4 + clamp(Math.log2(patchling.callCount + 1), 0, 6);

          ctx.fillStyle = "rgba(140, 255, 190, 0.85)";
          ctx.fillRect(x - size / 2, y - size / 2, size, size);
          ctx.strokeStyle = "rgba(40, 120, 80, 0.8)";
          ctx.lineWidth = 1;
          ctx.strokeRect(x - size / 2, y - size / 2, size, size);
        });
      }

      drawStatusOverlay(ctx, width, connected, status, runId);
      ctx.restore();
    });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
      sizeRef.current = { width: rect.width, height: rect.height, dpr };
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      scheduleDraw();
    };

    resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
    };
  }, []);

  useEffect(() => {
    scheduleDraw();
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [renderState, connected, status, runId, backgroundSeed]);

  return (
    <div className="universe-canvas">
      <canvas ref={canvasRef} />
    </div>
  );
}

