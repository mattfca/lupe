import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { AgentAdapter } from "../agent";
import type { LupeConfig } from "../config/schema";
import { DEFAULT_CONFIG } from "../config/schema";
import type { WorkItem } from "../queue/workItem";
import { detectAcceptedFileDrift, warnAcceptedFileDrift } from "../lifecycle/immutability";
import { syncDiscovered, transition } from "../state/machine";
import type { State, WorkItemState } from "../state/schema";
import type { Logger } from "../util/logger";
import { UsageError } from "../util/errors";
import { buildPhaseGraph, phasesToState, type PlannedPhase } from "./graph";
import {
  persistPlanArtifacts,
  resolveWorkItemPlanPaths,
  type PersistPlanResult
} from "./persist";

export interface PlanWorkItemOptions {
  cwd?: string;
  internalDir?: string;
  config?: LupeConfig;
  agent: AgentAdapter;
  now?: Date;
  logger?: Logger;
}

export interface PlanWorkItemResult {
  state: State;
  phases: PlannedPhase[];
  persisted: PersistPlanResult;
  replanned: boolean;
}

export interface SelectPlanTargetsOptions {
  queueItems: readonly WorkItem[];
  state: State;
  target?: string;
  all?: boolean;
  cwd?: string;
}

export async function planWorkItem(
  workItem: WorkItem,
  state: State,
  options: PlanWorkItemOptions
): Promise<PlanWorkItemResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const config = options.config ?? DEFAULT_CONFIG;
  const existing = requirePlannableState(state, workItem.id);
  const replanned = existing.planned || existing.status === "planned";
  const persistOptions = persistOptionsFor(cwd, options.internalDir, options.now);
  const planPaths = resolveWorkItemPlanPaths(workItem.id, persistOptions);

  if (existsSync(planPaths.planPath)) {
    options.logger?.warn(`Regenerating existing plan for ${workItem.id}; generated artifacts will be overwritten.`);
  }

  const result = await options.agent.plan(workItem, {
    cwd,
    config
  });
  const phases = buildPhaseGraph(result.phases);
  const persisted = await persistPlanArtifacts(workItem, phases, persistOptions);
  const updatedState = updateStateAfterPlanning(state, workItem.id, phases, {
    replanned,
    now: options.now ?? new Date()
  });

  return {
    state: updatedState,
    phases,
    persisted,
    replanned
  };
}

export function selectPlanTargets(options: SelectPlanTargetsOptions): WorkItem[] {
  if (options.all === true && options.target !== undefined) {
    throw new UsageError("lupe plan accepts either --all or a target, not both.");
  }

  const byId = new Map(options.queueItems.map((item) => [item.id, item]));
  const byPath = new Map(
    options.queueItems.map((item) => [resolve(options.cwd ?? process.cwd(), item.path), item])
  );

  if (options.target !== undefined) {
    const targetPath = resolve(options.cwd ?? process.cwd(), options.target);
    const item = byId.get(options.target) ?? byPath.get(targetPath);
    if (item === undefined) {
      throw new UsageError(`No discovered work item matches target "${options.target}".`);
    }
    requirePlannableState(options.state, item.id);
    return [item];
  }

  const unplanned = options.state.workItems
    .filter((item) => item.status === "discovered" && !item.planned)
    .map((item) => byId.get(item.id))
    .filter((item): item is WorkItem => item !== undefined);

  if (options.all === true) {
    return unplanned;
  }

  const first = unplanned[0];
  return first === undefined ? [] : [first];
}

export function syncQueueIntoState(
  queueItems: readonly WorkItem[],
  state: State,
  options: { immutableCompleted?: boolean; logger?: Logger } = {}
): State {
  warnAcceptedFileDrift(
    detectAcceptedFileDrift(queueItems, state, {
      ...(options.immutableCompleted === undefined ? {} : { immutableCompleted: options.immutableCompleted })
    }),
    options.logger
  );
  return syncDiscovered({ items: queueItems }, state);
}

function updateStateAfterPlanning(
  state: State,
  itemId: string,
  phases: readonly PlannedPhase[],
  options: { replanned: boolean; now: Date }
): State {
  const plannedPhases = phasesToState(phases);
  const updated =
    options.replanned || state.workItems.find((item) => item.id === itemId)?.status === "planned"
      ? replacePlannedItem(state, itemId, plannedPhases)
      : transition(state, itemId, {
          type: "plan_completed",
          phases: plannedPhases
        });

  return {
    ...updated,
    decisions: [
      ...updated.decisions,
      {
        date: options.now.toISOString(),
        note: `${options.replanned ? "Regenerated" : "Generated"} plan for ${itemId} with ${phases.length} phase(s).`
      }
    ]
  };
}

function replacePlannedItem(
  state: State,
  itemId: string,
  phases: ReturnType<typeof phasesToState>
): State {
  return {
    ...state,
    current: {
      ...state.current,
      status: "active",
      workItem: itemId
    },
    workItems: state.workItems.map((item) =>
      item.id === itemId
        ? {
            ...item,
            status: "planned",
            planned: true,
            phases: phases.map((phase) => ({
              ...phase,
              deps: [...phase.deps]
            }))
          }
        : item
    )
  };
}

function requirePlannableState(state: State, itemId: string): WorkItemState {
  const item = state.workItems.find((candidate) => candidate.id === itemId);
  if (item === undefined) {
    throw new UsageError(`Work item "${itemId}" has not been discovered.`);
  }

  if (item.status !== "discovered" && item.status !== "planned") {
    throw new UsageError(`Work item "${itemId}" cannot be planned from status "${item.status}".`);
  }

  return item;
}

function persistOptionsFor(
  cwd: string,
  internalDir: string | undefined,
  generatedAt: Date | undefined
): { cwd: string; internalDir?: string; generatedAt?: Date } {
  return {
    cwd,
    ...(internalDir === undefined ? {} : { internalDir }),
    ...(generatedAt === undefined ? {} : { generatedAt })
  };
}
