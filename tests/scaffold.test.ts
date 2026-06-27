import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { INPUT_DIR } from "../src/fs/contract";
import { loadQueue } from "../src/queue/discover";
import { createNewWorkItem, scaffoldInit, scaffoldMigrate } from "../src/scaffold/project";
import {
  formatUtcTimestamp,
  renderConfigTemplate,
  renderInitialWorkItemTemplate,
  renderNewWorkItemTemplate,
  slugifyTitle,
  workItemFilename
} from "../src/scaffold/templates";
import { loadState } from "../src/state/store";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("scaffold templates", () => {
  test("formats UTC timestamps and work item filenames", () => {
    const date = new Date("2026-06-26T19:51:02.000Z");

    expect(formatUtcTimestamp(date)).toBe("20260626T195102");
    expect(workItemFilename(date, "initial_scope")).toBe("20260626T195102_initial_scope.md");
  });

  test("slugifies titles for queue filenames", () => {
    expect(slugifyTitle("Fix signup redirect bug")).toBe("fix_signup_redirect_bug");
    expect(slugifyTitle("  Café & Billing!!! ")).toBe("cafe_billing");
    expect(slugifyTitle("!!!")).toBe("work_item");
  });

  test("renders concise config and work item templates", () => {
    expect(renderConfigTemplate()).toContain('from "@mattfca/lupe"');
    expect(renderConfigTemplate()).toContain('dir: "lupe-queue"');
    expect(renderConfigTemplate()).toContain("subagents: true");
    expect(renderInitialWorkItemTemplate()).toContain("# Initial Scope");
    expect(renderNewWorkItemTemplate("Fix Login")).toContain("# Fix Login");
    expect(renderNewWorkItemTemplate("Fix Login")).toContain("## Acceptance Criteria");
  });
});

describe("init scaffolding", () => {
  test("creates the Lupe tree and is idempotent", async () => {
    const cwd = makeTempDir("lupe-init-");

    const first = await scaffoldInit({
      cwd,
      now: new Date("2026-06-26T19:51:00.000Z")
    });
    const second = await scaffoldInit({
      cwd,
      now: new Date("2026-06-27T19:51:00.000Z")
    });

    expect(first.configCreated).toBe(true);
    expect(second.configCreated).toBe(false);
    expect(first.firstItemPath).toBe(join(cwd, INPUT_DIR, "20260626T195100_initial_scope.md"));
    expect(second.firstItemPath).toBeUndefined();
    expect(existsSync(join(cwd, ".lupe", "state.json"))).toBe(true);
    expect(existsSync(join(cwd, ".lupe", "STATE.md"))).toBe(true);
    expect(existsSync(join(cwd, ".cursor", "skills", "lupe-planning", "SKILL.md"))).toBe(true);
    expect(readdirSync(join(cwd, INPUT_DIR))).toEqual(["20260626T195100_initial_scope.md"]);

    const state = await loadState({ cwd });
    expect(state.workItems.map((item) => item.id)).toEqual(["20260626T195100_initial_scope"]);
    expect(state.workItems[0]?.status).toBe("discovered");
  });
});

describe("new work item scaffolding", () => {
  test("allocates the next UTC second when a timestamp prefix already exists", async () => {
    const cwd = makeTempDir("lupe-new-");
    await scaffoldInit({
      cwd,
      now: new Date("2026-06-26T19:51:00.000Z")
    });

    const result = await createNewWorkItem({
      cwd,
      title: "Add marker file",
      now: new Date("2026-06-26T19:51:00.000Z")
    });

    expect(result.id).toBe("20260626T195101_add_marker_file");
    expect(readdirSync(join(cwd, INPUT_DIR)).sort()).toEqual([
      "20260626T195100_initial_scope.md",
      "20260626T195101_add_marker_file.md"
    ]);
  });
});

describe("migrate scaffolding", () => {
  test("copies SCOPE.md into initial_scope and refreshes state", async () => {
    const cwd = makeTempDir("lupe-migrate-");
    writeFileSync(join(cwd, "SCOPE.md"), "# Legacy Scope\n\nBuild the thing.\n");

    const result = await scaffoldMigrate({
      cwd,
      now: new Date("2026-06-26T20:00:00.000Z")
    });

    expect(result.migratedItemPath).toBe(join(cwd, INPUT_DIR, "20260626T200000_initial_scope.md"));
    expect(readFileSync(result.migratedItemPath, "utf8")).toBe("# Legacy Scope\n\nBuild the thing.\n");
    expect(existsSync(join(cwd, "SCOPE.md"))).toBe(true);

    const queue = await loadQueue(result.cwd === cwd ? { ...defaultConfigForTest() } : defaultConfigForTest(), {
      cwd
    });
    expect(queue.items.map((item) => item.id)).toEqual(["20260626T200000_initial_scope"]);
    expect((await loadState({ cwd })).workItems[0]?.status).toBe("discovered");
  });

  test("reuses an existing migrated initial_scope item", async () => {
    const cwd = makeTempDir("lupe-migrate-existing-");
    mkdirSync(join(cwd, INPUT_DIR), { recursive: true });
    writeFileSync(join(cwd, "SCOPE.md"), "# Legacy Scope\n");
    writeFileSync(join(cwd, INPUT_DIR, "20260626T200000_initial_scope.md"), "# Existing\n");

    const result = await scaffoldMigrate({
      cwd,
      now: new Date("2026-06-26T20:00:00.000Z")
    });

    expect(result.migratedItemPath).toBe(join(cwd, INPUT_DIR, "20260626T200000_initial_scope.md"));
    expect(readdirSync(join(cwd, INPUT_DIR))).toEqual(["20260626T200000_initial_scope.md"]);
    expect(readFileSync(result.migratedItemPath, "utf8")).toBe("# Existing\n");
  });
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function defaultConfigForTest(): Parameters<typeof loadQueue>[0] {
  return {
    input: {
      dir: "lupe-queue",
      pattern: "^[0-9]{8}T[0-9]{6}_.+\\.md$",
      order: "chronological",
      onDuplicatePrefix: "error",
      onUnmatchedFile: "warn",
      immutableCompleted: true
    },
    agent: "cursor",
    mode: "auto",
    review: "per-item",
    autoAccept: false,
    onItemRejected: "halt",
    verify: ["true"],
    maxParallelPhases: 1,
    maxRepairAttempts: 1,
    subagents: true,
    skills: true
  };
}
