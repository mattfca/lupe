import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createAcceptCommand } from "../src/cli/commands/accept";
import { acknowledgeCommand } from "../src/cli/commands/acknowledge";
import { DEFAULT_CONFIG, type LupeConfig } from "../src/config/schema";
import { INPUT_DIR } from "../src/fs/contract";
import { runGit } from "../src/git";
import type { OpenPullRequestOptions, PullRequestInfo, PullRequestProvider } from "../src/git/pr";
import {
  acceptWorkItem,
  recordRejected,
  rejectWorkItem,
  skipWorkItem
} from "../src/lifecycle/accept";
import { advanceQueue, applyTerminalQueuePolicy } from "../src/lifecycle/advance";
import {
  acknowledgeAcceptedFileDrift,
  detectAcceptedFileDrift
} from "../src/lifecycle/immutability";
import { hashContents } from "../src/queue/hash";
import type { WorkItem } from "../src/queue/workItem";
import type { State, WorkItemState } from "../src/state/schema";
import { createInitialState, loadState, saveState } from "../src/state/store";
import { createLogger } from "../src/util/logger";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("accept lifecycle", () => {
  test("opens a PR, records accepted state, cleans worktrees, and advances", async () => {
    const cwd = makeTempDir();
    await initGitRepo(cwd);
    const first = writeQueueFile(cwd, "20260626T200000_accept_me.md", "# Accept me\n");
    writeQueueFile(cwd, "20260626T201000_next.md", "# Next\n");
    const worktreePath = join(cwd, ".lupe", "worktrees", "20260626T200000_accept_me", "integration");
    mkdirSync(join(cwd, ".lupe", "worktrees", "20260626T200000_accept_me"), { recursive: true });
    await runGit(cwd, [
      "worktree",
      "add",
      "--force",
      "-B",
      "lupe/20260626T200000_accept_me",
      worktreePath,
      "HEAD"
    ]);
    const state = createInitialState();
    state.current = {
      status: "active",
      workItem: "20260626T200000_accept_me",
      integrationBranch: "lupe/20260626T200000_accept_me"
    };
    state.workItems = [
      {
        id: "20260626T200000_accept_me",
        status: "in_review",
        planned: true,
        verified: true,
        fileHash: "old-hash",
        finalReview: ".lupe/work-items/20260626T200000_accept_me/final-review"
      },
      {
        id: "20260626T201000_next",
        status: "discovered",
        planned: false,
        verified: false,
        fileHash: "next-hash"
      }
    ];
    await saveState(state, { cwd });
    const provider = new FakePullRequestProvider();

    const result = await acceptWorkItem({
      cwd,
      config: DEFAULT_CONFIG,
      prProvider: provider,
      now: new Date("2026-06-26T20:30:00.000Z")
    });
    const saved = await loadState({ cwd });

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({
      base: "main",
      head: "lupe/20260626T200000_accept_me",
      title: "Lupe: 20260626T200000_accept_me"
    });
    expect(result.pr.url).toBe("https://example.com/pull/123");
    expect(saved.workItems[0]).toMatchObject({
      status: "accepted",
      completedAt: "2026-06-26T20:30:00.000Z",
      fileHash: hashContents(readFileSync(first, "utf8")),
      pr: {
        provider: "fake",
        url: "https://example.com/pull/123",
        base: "main",
        head: "lupe/20260626T200000_accept_me",
        openedAt: "2026-06-26T20:30:00.000Z"
      }
    });
    expect(saved.current).toEqual({
      status: "active",
      workItem: "20260626T201000_next"
    });
    expect(existsSync(worktreePath)).toBe(false);
    expect((await runGit(cwd, ["worktree", "list", "--porcelain"])).stdout).not.toContain(worktreePath);
  });

  test("reject marks the item, records the reason, halts, and cleans worktrees", async () => {
    const cwd = makeTempDir();
    await initGitRepo(cwd);
    const worktreePath = join(cwd, ".lupe", "worktrees", "20260626T210000_reject_me", "integration");
    mkdirSync(join(cwd, ".lupe", "worktrees", "20260626T210000_reject_me"), { recursive: true });
    await runGit(cwd, [
      "worktree",
      "add",
      "--force",
      "-B",
      "lupe/20260626T210000_reject_me",
      worktreePath,
      "HEAD"
    ]);
    const state = createInitialState();
    state.current = {
      status: "active",
      workItem: "20260626T210000_reject_me"
    };
    state.workItems = [itemState("20260626T210000_reject_me", "in_review")];
    await saveState(state, { cwd });

    const result = await rejectWorkItem({
      cwd,
      config: DEFAULT_CONFIG,
      reason: "needs changes",
      now: new Date("2026-06-26T21:30:00.000Z")
    });
    const saved = await loadState({ cwd });

    expect(result.workItemId).toBe("20260626T210000_reject_me");
    expect(saved.workItems[0]).toMatchObject({
      status: "rejected",
      rejectedAt: "2026-06-26T21:30:00.000Z",
      rejectionReason: "needs changes"
    });
    expect(saved.current).toEqual({
      status: "halted",
      workItem: "20260626T210000_reject_me"
    });
    expect(existsSync(worktreePath)).toBe(false);
  });

  test("autoAccept allows accepting the verified current item", async () => {
    const cwd = makeTempDir();
    writeQueueFile(cwd, "20260626T213000_auto_accept.md", "# Auto accept\n");
    const state = createInitialState({
      ...DEFAULT_CONFIG,
      autoAccept: true
    });
    state.current = {
      status: "active",
      workItem: "20260626T213000_auto_accept",
      integrationBranch: "lupe/20260626T213000_auto_accept"
    };
    state.workItems = [itemState("20260626T213000_auto_accept", "verified")];
    await saveState(state, {
      cwd,
      config: {
        ...DEFAULT_CONFIG,
        autoAccept: true
      }
    });

    await acceptWorkItem({
      cwd,
      config: {
        ...DEFAULT_CONFIG,
        autoAccept: true
      },
      prProvider: new FakePullRequestProvider(),
      now: new Date("2026-06-26T21:45:00.000Z")
    });

    expect((await loadState({ cwd })).workItems[0]?.status).toBe("accepted");
  });

  test("skip marks the item and advances", async () => {
    const cwd = makeTempDir();
    const state = createInitialState();
    state.current = {
      status: "active",
      workItem: "20260626T220000_skip_me"
    };
    state.workItems = [
      itemState("20260626T220000_skip_me", "planned"),
      itemState("20260626T221000_next", "discovered")
    ];
    await saveState(state, { cwd });

    await skipWorkItem({
      cwd,
      config: DEFAULT_CONFIG,
      now: new Date("2026-06-26T22:30:00.000Z")
    });
    const saved = await loadState({ cwd });

    expect(saved.workItems[0]).toMatchObject({
      status: "skipped",
      skippedAt: "2026-06-26T22:30:00.000Z"
    });
    expect(saved.current).toEqual({
      status: "active",
      workItem: "20260626T221000_next"
    });
  });
});

