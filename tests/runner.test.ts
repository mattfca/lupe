import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createMockAgentAdapter } from "../src/agent";
import { DEFAULT_CONFIG, type LupeConfig } from "../src/config/schema";
import { INPUT_DIR } from "../src/fs/contract";
import { runGit } from "../src/git";
import { buildPhaseGraph } from "../src/planner/graph";
import { persistPlanArtifacts } from "../src/planner/persist";
import { loadQueue } from "../src/queue/discover";
import type { WorkItem } from "../src/queue/workItem";
import { createRunArtifacts, completeRunArtifacts } from "../src/runner/artifacts";
import { runEngine } from "../src/runner/engine";
import { runPhaseScheduler, selectReadyPhases } from "../src/runner/scheduler";
import type { PhaseState, State } from "../src/state/schema";
import { createInitialState, loadState, saveState } from "../src/state/store";
import { runVerifyCommands } from "../src/verify/run";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("runner scheduler", () => {
  test("selects only ready phases whose dependencies are verified", () => {
    const phases: PhaseState[] = [
      phaseState("phase-001", "verified"),
      phaseState("phase-002", "ready", ["phase-001"]),
      phaseState("phase-003", "ready"),
      phaseState("phase-004", "ready", ["phase-999"])
    ];

    expect(selectReadyPhases({ phases, maxParallelPhases: 1 }).map((phase) => phase.id)).toEqual([
      "phase-002"
    ]);
    expect(
      selectReadyPhases({
        phases,
        maxParallelPhases: 3,
        runningPhaseIds: new Set(["phase-003"])
      }).map((phase) => phase.id)
    ).toEqual(["phase-002"]);
  });

  test("runs ready phases with bounded concurrency and unlocks dependents", async () => {
    let phases: PhaseState[] = [
      phaseState("phase-001", "ready"),
      phaseState("phase-002", "ready"),
      phaseState("phase-003", "blocked", ["phase-001", "phase-002"])
    ];
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;

    await runPhaseScheduler({
      maxParallelPhases: 2,
      phases: () => phases,
      async runPhase(phase) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push(`start ${phase.id}`);
        phases = phases.map((candidate) =>
          candidate.id === phase.id ? { ...candidate, status: "running" } : candidate
        );

        await delay(5);
        active -= 1;
        events.push(`end ${phase.id}`);
        phases = refreshTestReadiness(
          phases.map((candidate) =>
            candidate.id === phase.id ? { ...candidate, status: "verified" } : candidate
          )
        );

        return phase.id;
      }
    });

    expect(maxActive).toBe(2);
    expect(events.indexOf("start phase-003")).toBeGreaterThan(events.indexOf("end phase-001"));
    expect(events.indexOf("start phase-003")).toBeGreaterThan(events.indexOf("end phase-002"));
    expect(phases.map((phase) => phase.status)).toEqual(["verified", "verified", "verified"]);
  });
});

describe("run artifacts", () => {
  test("allocates append-only run directories without mutating prior attempts", async () => {
    const cwd = makeTempDir();
    const first = await createRunArtifacts({
      cwd,
      workItemId: "20260626T120000_item",
      prompt: "first prompt"
    });
    await completeRunArtifacts({
      paths: first,
      output: "first output",
      diffSummary: "first diff",
      subagents: "first subagents"
    });

    const second = await createRunArtifacts({
      cwd,
      workItemId: "20260626T120000_item",
      prompt: "second prompt"
    });

    expect(first.runId).toBe("run-001");
    expect(second.runId).toBe("run-002");
    expect(readdirSync(join(cwd, ".lupe", "work-items", "20260626T120000_item", "runs"))).toEqual([
      "run-001",
      "run-002"
    ]);
    expect(readFileSync(first.promptPath, "utf8")).toBe("first prompt\n");
    expect(readFileSync(second.promptPath, "utf8")).toBe("second prompt\n");
    expect(readFileSync(second.verificationPath, "utf8")).toContain("Phase 06");
  });
});

