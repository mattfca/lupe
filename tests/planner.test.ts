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

import { createMockAgentAdapter } from "../src/agent";
import { createPlanCommand } from "../src/cli/commands/plan";
import { DEFAULT_CONFIG } from "../src/config/schema";
import { INPUT_DIR } from "../src/fs/contract";
import { buildPhaseGraph, PhaseGraphError } from "../src/planner/graph";
import { persistPlanArtifacts } from "../src/planner/persist";
import { selectPlanTargets } from "../src/planner/plan";
import type { WorkItem } from "../src/queue/workItem";
import { loadState } from "../src/state/store";
import { createLogger } from "../src/util/logger";
import type { State, WorkItemState } from "../src/state/schema";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("phase graph validation", () => {
  test("computes initial ready and blocked status", () => {
    const phases = buildPhaseGraph([
      {
        id: "phase-001",
        title: "Set up",
        goal: "Prepare the base",
        scope: ["Create files"]
      },
      {
        id: "phase-002",
        title: "Use base",
        deps: ["phase-001"]
      }
    ]);

    expect(phases.map((phase) => ({ id: phase.id, status: phase.status }))).toEqual([
      { id: "phase-001", status: "ready" },
      { id: "phase-002", status: "blocked" }
    ]);
  });

  test("rejects dangling dependencies", () => {
    expect(() =>
      buildPhaseGraph([
        {
          id: "phase-001",
          deps: ["missing"]
        }
      ])
    ).toThrow(PhaseGraphError);
    expect(() =>
      buildPhaseGraph([
        {
          id: "phase-001",
          deps: ["missing"]
        }
      ])
    ).toThrow('depends on missing phase "missing"');
  });

  test("rejects dependency cycles", () => {
    expect(() =>
      buildPhaseGraph([
        {
          id: "phase-001",
          deps: ["phase-002"]
        },
        {
          id: "phase-002",
          deps: ["phase-001"]
        }
      ])
    ).toThrow("cycle detected");
  });
});

describe("planner persistence", () => {
  test("writes plan.json and numbered phase briefs", async () => {
    const cwd = makeTempDir();
    const phases = buildPhaseGraph([
      {
        id: "phase-001",
        title: "Build core",
        goal: "Create the core module",
        scope: ["Add source file"],
        acceptanceHints: ["Typecheck passes"]
      },
      {
        id: "phase-002",
        title: "Wire CLI",
        deps: ["phase-001"]
      }
    ]);

    const persisted = await persistPlanArtifacts(workItem("20260626T120000_plan_me", cwd), phases, {
      cwd,
      generatedAt: new Date("2026-06-26T00:00:00.000Z")
    });

    expect(existsSync(join(cwd, ".lupe", "work-items", "20260626T120000_plan_me", "plan.json"))).toBe(
      true
    );
    expect(readdirSync(join(cwd, ".lupe", "work-items", "20260626T120000_plan_me", "phases"))).toEqual([
      "phase-001.md",
      "phase-002.md"
    ]);
    expect(persisted.plan.phases.map((phase) => phase.briefPath)).toEqual([
      "phases/phase-001.md",
      "phases/phase-002.md"
    ]);
    expect(readFileSync(persisted.paths.phasePaths[0] ?? "", "utf8")).toContain("## Acceptance Hints");
  });

  test("removes stale phase briefs when regenerating", async () => {
    const cwd = makeTempDir();
    const item = workItem("20260626T120000_plan_me", cwd);

    await persistPlanArtifacts(
      item,
      buildPhaseGraph([{ id: "phase-001" }, { id: "phase-002", deps: ["phase-001"] }]),
      { cwd }
    );
    await persistPlanArtifacts(item, buildPhaseGraph([{ id: "phase-001" }]), { cwd });

    expect(readdirSync(join(cwd, ".lupe", "work-items", item.id, "phases"))).toEqual([
      "phase-001.md"
    ]);
  });
});

