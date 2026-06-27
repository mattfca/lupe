import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgv, runCli } from "../src/cli/index";
import { createInitialState, saveState } from "../src/state/store";

describe("CLI router", () => {
  test("prints general help", async () => {
    const io = captureIo();
    const exitCode = await runCli({
      argv: ["--help"],
      packageVersion: "9.9.9",
      ...io
    });

    expect(exitCode).toBe(0);
    expect(io.out()).toContain("Usage:");
    expect(io.out()).toContain("acknowledge");
  });

  test("prints version", async () => {
    const io = captureIo();
    const exitCode = await runCli({
      argv: ["--version"],
      packageVersion: "9.9.9",
      ...io
    });

    expect(exitCode).toBe(0);
    expect(io.out()).toBe("9.9.9\n");
  });

  test("dispatches registered commands", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lupe-cli-init-"));
    const io = captureIo();
    try {
      const exitCode = await runCli({
        argv: ["--cwd", cwd, "init"],
        packageVersion: "9.9.9",
        ...io
      });

      expect(exitCode).toBe(0);
      expect(io.out()).toContain("Initialized Lupe");
      expect(io.out()).toContain("First work item:");
      expect(io.err()).toBe("");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("prints the current review package summary", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lupe-cli-review-"));
    try {
      const reviewDir = join(cwd, ".lupe", "work-items", "item-1", "final-review");
      mkdirSync(reviewDir, { recursive: true });
      writeFileSync(join(reviewDir, "summary.md"), "# Final Review: item-1\n\nReady.\n");
      const state = createInitialState();
      state.current = {
        status: "active",
        workItem: "item-1",
        integrationBranch: "lupe/item-1"
      };
      state.workItems = [
        {
          id: "item-1",
          status: "in_review",
          planned: true,
          verified: true,
          fileHash: "hash",
          finalReview: ".lupe/work-items/item-1/final-review"
        }
      ];
      await saveState(state, { cwd });

      const io = captureIo();
      const exitCode = await runCli({
        argv: ["--cwd", cwd, "review"],
        packageVersion: "9.9.9",
        ...io
      });

      expect(exitCode).toBe(0);
      expect(io.out()).toContain("Review package: .lupe/work-items/item-1/final-review");
      expect(io.out()).toContain("# Final Review: item-1");
      expect(io.out()).toContain("summary.md");
      expect(io.err()).toBe("");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("returns a helpful unknown command error", async () => {
    const io = captureIo();
    const exitCode = await runCli({
      argv: ["wat"],
      packageVersion: "9.9.9",
      ...io
    });

    expect(exitCode).toBe(2);
    expect(io.err()).toContain('Unknown command "wat"');
    expect(io.err()).toContain("lupe --help");
  });

  test("parses global flags", () => {
    const parsed = parseArgv(
      ["--cwd", "demo", "--verbose", "run", "--", "--future-command-flag"],
      "/repo"
    );

    expect(parsed.commandName).toBe("run");
    expect(parsed.commandArgs).toEqual(["--future-command-flag"]);
    expect(parsed.flags.cwd).toBe("/repo/demo");
    expect(parsed.flags.verbose).toBe(true);
  });
});

function captureIo(): {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  out: () => string;
  err: () => string;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
    out: () => stdout.join(""),
    err: () => stderr.join("")
  };
}