describe("verify command runner", () => {
  test("captures passing command output and duration", async () => {
    const cwd = makeTempDir();

    const result = await runVerifyCommands({
      cwd,
      commands: ["printf verified"]
    });

    expect(result.passed).toBe(true);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.command).toBe("printf verified");
    expect(result.commands[0]?.exitCode).toBe(0);
    expect(result.commands[0]?.stdout).toBe("verified");
    expect(result.commands[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("captures failing output and stops by default", async () => {
    const cwd = makeTempDir();

    const result = await runVerifyCommands({
      cwd,
      commands: ["printf before", "printf fail >&2; exit 7", "printf after"]
    });

    expect(result.passed).toBe(false);
    expect(result.commands).toHaveLength(2);
    expect(result.failedCommand?.command).toBe("printf fail >&2; exit 7");
    expect(result.failedCommand?.exitCode).toBe(7);
    expect(result.failedCommand?.stderr).toBe("fail");
  });
});

describe("run engine integration", () => {
  test("creates branches, worktrees, artifacts, and keeps DAG state consistent", async () => {
    const cwd = makeTempDir();
    writeQueueFile(cwd, "20260626T120000_run_me.md", "# Run me\n\nImplement the thing.");
    await initGitRepo(cwd);

    const config = testConfig({
      maxParallelPhases: 2,
      subagents: false,
      skills: false,
      verify: ['test -n "$(ls phase-*.txt 2>/dev/null)"']
    });
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    const agent = createMockAgentAdapter(
      {
        phases: [
          { id: "phase-001", title: "First", goal: "Do first" },
          { id: "phase-002", title: "Second", goal: "Do second" },
          { id: "phase-003", title: "Third", goal: "Do third", deps: ["phase-001", "phase-002"] }
        ]
      },
      async (_workItem, phase, context) => {
        expect(context.subagents).toBe(false);
        expect(context.skills).toBe(false);
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push(`start ${phase.id}`);
        await writeFile(join(context.worktreePath, `${phase.id}.txt`), `changed ${phase.id}\n`);
        await delay(phase.id === "phase-003" ? 1 : 10);
        events.push(`end ${phase.id}`);
        active -= 1;
        return {
          output: `completed ${phase.id}`,
          subagents: `subagents ${phase.id}`
        };
      }
    );

    const result = await runEngine({
      cwd,
      config,
      agent
    });

    const state = await loadState({ cwd, config });
    const item = state.workItems[0];
    const runsDir = join(cwd, ".lupe", "work-items", "20260626T120000_run_me", "runs");

    expect(result.workItemId).toBe("20260626T120000_run_me");
    expect(new Set(result.phasesRun)).toEqual(new Set(["phase-001", "phase-002", "phase-003"]));
    expect(maxActive).toBe(2);
    expect(events.indexOf("start phase-003")).toBeGreaterThan(events.indexOf("end phase-001"));
    expect(events.indexOf("start phase-003")).toBeGreaterThan(events.indexOf("end phase-002"));
    expect(item?.status).toBe("in_review");
    expect(item?.finalReview).toBe(".lupe/work-items/20260626T120000_run_me/final-review");
    expect(item?.phases?.map((phase) => phase.status)).toEqual(["verified", "verified", "verified"]);
    expect(item?.phases?.map((phase) => phase.branch)).toEqual([
      "lupe/20260626T120000_run_me/phase-001",
      "lupe/20260626T120000_run_me/phase-002",
      "lupe/20260626T120000_run_me/phase-003"
    ]);
    expect(existsSync(join(cwd, ".lupe", "worktrees", "20260626T120000_run_me", "phase-001"))).toBe(false);
    expect(existsSync(join(cwd, ".lupe", "worktrees", "20260626T120000_run_me", "integration"))).toBe(true);
    expect((await runGit(cwd, ["branch", "--list", "lupe/20260626T120000_run_me"])).stdout).toContain(
      "lupe/20260626T120000_run_me"
    );
    expect((await runGit(cwd, ["branch", "--list", "lupe/20260626T120000_run_me/phase-001"])).stdout).toBe("");
    expect(readdirSync(runsDir).sort()).toEqual(["run-001", "run-002", "run-003"]);
    expect(readFileSync(join(runsDir, "run-001", "prompt.md"), "utf8")).toContain(
      "Subagents enabled: no"
    );
    expect(readFileSync(join(runsDir, "run-001", "diff-summary.md"), "utf8")).toContain("Status");
    expect(readFileSync(join(runsDir, "run-001", "subagents.md"), "utf8")).toContain("subagents phase-");
    expect(readFileSync(join(runsDir, "run-001", "verification.md"), "utf8")).toContain("Status: passed");
    expect(
      readFileSync(join(cwd, ".lupe", "work-items", "20260626T120000_run_me", "final-review", "summary.md"), "utf8")
    ).toContain("Integrated verification: passed");
  });

  test("resumes an in-progress phase without rerunning completed phases", async () => {
    const cwd = makeTempDir();
    writeQueueFile(cwd, "20260626T130000_resume_me.md", "# Resume me\n\nContinue after a crash.");
    await initGitRepo(cwd);

    const config = testConfig({ maxParallelPhases: 1, verify: ["test -f resumed.txt"] });
    const workItem = await firstQueueItem(cwd, config);
    const phases = buildPhaseGraph([
      { id: "phase-001", title: "Done", goal: "Already done" },
      { id: "phase-002", title: "Resume", goal: "Resume this", deps: ["phase-001"] }
    ]);
    await persistPlanArtifacts(workItem, phases, { cwd });
    await runGit(cwd, ["branch", `lupe/${workItem.id}/phase-001`]);
    await saveState(crashedState(config, workItem), { cwd, config });

    const executed: string[] = [];
    const agent = createMockAgentAdapter(
      () => {
        throw new Error("resume should not re-plan");
      },
      async (_workItem, phase, context) => {
        executed.push(phase.id);
        await writeFile(join(context.worktreePath, "resumed.txt"), "resumed\n");
        return { output: `resumed ${phase.id}` };
      }
    );

    const result = await runEngine({
      cwd,
      config,
      agent
    });
    const state = await loadState({ cwd, config });

    expect(result.resumed).toBe(true);
    expect(executed).toEqual(["phase-002"]);
    expect(state.workItems[0]?.status).toBe("in_review");
    expect(state.workItems[0]?.phases?.map((phase) => phase.status)).toEqual(["verified", "verified"]);
    expect(readdirSync(join(cwd, ".lupe", "work-items", workItem.id, "runs"))).toEqual(["run-001"]);
  });

  test("repairs a failing verification within budget and verifies the work item", async () => {
    const cwd = makeTempDir();
    writeQueueFile(cwd, "20260626T140000_repair_me.md", "# Repair me\n\nFix verification.");
    await initGitRepo(cwd);

    const config = testConfig({
      maxParallelPhases: 1,
      maxRepairAttempts: 2,
      subagents: false,
      skills: false,
      verify: ["test -f repaired.txt"]
    });
    const repairPrompts: string[] = [];
    const agent = createMockAgentAdapter(
      {
        phases: [{ id: "phase-001", title: "Repairable", goal: "Create a repair marker" }]
      },
      () => ({ output: "phase completed without marker" }),
      async (_workItem, _phase, context) => {
        repairPrompts.push(context.failedVerification);
        expect(context.repairAttempt).toBe(1);
        await writeFile(join(context.worktreePath, "repaired.txt"), "repaired\n");
        return {
          output: "created repaired.txt",
          subagents: "repair subagent"
        };
      }
    );

    const result = await runEngine({
      cwd,
      config,
      agent
    });
    const state = await loadState({ cwd, config });
    const item = state.workItems[0];
    const verification = readFileSync(
      join(cwd, ".lupe", "work-items", "20260626T140000_repair_me", "runs", "run-001", "verification.md"),
      "utf8"
    );

    expect(result.workItemId).toBe("20260626T140000_repair_me");
    expect(item?.status).toBe("in_review");
    expect(item?.finalReview).toBe(".lupe/work-items/20260626T140000_repair_me/final-review");
    expect(item?.repairAttempts).toBe(1);
    expect(item?.phases?.[0]?.status).toBe("verified");
    expect(repairPrompts[0]).toContain("Command failed: test -f repaired.txt");
    expect(verification).toContain("Status: passed after repair");
    expect(verification).toContain("Repair attempt: 1");
    expect(verification).toContain("created repaired.txt");
    expect(verification).toContain("repair subagent");
  });

  test("rejects a work item when verification exhausts repair budget", async () => {
    const cwd = makeTempDir();
    writeQueueFile(cwd, "20260626T150000_reject_me.md", "# Reject me\n\nCannot be repaired.");
    await initGitRepo(cwd);

    const config = testConfig({
      maxParallelPhases: 1,
      maxRepairAttempts: 2,
      subagents: false,
      skills: false,
      verify: ["test -f never.txt"]
    });
    let repairAttempts = 0;
    const agent = createMockAgentAdapter(
      {
        phases: [{ id: "phase-001", title: "Permanent failure", goal: "Remain failing" }]
      },
      () => ({ output: "phase completed without marker" }),
      () => {
        repairAttempts += 1;
        return { output: "could not repair" };
      }
    );

    await runEngine({
      cwd,
      config,
      agent
    });
    const state = await loadState({ cwd, config });
    const item = state.workItems[0];
    const verification = readFileSync(
      join(cwd, ".lupe", "work-items", "20260626T150000_reject_me", "runs", "run-001", "verification.md"),
      "utf8"
    );

    expect(repairAttempts).toBe(2);
    expect(item?.status).toBe("rejected");
    expect(item?.repairAttempts).toBe(2);
    expect(item?.phases?.[0]?.status).toBe("failed");
    expect(item?.rejectionReason).toContain("Command failed: test -f never.txt");
    expect(state.current).toEqual({ status: "halted", workItem: "20260626T150000_reject_me" });
    expect(verification).toContain("Status: failed, repair budget exhausted");
    expect(verification).toContain("Verification After Repair 2");
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lupe-runner-"));
  tempDirs.push(dir);
  return dir;
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

function writeQueueFile(cwd: string, filename: string, contents: string): void {
  const inputDir = join(cwd, INPUT_DIR);
  mkdirSync(inputDir, { recursive: true });
  writeFileSync(join(inputDir, filename), contents);
}

async function initGitRepo(cwd: string): Promise<void> {
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

async function firstQueueItem(cwd: string, config: LupeConfig): Promise<WorkItem> {
  const queue = await loadQueue(config, { cwd });
  const item = queue.items[0];
  if (item === undefined) {
    throw new Error("expected a queue item");
  }
  return item;
}

function crashedState(config: LupeConfig, workItem: WorkItem): State {
  const state = createInitialState(config);
  state.current = {
    status: "active",
    workItem: workItem.id,
    run: "run-crashed",
    integrationBranch: `lupe/${workItem.id}`
  };
  state.workItems = [
    {
      id: workItem.id,
      status: "running",
      planned: true,
      verified: false,
      fileHash: workItem.fileHash,
      currentPhase: "phase-002",
      phases: [
        {
          id: "phase-001",
          status: "verified",
          deps: [],
          branch: `lupe/${workItem.id}/phase-001`,
          startedAt: "2026-06-26T00:00:00.000Z",
          completedAt: "2026-06-26T00:01:00.000Z"
        },
        {
          id: "phase-002",
          status: "running",
          deps: ["phase-001"],
          branch: `lupe/${workItem.id}/phase-002`,
          startedAt: "2026-06-26T00:02:00.000Z"
        }
      ]
    }
  ];
  return state;
}

function phaseState(id: string, status: PhaseState["status"], deps: string[] = []): PhaseState {
  return {
    id,
    status,
    deps
  };
}

function refreshTestReadiness(phases: PhaseState[]): PhaseState[] {
  const verified = new Set(phases.filter((phase) => phase.status === "verified").map((phase) => phase.id));
  return phases.map((phase) =>
    phase.status === "blocked" && phase.deps.every((dep) => verified.has(dep))
      ? { ...phase, status: "ready" }
      : phase
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
