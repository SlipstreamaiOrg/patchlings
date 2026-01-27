import { Assets, Rectangle, Texture } from "pixi.js";

import { DEFAULT_PATCHLINGS_ASSET_ROOT } from "@patchlings/protocol";

export type PatchlingAction = "idle" | "walk" | "carry";
export type PatchlingDir = "N" | "E" | "S" | "W";

export interface PatchlingSpriteSet {
  mode: "sprites" | "placeholder";
  size: number;
  assetBase: string;
  animations: Record<PatchlingAction, Record<PatchlingDir, Texture[]>>;
  warnings: string[];
}

export interface PatchlingSpriteOptions {
  assetBase: string;
  size?: number;
  frameCount?: number;
}

const ACTIONS: PatchlingAction[] = ["idle", "walk", "carry"];
const DIRECTIONS: PatchlingDir[] = ["S", "E", "N", "W"];
const DIR_TOKENS: Record<PatchlingDir, string[]> = {
  S: ["S", "s"],
  E: ["E", "e"],
  N: ["N", "n"],
  W: ["W", "w"]
};
const ROW_BY_DIR: Record<PatchlingDir, number> = {
  S: 0,
  E: 1,
  N: 2,
  W: 3
};

const DEFAULT_SIZE = 128;
const DEFAULT_FRAME_COUNT = 6;

function normalizeAssetBase(assetBase: string): string {
  const trimmed = assetBase.trim();
  if (!trimmed) {
    return "/patchlings-assets";
  }
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function assetUrl(assetBase: string, relativePath: string): string {
  const base = normalizeAssetBase(assetBase);
  const rel = relativePath.replace(/^\/+/, "");
  return `${base}/${rel}`;
}

async function assetExists(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "HEAD" });
    if (response.ok) {
      return true;
    }
    if (response.status === 405) {
      const getResponse = await fetch(url, { method: "GET" });
      return getResponse.ok;
    }
    return false;
  } catch (error) {
    return false;
  }
}

function placeholderAnimations(): Record<PatchlingAction, Record<PatchlingDir, Texture[]>> {
  const animations = {} as Record<PatchlingAction, Record<PatchlingDir, Texture[]>>;
  for (const action of ACTIONS) {
    const perDir = {} as Record<PatchlingDir, Texture[]>;
    for (const dir of DIRECTIONS) {
      perDir[dir] = [Texture.WHITE];
    }
    animations[action] = perDir;
  }
  return animations;
}

function warningsForMissingAssets(assetBase: string): string[] {
  const base = normalizeAssetBase(assetBase);
  return [
    "[patchlings/viewer] Patchlings sprites missing; running placeholder mode.",
    "[patchlings/viewer] Placeholder mode: missing sprites.",
    `[patchlings/viewer] Expected sheets under: ${base}/sprites_v1/sheets/`,
    `[patchlings/viewer] Expected frames under: ${base}/sprites_v1/sprites/`,
    `[patchlings/viewer] Canonical repo asset root: ${DEFAULT_PATCHLINGS_ASSET_ROOT}/`
  ];
}

function frameToken(frameIndex: number): string {
  return String(frameIndex).padStart(2, "0");
}

function frameUrlCandidates(
  assetBase: string,
  action: PatchlingAction,
  dir: PatchlingDir,
  frameIndex: number,
  size: number
): string[] {
  const urls: string[] = [];
  const dirTokens = DIR_TOKENS[dir];
  const token = frameToken(frameIndex);
  for (const dirToken of dirTokens) {
    urls.push(
      assetUrl(
        assetBase,
        `sprites_v1/sprites/patchling_${action}_${dirToken}_${token}_${size}.png`
      )
    );
  }
  return urls;
}

async function detectFrameStartIndex(assetBase: string, size: number): Promise<number | null> {
  const dirTokens = DIR_TOKENS.S;
  const zeroCandidates = dirTokens.map((dirToken) =>
    assetUrl(assetBase, `sprites_v1/sprites/patchling_idle_${dirToken}_00_${size}.png`)
  );
  const zeroChecks = await Promise.all(zeroCandidates.map((url) => assetExists(url)));
  if (zeroChecks.some(Boolean)) {
    return 0;
  }

  const oneCandidates = dirTokens.map((dirToken) =>
    assetUrl(assetBase, `sprites_v1/sprites/patchling_idle_${dirToken}_01_${size}.png`)
  );
  const oneChecks = await Promise.all(oneCandidates.map((url) => assetExists(url)));
  if (oneChecks.some(Boolean)) {
    return 1;
  }

  return null;
}