describe("queue advancement policy", () => {
  test("advances accepted and skipped items but halts rejected items", () => {
    const state = stateWith([
      itemState("item-1", "accepted"),
      itemState("item-2", "discovered")
    ]);

    expect(advanceQueue(state).current).toEqual({ status: "active", workItem: "item-2" });
    expect(applyTerminalQueuePolicy(state, "item-1", "accepted").current).toEqual({
      status: "active",
      workItem: "item-2"
    });
    expect(applyTerminalQueuePolicy(state, "item-1", "skipped").current).toEqual({
      status: "active",
      workItem: "item-2"
    });
    expect(recordRejected(stateWith(itemState("item-1", "in_review")), "item-1", {
      rejectedAt: "2026-06-26T00:00:00.000Z"
    }).current).toEqual({
      status: "halted",
      workItem: "item-1"
    });
  });
});

describe("accepted file immutability", () => {
  test("detects drift and acknowledge rehashes the accepted file", () => {
    const accepted = {
      ...itemState("20260626T230000_drift", "accepted"),
      fileHash: hashContents("original")
    };
    const queueItem = workItem("20260626T230000_drift", "changed");
    const state = stateWith(accepted);

    const drifts = detectAcceptedFileDrift([queueItem], state);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.message).toContain("has changed since acceptance");
    expect(drifts[0]?.recommendation).toContain("lupe acknowledge 20260626T230000_drift");

    const acknowledged = acknowledgeAcceptedFileDrift(
      state,
      [queueItem],
      "20260626T230000_drift",
      { acknowledgedAt: new Date("2026-06-26T23:30:00.000Z") }
    );
    expect(acknowledged.workItems[0]?.fileHash).toBe(queueItem.fileHash);
    expect(detectAcceptedFileDrift([queueItem], acknowledged)).toEqual([]);
    expect(acknowledged.decisions[0]?.note).toContain("Acknowledged accepted-file edit");
  });
});