describe("plan target selection", () => {
  test("selects the first discovered item by default", () => {
    const queueItems = [
      workItem("20260626T120000_first", "/repo"),
      workItem("20260626T120001_second", "/repo")
    ];
    const state = stateWith([
      itemState("20260626T120000_first", "discovered"),
      itemState("20260626T120001_second", "discovered")
    ]);

    expect(selectPlanTargets({ queueItems, state }).map((item) => item.id)).toEqual([
      "20260626T120000_first"
    ]);
  });

  test("selects all unplanned discovered items with --all", () => {
    const queueItems = [
      workItem("20260626T120000_first", "/repo"),
      workItem("20260626T120001_second", "/repo"),
      workItem("20260626T120002_planned", "/repo")
    ];
    const state = stateWith([
      itemState("20260626T120000_first", "discovered"),
      itemState("20260626T120001_second", "discovered"),
      itemState("20260626T120002_planned", "planned")
    ]);

    expect(selectPlanTargets({ queueItems, state, all: true }).map((item) => item.id)).toEqual([
      "20260626T120000_first",
      "20260626T120001_second"
    ]);
  });

  test("selects explicit id and path targets", () => {
    const cwd = makeTempDir();
    const first = workItem("20260626T120000_first", cwd);
    const second = workItem("20260626T120001_second", cwd);
    const state = stateWith([itemState(first.id, "discovered"), itemState(second.id, "discovered")]);

    expect(selectPlanTargets({ queueItems: [first, second], state, target: second.id, cwd })).toEqual([
      second
    ]);
    expect(selectPlanTargets({ queueItems: [first, second], state, target: first.path, cwd })).toEqual([
      first
    ]);
  });
});

describe("lupe plan integration", () => {
  test("plans a discovered item with a mock agent and updates artifacts and state", async () => {
    const cwd = makeTempDir();
    writeQueueFile(cwd, "20260626T120000_plan_me.md", "# Plan me\n\nBuild the planner.");
    const io = captureIo();
    const command = createPlanCommand({
      agent: createMockAgentAdapter({
        phases: [
          {
            id: "phase-001",
            title: "Add planner",
            goal: "Implement planner modules",
            scope: ["Graph", "Persistence"],
            acceptanceHints: ["Tests pass"]
          },
          {
            id: "phase-002",
            title: "Wire CLI",
            deps: ["phase-001"]
          }
        ]
      })
    });

    const exitCode = await command.run({
      args: [],
      flags: {
        cwd,
        verbose: false,
        quiet: false,
        help: false,
        version: false
      },
      logger: createLogger({
        stdout: io.stdout,
        stderr: io.stderr
      })
    });

    const planPath = join(cwd, ".lupe", "work-items", "20260626T120000_plan_me", "plan.json");
    const state = await loadState({ cwd });

    expect(exitCode).toBe(0);
    expect(io.out()).toContain("Planned 20260626T120000_plan_me with 2 phase(s).");
    expect(JSON.parse(readFileSync(planPath, "utf8")).phases.map((phase: { status: string }) => phase.status)).toEqual([
      "ready",
      "blocked"
    ]);
    expect(state.workItems[0]?.status).toBe("planned");
    expect(state.workItems[0]?.phases?.map((phase) => phase.status)).toEqual(["ready", "blocked"]);
    expect(state.decisions[0]?.note).toContain("Generated plan for 20260626T120000_plan_me");
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lupe-planner-"));
  tempDirs.push(dir);
  return dir;
}

function workItem(id: string, cwd: string): WorkItem {
  return {
    id,
    timestamp: id.slice(0, 15),
    description: id.slice(16),
    path: join(cwd, INPUT_DIR, `${id}.md`),
    contents: `# ${id}`,
    fileHash: `${id}-hash`
  };
}

function stateWith(workItems: WorkItemState[]): State {
  return {
    project: {
      input: DEFAULT_CONFIG.input.dir,
      internal: ".lupe",
      agent: DEFAULT_CONFIG.agent,
      mode: DEFAULT_CONFIG.mode,
      review: DEFAULT_CONFIG.review,
      autoAccept: DEFAULT_CONFIG.autoAccept,
      subagents: DEFAULT_CONFIG.subagents,
      skills: DEFAULT_CONFIG.skills
    },
    current: {
      status: "idle"
    },
    workItems,
    decisions: []
  };
}

function itemState(id: string, status: WorkItemState["status"]): WorkItemState {
  return {
    id,
    status,
    planned: status === "planned",
    verified: false,
    fileHash: `${id}-hash`
  };
}

function writeQueueFile(cwd: string, filename: string, contents: string): void {
  const inputDir = join(cwd, INPUT_DIR);
  mkdirSync(inputDir, { recursive: true });
  writeFileSync(join(inputDir, filename), contents);
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
