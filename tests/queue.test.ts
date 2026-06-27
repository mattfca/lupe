import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "bun:test";

import { resolveConfig } from "../src/config/schema";
import { INPUT_DIR, INTERNAL_DIR } from "../src/fs/contract";
import { loadQueue } from "../src/queue/discover";
import { parseWorkItemFilename } from "../src/queue/filename";
import { hashContents } from "../src/queue/hash";
import { ContractError, UsageError } from "../src/util/errors";

const tempDirs: string[] = [];
const testDir = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("work item filename parsing", () => {
  test("parses valid timestamp-prefixed markdown filenames", () => {
    const parsed = parseWorkItemFilename("20260626T120000_initial_scope.md");

    expect(parsed).toEqual({
      filename: "20260626T120000_initial_scope.md",
      id: "20260626T120000_initial_scope",
      timestamp: "20260626T120000",
      description: "initial_scope"
    });
  });

  test("rejects invalid filenames", () => {
    expect(parseWorkItemFilename("20260626T120000.md")).toBeNull();
    expect(parseWorkItemFilename("20260626T12000_missing_digit.md")).toBeNull();
    expect(parseWorkItemFilename("20260626-120000_missing_t.md")).toBeNull();
    expect(parseWorkItemFilename("20260626T120000_wrong_extension.txt")).toBeNull();
  });
});

describe("work item hashing", () => {
  test("produces stable sha256 hashes for content", () => {
    expect(hashContents("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
    expect(hashContents("hello")).toBe(hashContents("hello"));
    expect(hashContents("hello")).not.toBe(hashContents("hello\n"));
  });
});

describe("queue discovery", () => {
  test("loads work items in chronological filename order", async () => {
    const cwd = makeTempDir();
    writeQueueFile(cwd, "20260626T120001_third.md", "third");
    writeQueueFile(cwd, "20250626T120000_first.md", "first");
    writeQueueFile(cwd, "20260626T120000_second.md", "second");

    const queue = await loadQueue(resolveConfig(), { cwd });

    expect(queue.warnings).toEqual([]);
    expect(queue.items.map((item) => item.id)).toEqual([
      "20250626T120000_first",
      "20260626T120000_second",
      "20260626T120001_third"
    ]);
    expect(queue.items.map((item) => item.contents)).toEqual(["first", "second", "third"]);
  });

  test("warns and excludes unmatched files by default", async () => {
    const cwd = makeTempDir();
    const unmatchedPath = writeQueueFile(cwd, "notes.md", "not a work item");
    writeQueueFile(cwd, "20260626T120000_valid.md", "valid");

    const queue = await loadQueue(resolveConfig(), { cwd });

    expect(queue.items.map((item) => item.id)).toEqual(["20260626T120000_valid"]);
    expect(queue.warnings).toHaveLength(1);
    expect(queue.warnings[0]?.code).toBe("unmatched-file");
    expect(queue.warnings[0]?.path).toBe(unmatchedPath);
  });

  test("errors on unmatched files when configured", async () => {
    const cwd = makeTempDir();
    writeQueueFile(cwd, "notes.md", "not a work item");
    const config = resolveConfig({
      input: {
        onUnmatchedFile: "error"
      }
    });

    await expect(loadQueue(config, { cwd })).rejects.toThrow(UsageError);
    await expect(loadQueue(config, { cwd })).rejects.toThrow("does not match work item pattern");
  });

  test("errors on duplicate timestamp prefixes", async () => {
    const cwd = makeTempDir();
    writeQueueFile(cwd, "20260626T120000_first.md", "first");
    writeQueueFile(cwd, "20260626T120000_second.md", "second");

    await expect(loadQueue(resolveConfig(), { cwd })).rejects.toThrow(UsageError);
    await expect(loadQueue(resolveConfig(), { cwd })).rejects.toThrow(
      'Duplicate work item timestamp prefix "20260626T120000"'
    );
  });

  test("detects generated artifacts under the input directory", async () => {
    const cwd = makeTempDir();
    writeQueueFile(cwd, "state.json", "{}");

    await expect(loadQueue(resolveConfig(), { cwd })).rejects.toThrow(ContractError);
    await expect(loadQueue(resolveConfig(), { cwd })).rejects.toThrow(
      "Lupe-generated files must live under .lupe/"
    );
  });

  test("detects work item files under the internal directory", async () => {
    const cwd = makeTempDir();
    const internalWorkItemDir = join(cwd, INTERNAL_DIR, "work-items");
    mkdirSync(internalWorkItemDir, { recursive: true });
    writeFileSync(join(internalWorkItemDir, "20260626T120000_misplaced.md"), "misplaced");

    await expect(loadQueue(resolveConfig(), { cwd })).rejects.toThrow(ContractError);
    await expect(loadQueue(resolveConfig(), { cwd })).rejects.toThrow(
      "User-authored work items must live in lupe-queue/"
    );
  });

  test("ignores generated worktree copies under the internal directory", async () => {
    const cwd = makeTempDir();
    writeQueueFile(cwd, "20260626T120000_valid.md", "valid");
    const copiedQueueDir = join(
      cwd,
      INTERNAL_DIR,
      "worktrees",
      "20260626T120000_valid",
      "integration",
      INPUT_DIR
    );
    mkdirSync(copiedQueueDir, { recursive: true });
    writeFileSync(join(copiedQueueDir, "20260626T120000_valid.md"), "copied");

    const queue = await loadQueue(resolveConfig(), { cwd });

    expect(queue.items.map((item) => item.id)).toEqual(["20260626T120000_valid"]);
  });

  test("discovers fixture queue items", async () => {
    const cwd = makeTempDir();
    cpSync(join(testDir, "fixtures", "queue", INPUT_DIR), join(cwd, INPUT_DIR), {
      recursive: true
    });

    const queue = await loadQueue(resolveConfig(), { cwd });

    expect(queue.warnings).toEqual([]);
    expect(queue.items.map((item) => item.id)).toEqual([
      "20260625T090000_initial_scope",
      "20260625T103000_add_authentication"
    ]);
    expect(queue.items.every((item) => item.path.startsWith(cwd))).toBe(true);
    expect(queue.items.every((item) => item.fileHash.length === 64)).toBe(true);
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lupe-queue-"));
  tempDirs.push(dir);
  return dir;
}

function writeQueueFile(cwd: string, filename: string, contents: string): string {
  const inputDir = join(cwd, INPUT_DIR);
  mkdirSync(inputDir, { recursive: true });
  const path = join(inputDir, filename);
  writeFileSync(path, contents);
  return path;
}