describe("lifecycle CLI commands", () => {
  test("accept command uses an injected PR provider", async () => {
    const cwd = makeTempDir();
    writeQueueFile(cwd, "20260627T000000_cli_accept.md", "# CLI accept\n");
    const state = createInitialState();
    state.current = {
      status: "active",
      workItem: "20260627T000000_cli_accept",
      integrationBranch: "lupe/20260627T000000_cli_accept"
    };
    state.workItems = [itemState("20260627T000000_cli_accept", "in_review")];
    await saveState(state, { cwd });
    const io = captureIo();
    const command = createAcceptCommand({
      prProvider: new FakePullRequestProvider()
    });

    const exitCode = await command.run({
      args: [],
      flags: flags(cwd),
      logger: createLogger({
        stdout: io.stdout,
        stderr: io.stderr
      })
    });

    expect(exitCode).toBe(0);
    expect(io.out()).toContain("Accepted 20260627T000000_cli_accept; opened PR https://example.com/pull/123.");
    expect((await loadState({ cwd })).workItems[0]?.status).toBe("accepted");
  });

  test("acknowledge command rehashes accepted drift", async () => {
    const cwd = makeTempDir();
    writeQueueFile(cwd, "20260627T010000_cli_ack.md", "changed");
    const state = createInitialState();
    state.workItems = [
      {
        ...itemState("20260627T010000_cli_ack", "accepted"),
        fileHash: hashContents("original")
      }
    ];
    await saveState(state, { cwd });
    const io = captureIo();

    const exitCode = await acknowledgeCommand.run({
      args: ["20260627T010000_cli_ack"],
      flags: flags(cwd),
      logger: createLogger({
        stdout: io.stdout,
        stderr: io.stderr
      })
    });
    const saved = await loadState({ cwd });

    expect(exitCode).toBe(0);
    expect(saved.workItems[0]?.fileHash).toBe(hashContents("changed"));
    expect(io.out()).toContain("Acknowledged 20260627T010000_cli_ack");
  });
});

class FakePullRequestProvider implements PullRequestProvider {
  readonly calls: OpenPullRequestOptions[] = [];

  async openPullRequest(options: OpenPullRequestOptions): Promise<PullRequestInfo> {
    this.calls.push(options);
    return {
      provider: "fake",
      url: "https://example.com/pull/123",
      base: options.base,
      head: options.head,
      number: 123,
      title: options.title
    };
  }
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lupe-lifecycle-"));
  tempDirs.push(dir);
  return dir;
}

async function initGitRepo(cwd: string): Promise<void> {
  writeFileSync(join(cwd, "README.md"), "# temp repo\n");
  await runGit(cwd, ["init"]);
  await runGit(cwd, ["add", "."]);
  await runGit(cwd, [
    "-c",
    "user.name=Lupe Test",
    "-c",
    "user.email=lupe@example.com",
    "commit",
    "-m",
    "initial"
  ]);
  await runGit(cwd, ["branch", "-M", "main"]);
}

function writeQueueFile(cwd: string, filename: string, contents: string): string {
  const inputDir = join(cwd, INPUT_DIR);
  mkdirSync(inputDir, { recursive: true });
  const path = join(inputDir, filename);
  writeFileSync(path, contents);
  return path;
}

function itemState(id: string, status: WorkItemState["status"]): WorkItemState {
  return {
    id,
    status,
    planned: ["planned", "running", "verified", "in_review", "accepted"].includes(status),
    verified: ["verified", "in_review", "accepted"].includes(status),
    fileHash: `${id}-hash`
  };
}

function stateWith(items: WorkItemState | WorkItemState[]): State {
  return {
    ...createInitialState(),
    workItems: Array.isArray(items) ? items : [items]
  };
}

function workItem(id: string, contents: string): WorkItem {
  return {
    id,
    timestamp: id.slice(0, 15),
    description: id.slice(16),
    path: `/tmp/${id}.md`,
    contents,
    fileHash: hashContents(contents)
  };
}

function flags(cwd: string): {
  cwd: string;
  verbose: false;
  quiet: false;
  help: false;
  version: false;
} {
  return {
    cwd,
    verbose: false,
    quiet: false,
    help: false,
    version: false
  };
}

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
