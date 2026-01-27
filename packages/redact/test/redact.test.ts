import { describe, expect, it } from "vitest";

import { hashPath, redactAttrs } from "../src/index.js";

describe("redaction", () => {
  it("hashes path-like keys and drops sensitive content by default", () => {
    const salt = "salt-1";
    const redacted = redactAttrs(
      {
        path: "src/index.ts",
        token: "should-not-appear",
        command: "echo hello",
        attempts: 2
      },
      salt
    );

    expect(redacted?.path_hash).toBe(hashPath("src/index.ts", salt));
    expect(redacted?.path).toBeUndefined();
    expect(redacted?.token).toBeUndefined();
    expect(redacted?.command).toBeUndefined();
    expect(redacted?.attempts).toBe(2);
  });

  it("retains content keys only when explicitly allowed", () => {
    const salt = "salt-2";
    const redacted = redactAttrs(
      {
        file_path: "src/app.ts",
        command: "npm test"
      },
      salt,
      { allowContent: true }
    );

    expect(redacted?.file_path_hash).toBe(hashPath("src/app.ts", salt));
    expect(redacted?.file_path).toBe("src/app.ts");
    expect(redacted?.command).toBe("npm test");
  });

  it("always drops secret-like keys even when content is allowed", () => {
    const salt = "salt-3";
    const redacted = redactAttrs(
      {
        apiKey: "secret",
        prompt: "hello"
      },
      salt,
      { allowContent: true }
    );

    expect(redacted?.apiKey).toBeUndefined();
    expect(redacted?.prompt).toBe("hello");
  });

  it("does not re-hash already hashed keys", () => {
    const redacted = redactAttrs(
      {
        path_hash: "abc123",
        path_dir_hash: "def456"
      },
      "salt-4"
    );

    expect(redacted?.path_hash).toBe("abc123");
    expect(redacted?.path_dir_hash).toBe("def456");
  });

  it("preserves hashed content metadata while dropping raw content", () => {
    const redacted = redactAttrs(
      {
        prompt: "never show this",
        prompt_hash: "hash-1"
      },
      "salt-5"
    );

    expect(redacted?.prompt).toBeUndefined();
    expect(redacted?.prompt_hash).toBe("hash-1");
  });

  it("supports a stable workspace salt for persistent IDs", () => {
    const stableSalt = "workspace-salt";
    const runA = redactAttrs(
      {
        path: "src/world.ts"
      },
      "run-a",
      { stableSalt }
    );
    const runB = redactAttrs(
      {
        path: "src/world.ts"
      },
      "run-b",
      { stableSalt }
    );

    expect(runA?.path_hash).not.toBe(runB?.path_hash);
    expect(runA?.path_stable_hash).toBe(runB?.path_stable_hash);
  });
});
