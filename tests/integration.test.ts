import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG, type LupeConfig } from "../src/config/schema";
import { createPhaseWorktree, runGit } from "../src/git";
import {
  generateBatchReviewPackage,
  selectBatchReviewItems
} from "../src/integration/batch";
import {
  IntegrationConflictError,
  mergeVerifiedPhases
} from "../src/integration/merge";
import {
  FINAL_REVIEW_FILES,
  integrateAndReviewWorkItem,
  renderSummaryMarkdown
} from "../src/integration/review";
import type { PersistedPlan } from "../src/planner/persist";
import type { WorkItem } from "../src/queue/workItem";
import type { PhaseState, State, WorkItemState } from "../src/state/schema";
import { createInitialState } from "../src/state/store";
import type { VerifyRunResult } from "../src/verify/run";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("integration merge and review", () => {
  test("merges verified phase branches, re-verifies, and writes final review artifacts", async () => {
    const cwd = makeTempDir();
    await initGitRepo(cwd);
    const workItem = workItemFixture(cwd, "20260626T160000_integrate_me");
    const plan = planFixture(workItem);
    const phases = verifiedPhases(workItem.id, ["phase-001", "phase-002"]);
    await writePhaseFile(cwd, workItem.id, "phase-001", "phase-001.txt", "one\n");
    await writePhaseFile(cwd, workItem.id, "phase-002", "phase-002.txt", "two\n");

    const result = await integrateAndReviewWorkItem({
      cwd,
      config: testConfig({
        verify: ["test -f phase-001.txt", "test -f phase-002.txt"]
      }),
      workItem,
      itemState: itemState(workItem, phases),
      plan,
      generatedAt: new Date("2026-06-26T16:30:00.000Z")
    });

    expect(result.merge.branch).toBe(`lupe/${workItem.id}`);
    expect(result.verification.passed).toBe(true);
    expect(existsSync(join(result.merge.worktreePath, "phase-001.txt"))).toBe(true);
    expect(existsSync(join(result.merge.worktreePath, "phase-002.txt"))).toBe(true);
    expect((await runGit(cwd, ["branch", "--list", `lupe/${workItem.id}`])).stdout).toContain(
      `lupe/${workItem.id}`
    );
    expect((await runGit(cwd, ["branch", "--list", `lupe/${workItem.id}/phase-001`])).stdout).toBe("");

    for (const file of FINAL_REVIEW_FILES) {
      expect(existsSync(join(result.review.paths.dir, file))).toBe(true);
    }
    expect(readFileSync(result.review.paths.summaryPath, "utf8")).toContain("Integrated verification: passed");
    expect(readFileSync(result.review.paths.verificationPath, "utf8")).toContain("Command: test -f phase-001.txt");
    expect(readFileSync(result.review.paths.diffSummaryPath, "utf8")).toContain("phase-002.txt");
  });

  test("reports deliberate merge conflicts with actionable details", async () => {
    const cwd = makeTempDir();
    writeFileSync(join(cwd, "shared.txt"), "base\n");
    await initGitRepo(cwd);
    const workItemId = "20260626T170000_conflict_me";
    const phases = verifiedPhases(workItemId, ["phase-001", "phase-002"]);
    await writePhaseFile(cwd, workItemId, "phase-001", "shared.txt", "one\n");
    await writePhaseFile(cwd, workItemId, "phase-002", "shared.txt", "two\n");

    try {
      await mergeVerifiedPhases({
        repoDir: cwd,
        workItemId,
        phases
      });
      throw new Error("expected merge to conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(IntegrationConflictError);
      const conflict = error as IntegrationConflictError;
      expect(conflict.message).toContain("Integration conflict");
      expect(conflict.message).toContain("shared.txt");
      expect(conflict.message).toContain("Resolve the conflicts");
      expect(conflict.details.phaseBranch).toBe(`lupe/${workItemId}/phase-002`);
      expect(conflict.details.conflictedFiles).toEqual(["shared.txt"]);
    }
  });

  test("renders summary markdown as a stable snapshot", () => {
    const cwd = "/tmp/lupe-summary";
    const workItem = workItemFixture(cwd, "20260626T180000_snapshot_me");
    const plan = planFixture(workItem);
    const phases = verifiedPhases(workItem.id, ["phase-001", "phase-002"]);

    expect(
      renderSummaryMarkdown({
        generatedAt: new Date("2026-06-26T18:30:00.000Z"),
        reviewMode: "per-item",
        workItem,
        itemState: itemState(workItem, phases),
        plan,
        merge: {
          workItemId: workItem.id,
          branch: `lupe/${workItem.id}`,
          temporaryBranch: `lupe-integration/${workItem.id}`,
          worktreePath: `${cwd}/.lupe/worktrees/${workItem.id}/integration`,
          baseRef: "HEAD",
          baseCommit: "base-sha",
          integrationCommit: "integration-sha",
          phases: [
            {
              id: "phase-001",
              branch: `lupe/${workItem.id}/phase-001`,
              commit: "phase-001-sha",
              skipped: false
            },
            {
              id: "phase-002",
              branch: `lupe/${workItem.id}/phase-002`,
              commit: "phase-002-sha",
              skipped: false
            }
          ],
          mergedPhases: []
        },
        verification: passedVerification()
      })
    ).toBe(`# Final Review: 20260626T180000_snapshot_me

- Generated: 2026-06-26T18:30:00.000Z
- Review mode: per-item
- Integration branch: lupe/20260626T180000_snapshot_me
- Integration commit: integration-sha
- Integrated verification: passed
- Phases: 2 verified, 0 skipped

## Work Item

- Source: ${cwd}/lupe-queue/20260626T180000_snapshot_me.md
- File hash: hash-20260626T180000_snapshot_me

## Plan

- Generated: 2026-06-26T00:00:00.000Z
- Phase count: 2

## Merge

- Base: HEAD (base-sha)
- Merged branches: 0

## Review Checklist

- Inspect diff-summary.md for the integrated code delta.
- Inspect verification.md for the integrated verification run.
- Inspect risks.md and unresolved-items.md before accepting.
`);
  });
});

describe("batch review aggregation", () => {
  test("aggregates multiple verified items into a batch review package", async () => {
    const cwd = makeTempDir();
    const state: State = {
      ...createInitialState({ ...DEFAULT_CONFIG, review: "batch" }),
      current: {
        status: "active",
        workItem: "20260626T190000_first",
        integrationBranch: "lupe/20260626T190000_first"
      },
      workItems: [
        {
          id: "20260626T190000_first",
          status: "verified",
          planned: true,
          verified: true,
          fileHash: "first-hash",
          finalReview: ".lupe/work-items/20260626T190000_first/final-review"
        },
        {
          id: "20260626T191000_second",
          status: "verified",
          planned: true,
          verified: true,
          fileHash: "second-hash"
        }
      ]
    };

    const batch = await generateBatchReviewPackage({
      cwd,
      items: selectBatchReviewItems(state),
      generatedAt: new Date("2026-06-26T19:30:00.000Z")
    });

    expect(batch.itemCount).toBe(2);
    expect(existsSync(batch.paths.summaryPath)).toBe(true);
    expect(readFileSync(batch.paths.summaryPath, "utf8")).toContain("20260626T190000_first");
    expect(readFileSync(batch.paths.unresolvedItemsPath, "utf8")).toContain(
      "20260626T191000_second: missing per-item review package"
    );
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lupe-integration-"));
  tempDirs.push(dir);
  return dir;
}

async function initGitRepo(cwd: string): Promise<void> {
  if (!existsSync(join(cwd, "README.md"))) {
    writeFileSync(join(cwd, "README.md"), "# temp repo\n");
  }
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
}

async function writePhaseFile(
  cwd: string,
  workItemId: string,
  phaseId: string,
  filename: string,
  contents: string
): Promise<void> {
  const worktree = await createPhaseWorktree({
    repoDir: cwd,
    workItemId,
    phaseId
  });
  writeFileSync(join(worktree.path, filename), contents);
}

function testConfig(overrides: Partial<LupeConfig> = {}): LupeConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    input: {
      ...DEFAULT_CONFIG.input,
      ...(overrides.input ?? {})
    },
    verify: overrides.verify ?? [...DEFAULT_CONFIG.verify]
  };
}

function workItemFixture(cwd: string, id: string): WorkItem {
  return {
    id,
    timestamp: id.slice(0, 15),
    description: id.slice(16),
    path: join(cwd, "lupe-queue", `${id}.md`),
    contents: `# ${id}\n`,
    fileHash: `hash-${id}`
  };
}

function planFixture(workItem: WorkItem): PersistedPlan {
  return {
    version: 1,
    generatedAt: "2026-06-26T00:00:00.000Z",
    workItem: {
      id: workItem.id,
      path: workItem.path,
      fileHash: workItem.fileHash
    },
    phases: [
      {
        id: "phase-001",
        title: "First",
        goal: "Do the first part.",
        scope: ["first"],
        deps: [],
        acceptanceHints: ["first passes"],
        status: "ready",
        briefPath: "phases/phase-001.md"
      },
      {
        id: "phase-002",
        title: "Second",
        goal: "Do the second part.",
        scope: ["second"],
        deps: ["phase-001"],
        acceptanceHints: ["second passes"],
        status: "blocked",
        briefPath: "phases/phase-002.md"
      }
    ]
  };
}

function verifiedPhases(workItemId: string, ids: string[]): PhaseState[] {
  return ids.map((id, index) => ({
    id,
    status: "verified",
    deps: index === 0 ? [] : [ids[index - 1] as string],
    branch: `lupe/${workItemId}/${id}`
  }));
}

function itemState(workItem: WorkItem, phases: PhaseState[]): WorkItemState {
  return {
    id: workItem.id,
    status: "verified",
    planned: true,
    verified: true,
    fileHash: workItem.fileHash,
    phases
  };
}

function passedVerification(): VerifyRunResult {
  return {
    passed: true,
    commands: [
      {
        command: "bun test",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        durationMs: 12,
        startedAt: "2026-06-26T18:00:00.000Z",
        completedAt: "2026-06-26T18:00:00.012Z"
      }
    ],
    durationMs: 12,
    startedAt: "2026-06-26T18:00:00.000Z",
    completedAt: "2026-06-26T18:00:00.012Z"
  };
}
