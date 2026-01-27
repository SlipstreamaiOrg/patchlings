import crypto from "node:crypto";
import path from "node:path";

import type { TelemetryAttrs, TelemetryEventV1 } from "@patchlings/protocol";

export const DEFAULT_ALLOW_CONTENT = process.env.PATCHLINGS_ALLOW_CONTENT === "true";

const ALWAYS_REDACT_KEY_PATTERNS: RegExp[] = [
  /token/i,
  /secret/i,
  /authorization/i,
  /cookie/i,
  /header/i,
  /password/i,
  /api[_-]?key/i,
  /session/i
];

const CONTENT_KEY_PATTERNS: RegExp[] = [
  /prompt/i,
  /content/i,
  /body/i,
  /payload/i,
  /stdin/i,
  /stdout/i,
  /stderr/i,
  /command/i,
  /args?/i,
  /diff/i,
  /patch/i
];

const PATH_KEY_PATTERNS: RegExp[] = [
  /path/i,
  /^file$/i,
  /file[_-]?name/i,
  /cwd/i,
  /workspace/i,
  /repo/i,
  /target/i,
  /source/i
];

export interface RedactionOptions {
  allowContent?: boolean;
  stableSalt?: string;
}

export function createSalt(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function hashWithSalt(value: string, salt: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(salt);
  hash.update("|");
  hash.update(value);
  return hash.digest("hex").slice(0, 12);
}

export function normalizePath(inputPath: string): string {
  const normalized = path.normalize(inputPath);
  return normalized.replace(/\\/g, "/");
}

function dirnamePosix(inputPath: string): string {
  const normalized = normalizePath(inputPath);
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length <= 1) {
    return ".";
  }
  parts.pop();
  return parts.join("/");
}

export function hashPath(inputPath: string, salt: string): string {
  return hashWithSalt(normalizePath(inputPath), salt);
}

function matchesAny(patterns: RegExp[], key: string): boolean {
  return patterns.some((pattern) => pattern.test(key));
}

function isAlwaysRedactedKey(key: string): boolean {
  return matchesAny(ALWAYS_REDACT_KEY_PATTERNS, key);
}

function isContentKey(key: string): boolean {
  return matchesAny(CONTENT_KEY_PATTERNS, key);
}

function isPathKey(key: string): boolean {
  return matchesAny(PATH_KEY_PATTERNS, key);
}

function isHashedKey(key: string): boolean {
  return key.toLowerCase().includes("_hash");
}

function asAttrValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

export function redactAttrs(
  attrs: TelemetryAttrs | Record<string, unknown> | undefined,
  salt: string,
  options: RedactionOptions = {}
): TelemetryAttrs | undefined {
  if (!attrs) {
    return undefined;
  }

  const allowContent = options.allowContent ?? DEFAULT_ALLOW_CONTENT;
  const stableSalt = options.stableSalt;
  const redacted: TelemetryAttrs = {};

  for (const [key, value] of Object.entries(attrs)) {
    if (isAlwaysRedactedKey(key)) {
      continue;
    }

    if (isHashedKey(key)) {
      const hashedValue = asAttrValue(value);
      if (hashedValue !== undefined) {
        redacted[key] = hashedValue;
      }
      continue;
    }

    if (!allowContent && isContentKey(key)) {
      continue;
    }

    if (typeof value === "string" && isPathKey(key)) {
      const dirValue = dirnamePosix(value);
      redacted[`${key}_hash`] = hashPath(value, salt);
      redacted[`${key}_dir_hash`] = hashPath(dirValue, salt);
      if (stableSalt) {
        redacted[`${key}_stable_hash`] = hashPath(value, stableSalt);
        redacted[`${key}_stable_dir_hash`] = hashPath(dirValue, stableSalt);
      }
      if (allowContent) {
        redacted[key] = value;
      }
      continue;
    }

    const safeValue = asAttrValue(value);
    if (safeValue === undefined) {
      continue;
    }
    redacted[key] = safeValue;
  }

  return Object.keys(redacted).length > 0 ? redacted : undefined;
}

export function redactEvent(event: TelemetryEventV1, salt: string, options: RedactionOptions = {}): TelemetryEventV1 {
  const allowContent = options.allowContent ?? DEFAULT_ALLOW_CONTENT;
  const stableSalt = options.stableSalt;

  const attrs = redactAttrs(event.attrs, salt, { allowContent, stableSalt });

  return {
    ...event,
    ...(attrs ? { attrs } : { attrs: undefined })
  };
}
