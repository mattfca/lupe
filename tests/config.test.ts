import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config/load";
import { DEFAULT_CONFIG, resolveConfig } from "../src/config/schema";
import { ConfigError } from "../src/util/errors";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("config defaults and merge", () => {
  test("returns defaults when lupe.config.ts is absent", async () => {
    const cwd = makeTempDir();
    const loaded = await loadConfig({ cwd });

    expect(loaded.path).toBeNull();
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.config.verify).not.toBe(DEFAULT_CONFIG.verify);
    expect(loaded.config.input).not.toBe(DEFAULT_CONFIG.input);
  });

  test("supports input as a directory string", () => {
    const config = resolveConfig({ input: "queue" });

    expect(config.input).toEqual({
      ...DEFAULT_CONFIG.input,
      dir: "queue"
    });
  });

  test("loads lupe.config.ts and deep-merges advanced input defaults", async () => {
    const cwd = makeTempDir();
    const defineConfigImport = pathToFileURL(join(process.cwd(), "src/index.ts")).href;

    writeFileSync(
      join(cwd, "lupe.config.ts"),
      `import { defineConfig } from ${JSON.stringify(defineConfigImport)}

export default defineConfig({
  input: {
    dir: "work",
    onUnmatchedFile: "error"
  },
  autoAccept: true,
  verify: ["bun test"]
})
`
    );

    const loaded = await loadConfig({ cwd });

    expect(loaded.path).toBe(join(cwd, "lupe.config.ts"));
    expect(loaded.config.input).toEqual({
      ...DEFAULT_CONFIG.input,
      dir: "work",
      onUnmatchedFile: "error"
    });
    expect(loaded.config.autoAccept).toBe(true);
    expect(loaded.config.verify).toEqual(["bun test"]);
    expect(loaded.config.maxParallelPhases).toBe(2);
  });
});

describe("config validation", () => {
  test("rejects invalid numeric values", () => {
    expect(() => resolveConfig({ maxParallelPhases: 0 })).toThrow(ConfigError);
    expect(() => resolveConfig({ maxParallelPhases: 0 })).toThrow(
      "maxParallelPhases must be a positive integer"
    );
  });

  test("rejects invalid input shape", () => {
    expect(() => resolveConfig({ input: { dir: "/tmp/queue" } })).toThrow(
      "input.dir must be a relative path"
    );
  });

  test("rejects unknown config fields", () => {
    expect(() => resolveConfig({ unexpected: true })).toThrow('Unknown config field "unexpected"');
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lupe-config-"));
  tempDirs.push(dir);
  return dir;
}