function sliceSheetTextures(texture: Texture, size: number): Record<PatchlingDir, Texture[]> | null {
  const columns = Math.max(1, Math.floor(texture.width / size));
  const rows = Math.max(1, Math.floor(texture.height / size));
  if (rows < 4 || columns < 1) {
    return null;
  }

  const perDir = {} as Record<PatchlingDir, Texture[]>;
  for (const dir of DIRECTIONS) {
    const rowIndex = ROW_BY_DIR[dir];
    const textures: Texture[] = [];
    for (let col = 0; col < columns; col += 1) {
      const frame = new Rectangle(col * size, rowIndex * size, size, size);
      textures.push(new Texture(texture.baseTexture, frame));
    }
    perDir[dir] = textures.length > 0 ? textures : [texture];
  }
  return perDir;
}

async function loadSheetAnimations(
  assetBase: string,
  size: number
): Promise<Record<PatchlingAction, Record<PatchlingDir, Texture[]>> | null> {
  const sheetUrls = {
    idle: assetUrl(assetBase, `sprites_v1/sheets/patchling_idle_sheet_${size}.png`),
    walk: assetUrl(assetBase, `sprites_v1/sheets/patchling_walk_sheet_${size}.png`),
    carry: assetUrl(assetBase, `sprites_v1/sheets/patchling_carry_sheet_${size}.png`)
  } as const;

  const existsChecks = await Promise.all(Object.values(sheetUrls).map((url) => assetExists(url)));
  if (existsChecks.some((exists) => !exists)) {
    return null;
  }

  try {
    const [idleTexture, walkTexture, carryTexture] = await Promise.all([
      Assets.load(sheetUrls.idle),
      Assets.load(sheetUrls.walk),
      Assets.load(sheetUrls.carry)
    ]);

    const idle = sliceSheetTextures(idleTexture as Texture, size);
    const walk = sliceSheetTextures(walkTexture as Texture, size);
    const carry = sliceSheetTextures(carryTexture as Texture, size);
    if (!idle || !walk || !carry) {
      return null;
    }

    return {
      idle,
      walk,
      carry
    };
  } catch (error) {
    return null;
  }
}

async function loadFrameAnimations(
  assetBase: string,
  size: number,
  frameCount: number
): Promise<Record<PatchlingAction, Record<PatchlingDir, Texture[]>> | null> {
  const startIndex = await detectFrameStartIndex(assetBase, size);
  if (startIndex === null) {
    return null;
  }

  const animations = {} as Record<PatchlingAction, Record<PatchlingDir, Texture[]>>;

  for (const action of ACTIONS) {
    const perDir = {} as Record<PatchlingDir, Texture[]>;
    for (const dir of DIRECTIONS) {
      const textures: Texture[] = [];
      for (let frameIndex = startIndex; frameIndex < startIndex + frameCount; frameIndex += 1) {
        const candidates = frameUrlCandidates(assetBase, action, dir, frameIndex, size);
        let loaded = false;
        for (const url of candidates) {
          try {
            const texture = (await Assets.load(url)) as Texture;
            textures.push(texture);
            loaded = true;
            break;
          } catch (error) {
            // Ignore missing frames; we will fall back to any available frames.
          }
        }
        if (!loaded) {
          continue;
        }
      }
      perDir[dir] = textures.length > 0 ? textures : [Texture.WHITE];
    }
    animations[action] = perDir;
  }

  const hasRealTextures = ACTIONS.some((action) =>
    DIRECTIONS.some((dir) =>
      animations[action][dir].some((texture) => texture !== Texture.WHITE)
    )
  );

  return hasRealTextures ? animations : null;
}

export async function loadPatchlingSprites(
  options: PatchlingSpriteOptions
): Promise<PatchlingSpriteSet> {
  const size = options.size ?? DEFAULT_SIZE;
  const frameCount = options.frameCount ?? DEFAULT_FRAME_COUNT;
  const assetBase = normalizeAssetBase(options.assetBase);

  const fromSheets = await loadSheetAnimations(assetBase, size);
  if (fromSheets) {
    console.info(`[patchlings/viewer] Loaded Patchlings sprites v1 from ${assetBase}`);
    return {
      mode: "sprites",
      size,
      assetBase,
      animations: fromSheets,
      warnings: []
    };
  }

  const fromFrames = await loadFrameAnimations(assetBase, size, frameCount);
  if (fromFrames) {
    console.info(`[patchlings/viewer] Loaded Patchlings sprites v1 from ${assetBase}`);
    return {
      mode: "sprites",
      size,
      assetBase,
      animations: fromFrames,
      warnings: [
        "[patchlings/viewer] Sprite sheets missing; using individual frames instead."
      ]
    };
  }

  const warnings = warningsForMissingAssets(assetBase);
  for (const warning of warnings) {
    console.warn(warning);
  }

  return {
    mode: "placeholder",
    size,
    assetBase,
    animations: placeholderAnimations(),
    warnings
  };
}
