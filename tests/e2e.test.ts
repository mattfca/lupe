import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createMockAgentAdapter } from "../src/agent";
import { createAcceptCommand } from "../src/cli/commands/accept";
import { initCommand } from "../src/cli/commands/init";
import { newCommand } from "../src/cli/commands/new";
import { createPlanCommand } from "../src/cli/commands/plan";
import { reviewCommand } from "../src/cli/commands/review";
import { createRunCommand } from "../src/cli/commands/run";
import { INPUT_DIR } from "../src/fs/contract";
import { runGit } from "../src/git";
import type { OpenPullRequestOptions, PullRequestInfo, PullRequestProvider } from "../src/git/pr";
import { loadState } from "../src/state/store";
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

describe("onboarding e2e", () => {
  test("runs init -> new -> plan -> run -> review -> accept with mocks", async () => {
    const cwd = makeTempDir();
    const io = captureIo();
    const logger = createLogger({
      stdout: io.stdout,
      stderr: io.stderr
    });
    const flags = commandFlags(cwd);

    expect(await initCommand.run({ args: [], flags, logger })).toBe(0);
    expect(await newCommand.run({ args: ["Add marker file"], flags, logger })).toBe(0);

    writeFileSync(
      join(cwd, "lupe.config.ts"),
      `export default {
  verify: ["test -f e2e.txt"],
  maxParallelPhases: 1,
  maxRepairAttempts: 1,
  subagents: false,
  skills: false
};
`
    );
    await initGitRepo(cwd);

    const agent = createMockAgentAdapter(
      {
        phases: [
          {
            id: "phase-001",
            title: "Create marker",
            goal: "Create the marker file",
            scope: ["Write e2e.txt"],
            acceptanceHints: ["Verification finds e2e.txt"]
          }
        ]
      },
      async (_workItem, _phase, context) => {
        writeFileSync(join(context.worktreePath, "e2e.txt"), "ok\n");
        return { output: "created e2e.txt" };
      }
    );
    const prProvider = new FakePullRequestProvider();

    expect(await createPlanCommand({ agent }).run({ args: [], flags, logger })).toBe(0);
    expect(await createRunCommand({ agent }).run({ args: [], flags, logger })).toBe(0);
    expect(await reviewCommand.run({ args: [], flags, logger })).toBe(0);
    expect(await createAcceptCommand({ prProvider }).run({ args: [], flags, logger })).toBe(0);

    const queueFiles = readdirSync(join(cwd, INPUT_DIR)).sort();
    const acceptedId = queueFiles[0]?.replace(/\.md$/, "");
    const state = await loadState({ cwd });

    expect(queueFiles).toHaveLength(2);
    expect(existsSync(join(cwd, ".lupe", "state.json"))).toBe(true);
    expect(existsSync(join(cwd, ".lupe", "STATE.md"))).toBe(true);
    expect(existsSync(join(cwd, ".lupe", "work-items", acceptedId ?? "", "plan.json"))).toBe(true);
    expect(existsSync(join(cwd, ".lupe", "work-items", acceptedId ?? "", "final-review", "summary.md"))).toBe(
      true
    );
    expect(readFileSync(join(cwd, ".lupe", "STATE.md"), "utf8")).toContain("[accepted]");
    expect(state.workItems[0]?.status).toBe("accepted");
    expect(state.current.workItem).toBe(queueFiles[1]?.replace(/\.md$/, ""));
    expect(prProvider.calls).toHaveLength(1);
    expect(prProvider.calls[0]).toMatchObject({
      base: "main",
      head: `lupe/${acceptedId}`,
      title: `Lupe: ${acceptedId}`
    });
  });
});

class FakePullRequestProvider implements PullRequestProvider {
  readonly calls: OpenPullRequestOptions[] = [];

  async openPullRequest(options: OpenPullRequestOptions): Promise<PullRequestInfo> {
    this.calls.push(options);
    return {
      provider: "fake",
      url: "https://example.com/pull/456",
      base: options.base,
      head: options.head,
      number: 456,
      title: options.title
    };
  }
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lupe-e2e-"));
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

function commandFlags(cwd: string): {
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
