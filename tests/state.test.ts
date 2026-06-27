import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { WorkItem } from "../src/queue/workItem";
import { LockConflictError, acquireLock, inspectLock } from "../src/state/lock";
import {
  IllegalTransitionError,
  queueEffectFor,
  syncDiscovered,
  transition,
  type TransitionEvent
} from "../src/state/machine";
import { renderStateMarkdown } from "../src/state/render";
import { StateValidationError, type State, type WorkItemState, type WorkItemStatus } from "../src/state/schema";
import { createInitialState, loadState, saveState } from "../src/state/store";

const tempDirs: string[] = [];
const statuses: WorkItemStatus[] = [
  "discovered",
  "planned",
  "running",
  "verified",
  "in_review",
  "accepted",
  "rejected",
  "skipped"
];

const events: TransitionEvent[] = [
  { type: "plan_completed" },
  { type: "run_started" },
  { type: "run_resumed" },
  { type: "verify_passed" },
  { type: "verify_failed" },
  { type: "repair_budget_exhausted" },
  { type: "final_review_generated" },
  { type: "accept" },
  { type: "reject" },
  { type: "skip" }
];

const legalTransitions = new Map<string, WorkItemStatus>([
  ["discovered:plan_completed", "planned"],
  ["planned:run_started", "running"],
  ["running:run_resumed", "running"],
  ["running:verify_passed", "verified"],
  ["running:verify_failed", "running"],
  ["running:repair_budget_exhausted", "rejected"],
  ["running:reject", "rejected"],
  ["verified:final_review_generated", "in_review"],
  ["in_review:accept", "accepted"],
  ["in_review:reject", "rejected"],
  ...statuses.map((status) => [`${status}:skip`, "skipped"] as const)
]);

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("state machine transitions", () => {
  test("enforces the legal transition matrix", () => {
    for (const status of statuses) {
      for (const event of events) {
        const expected = legalTransitions.get(`${status}:${event.type}`);
        const action = () => transition(stateWith(itemWithStatus(status)), "item-1", event);

        if (expected === undefined) {
          expect(action).toThrow(IllegalTransitionError);
        } else {
          expect(action().workItems[0]?.status).toBe(expected);
        }
      }
    }
  });

  test("applies queue effects for accepted, skipped, and rejected items", () => {
    const state = stateWith([
      itemWithStatus("in_review", "item-1"),
      itemWithStatus("discovered", "item-2")
    ]);

    const accepted = transition(state, "item-1", {
      type: "accept",
      completedAt: "2026-06-26"
    });
    expect(accepted.current).toEqual({ status: "active", workItem: "item-2" });
    expect(queueEffectFor("accepted")).toBe("advance");

    const skipped = transition(stateWith([itemWithStatus("planned", "item-1")]), "item-1", {
      type: "skip",
      skippedAt: "2026-06-26"
    });
    expect(skipped.current).toEqual({ status: "idle" });
    expect(queueEffectFor("skipped")).toBe("advance");

    const rejected = transition(state, "item-1", {
      type: "reject",
      reason: "needs changes"
    });
    expect(rejected.current).toEqual({ status: "halted", workItem: "item-1" });
    expect(queueEffectFor("rejected")).toBe("halt");
  });

  test("records verification repair attempts and rejects on exhausted budget", () => {
    const state = stateWith(itemWithStatus("running"));

    const repairing = transition(state, "item-1", {
      type: "verify_failed",
      repairAttempts: 1,
      currentPhase: "phase-001"
    });
    expect(repairing.workItems[0]?.status).toBe("running");
    expect(repairing.workItems[0]?.repairAttempts).toBe(1);
    expect(repairing.workItems[0]?.currentPhase).toBe("phase-001");

    const rejected = transition(repairing, "item-1", {
      type: "repair_budget_exhausted",
      reason: "verification failed",
      rejectedAt: "2026-06-26"
    });
    expect(rejected.workItems[0]?.status).toBe("rejected");
    expect(rejected.workItems[0]?.rejectionReason).toBe("verification failed");
    expect(rejected.current).toEqual({ status: "halted", workItem: "item-1" });
  });
});

describe("state store", () => {
  test("returns defaults when state is missing", async () => {
    const cwd = makeTempDir();

    const state = await loadState({ cwd });

    expect(state).toEqual(createInitialState());
  });

  test("saves atomically enough to avoid temp leftovers and regenerates STATE.md", async () => {
    const cwd = makeTempDir();
    const state = stateWith(itemWithStatus("verified"));
    state.decisions.push({
      date: "2026-06-26",
      note: "state.json is canonical"
    });

    await saveState(state, { cwd });

    const internalDir = join(cwd, ".lupe");
    expect(existsSync(join(internalDir, "state.json"))).toBe(true);
    expect(existsSync(join(internalDir, "STATE.md"))).toBe(true);
    expect(readdirSync(internalDir).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    expect(await loadState({ cwd })).toEqual(state);
    expect(readFileSync(join(internalDir, "STATE.md"), "utf8")).toBe(renderStateMarkdown(state));
  });

  test("validates state on load", async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".lupe"), { recursive: true });
    writeFileSync(join(cwd, ".lupe", "state.json"), JSON.stringify({ current: {} }));

    await expect(loadState({ cwd })).rejects.toThrow(StateValidationError);
  });
});

describe("STATE.md rendering", () => {
  test("renders a stable human-readable snapshot", () => {
    const state = stateWith([
      {
        ...itemWithStatus("accepted", "20260625T090000_initial_scope"),
        completedAt: "2026-06-25"
      },
      {
        ...itemWithStatus("running", "20260626T141500_admin_dashboard"),
        currentPhase: "phase-002"
      }
    ]);
    state.current = {
      status: "active",
      workItem: "20260626T141500_admin_dashboard",
      run: "run-2026-06-26-001",
      integrationBranch: "lupe/20260626T141500_admin_dashboard"
    };

    expect(renderStateMarkdown(state)).toBe(`# Lupe State

<!-- Generated from .lupe/state.json. Do not edit by hand. -->

## Current
- Status: active
- Work item: 20260626T141500_admin_dashboard
- Run: run-2026-06-26-001
- Integration branch: lupe/20260626T141500_admin_dashboard

## Work Items
- [accepted] 20260625T090000_initial_scope (completed 2026-06-25)
- [running] 20260626T141500_admin_dashboard (phase-002)
`);
  });
});

describe("state lock", () => {
  test("acquires, reports conflicts, and releases", async () => {
    const cwd = makeTempDir();
    const now = new Date("2026-06-26T00:00:00.000Z");
    const handle = await acquireLock({
      cwd,
      runId: "run-1",
      now
    });

    const inspected = await inspectLock({ cwd, now });
    expect(inspected.status).toBe("locked");
    if (inspected.status === "locked") {
      expect(inspected.metadata.run).toBe("run-1");
      expect(inspected.stale).toBe(false);
    }
    await expect(acquireLock({ cwd, runId: "run-2", now })).rejects.toThrow(LockConflictError);

    await handle.release();
    expect(await inspectLock({ cwd })).toEqual({
      status: "unlocked",
      path: join(cwd, ".lupe", "lock")
    });
  });

  test("replaces stale locks", async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, ".lupe"), { recursive: true });
    writeFileSync(
      join(cwd, ".lupe", "lock"),
      JSON.stringify({
        pid: process.pid,
        run: "old-run",
        acquiredAt: "2020-01-01T00:00:00.000Z"
      })
    );

    const stale = await inspectLock({
      cwd,
      now: new Date("2026-06-26T00:00:00.000Z"),
      staleAfterMs: 1
    });
    expect(stale.status).toBe("locked");
    if (stale.status === "locked") {
      expect(stale.stale).toBe(true);
    }

    const handle = await acquireLock({
      cwd,
      runId: "new-run",
      now: new Date("2026-06-26T00:00:00.000Z"),
      staleAfterMs: 1
    });
    expect(JSON.parse(readFileSync(join(cwd, ".lupe", "lock"), "utf8")).run).toBe("new-run");
    await handle.release();
  });
});

describe("syncDiscovered", () => {
  test("adds new queue items without resetting terminal existing items", () => {
    const accepted = {
      ...itemWithStatus("accepted", "20260625T090000_initial_scope"),
      fileHash: "old-accepted-hash",
      completedAt: "2026-06-25"
    };
    const rejected = {
      ...itemWithStatus("rejected", "20260625T100000_rejected"),
      fileHash: "old-rejected-hash",
      rejectionReason: "needs rewrite"
    };
    const state = stateWith([accepted, rejected]);
    const queue: WorkItem[] = [
      workItem("20260625T090000_initial_scope", "new-accepted-hash"),
      workItem("20260625T100000_rejected", "new-rejected-hash"),
      workItem("20260626T120000_new_item", "new-hash")
    ];

    const synced = syncDiscovered({ items: queue }, state);

    expect(synced.workItems.map((item) => item.id)).toEqual([
      "20260625T090000_initial_scope",
      "20260625T100000_rejected",
      "20260626T120000_new_item"
    ]);
    expect(synced.workItems[0]).toEqual(accepted);
    expect(synced.workItems[1]).toEqual(rejected);
    expect(synced.workItems[2]).toEqual({
      id: "20260626T120000_new_item",
      status: "discovered",
      planned: false,
      verified: false,
      fileHash: "new-hash"
    });
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lupe-state-"));
  tempDirs.push(dir);
  return dir;
}

function stateWith(items: WorkItemState | WorkItemState[] = []): State {
  return {
    ...createInitialState(),
    workItems: Array.isArray(items) ? items : [items]
  };
}

function itemWithStatus(status: WorkItemStatus, id = "item-1"): WorkItemState {
  return {
    id,
    status,
    planned: ["planned", "running", "verified", "in_review", "accepted"].includes(status),
    verified: ["verified", "in_review", "accepted"].includes(status),
    fileHash: `${id}-hash`
  };
}

function workItem(id: string, fileHash: string): WorkItem {
  return {
    id,
    timestamp: id.slice(0, 15),
    description: id.slice(16),
    path: `/tmp/${id}.md`,
    contents: `# ${id}`,
    fileHash
  };
}
