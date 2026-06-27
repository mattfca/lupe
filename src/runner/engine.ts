import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AgentAdapter } from "../agent";
import { createCursorAgentAdapter } from "../agent/cursor";
import type { LupeConfig } from "../config/schema";
import { createPhaseWorktree } from "../git";
import type { PullRequestInfo, PullRequestProvider } from "../git/pr";
import {
  generateBatchReviewPackage,
  recordBatchReviewDecision,
  selectBatchReviewItems
} from "../integration/batch";
import { integrationBranchName } from "../integration/merge";
import { integrateAndReviewWorkItem, transitionReviewGenerated } from "../integration/review";
import { acceptWorkItem } from "../lifecycle/accept";
import type { PersistedPlan, PersistedPlanPhase } from "../planner/persist";
import { resolveWorkItemPlanPaths } from "../planner/persist";
import { planWorkItem, syncQueueIntoState } from "../planner/plan";
import { loadQueue } from "../queue/discover";
import type { WorkItem } from "../queue/workItem";
import { withLock } from "../state/lock";
import { transition } from "../state/machine";
import type { PhaseState, State, WorkItemState } from "../state/schema";
import { loadState, saveState } from "../state/store";
import { UsageError } from "../util/errors";
import type { Logger } from "../util/logger";
import { verifyAndRepairPhase } from "../verify/repair";
import { runPhase, type RunPhaseResult } from "./phaseRun";
import { detectInProgressRun, normalizeResumablePhases } from "./resume";
import { runPhaseScheduler } from "./scheduler";

export interface RunEngineOptions {
  cwd?: string;
  config: LupeConfig;
  agent?: AgentAdapter;
  logger?: Logger;
  now?: Date;
  postPhaseHook?: (context: PostPhaseHookContext) => Promise<void> | void;
}

export interface PostPhaseHookContext {
  cwd: string;
  config: LupeConfig;
  workItem: WorkItem;
  phase: PersistedPlanPhase;
  result: RunPhaseResult;
}

export interface RunEngineResult {
  workItemId: string | null;
  phasesRun: string[];
  resumed: boolean;
  reviewPackage?: string;
  integrationBranch?: string;
}

export interface RunQueueOptions extends RunEngineOptions {
  autoAccept?: boolean;
  prProvider?: PullRequestProvider;
}

export type RunQueueStoppedReason = "idle" | "halted";

export interface RunQueueProcessedItem {
  workItemId: string;
  status: WorkItemState["status"];
  phasesRun: string[];
  resumed: boolean;
  reviewPackage?: string;
  integrationBranch?: string;
  pr?: PullRequestInfo;
}

export interface RunQueueResult {
  processed: RunQueueProcessedItem[];
  stoppedReason: RunQueueStoppedReason;
}

interface PreparedPhase {
  phase: PersistedPlanPhase;
  branch: string;
  worktreePath: string;
}

interface RunSession {
  cwd: string;
  config: LupeConfig;
  agent: AgentAdapter;
  queueItems: readonly WorkItem[];
  runId: string;
  logger?: Logger;
  now?: Date;
  postPhaseHook?: (context: PostPhaseHookContext) => Promise<void> | void;
  getState: () => State;
  setState: (state: State) => void;
  commitState: (fn: (current: State) => State) => Promise<State>;
}

type ProcessSelectionResult =
  | {
      kind: "none";
    }
  | {
      kind: "processed";
      workItemId: string;
      finalStatus: WorkItemState["status"];
      phasesRun: string[];
      resumed: boolean;
      reviewPackage?: string;
      integrationBranch?: string;
    };

export async function runEngine(options: RunEngineOptions): Promise<RunEngineResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const agent = options.agent ?? createCursorAgentAdapter();

  return await withLock(
    async (handle) => {
      const session = await createRunSession({
        cwd,
        config: options.config,
        agent,
        runId: handle.metadata.run,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.postPhaseHook === undefined ? {} : { postPhaseHook: options.postPhaseHook })
      });
      const result = await processCurrentSelection(session);
      if (result.kind === "none") {
        options.logger?.info("No planned work items to run.");
        return {
          workItemId: null,
          phasesRun: [],
          resumed: false
        };
      }

      return {
        workItemId: result.workItemId,
        phasesRun: result.phasesRun,
        resumed: result.resumed,
        ...(result.reviewPackage === undefined ? {} : { reviewPackage: result.reviewPackage }),
        ...(result.integrationBranch === undefined ? {} : { integrationBranch: result.integrationBranch })
      };
    },
    { cwd }
  );
}

export async function runQueue(options: RunQueueOptions): Promise<RunQueueResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const agent = options.agent ?? createCursorAgentAdapter();
  const shouldAutoAccept = options.autoAccept === true || options.config.autoAccept;

  return await withLock(
    async (handle) => {
      const session = await createRunSession({
        cwd,
        config: options.config,
        agent,
        runId: handle.metadata.run,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.postPhaseHook === undefined ? {} : { postPhaseHook: options.postPhaseHook })
      });
      const processed: RunQueueProcessedItem[] = [];

      while (true) {
        const result = await processCurrentSelection(session);
        if (result.kind === "none") {
          return {
            processed,
            stoppedReason: "idle"
          };
        }

        const processedItem: RunQueueProcessedItem = {
          workItemId: result.workItemId,
          status: result.finalStatus,
          phasesRun: result.phasesRun,
          resumed: result.resumed,
          ...(result.reviewPackage === undefined ? {} : { reviewPackage: result.reviewPackage }),
          ...(result.integrationBranch === undefined ? {} : { integrationBranch: result.integrationBranch })
        };
        processed.push(processedItem);

        const current = session.getState().current;
        if (result.finalStatus === "rejected" || current.status === "halted") {
          return {
            processed,
            stoppedReason: "halted"
          };
        }

        if (result.finalStatus === "in_review" && shouldAutoAccept) {
          const accepted = await acceptWorkItem({
            cwd,
            config: options.config,
            ...(options.prProvider === undefined ? {} : { prProvider: options.prProvider }),
            ...(options.logger === undefined ? {} : { logger: options.logger }),
            ...(options.now === undefined ? {} : { now: options.now })
          });
          processedItem.status = "accepted";
          processedItem.pr = accepted.pr;
          session.setState(await loadState({ cwd, config: options.config }));
        }
      }
    },
    { cwd }
  );
}

async function createRunSession(options: {
  cwd: string;
  config: LupeConfig;
  agent: AgentAdapter;
  runId: string;
  logger?: Logger;
  now?: Date;
  postPhaseHook?: (context: PostPhaseHookContext) => Promise<void> | void;
}): Promise<RunSession> {
  const queue = await loadQueue(options.config, {
    cwd: options.cwd,
    ...(options.logger === undefined ? {} : { logger: options.logger })
  });
  let state = syncQueueIntoState(queue.items, await loadState({ cwd: options.cwd, config: options.config }), {
    immutableCompleted: options.config.input.immutableCompleted,
    ...(options.logger === undefined ? {} : { logger: options.logger })
  });
  await saveState(state, { cwd: options.cwd, config: options.config });
  let stateWrite = Promise.resolve();

  return {
    cwd: options.cwd,
    config: options.config,
    agent: options.agent,
    queueItems: queue.items,
    runId: options.runId,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.postPhaseHook === undefined ? {} : { postPhaseHook: options.postPhaseHook }),
    getState: () => state,
    setState(next) {
      state = next;
    },
    async commitState(fn) {
      let committed = state;
      stateWrite = stateWrite.then(async () => {
        committed = fn(state);
        await saveState(committed, { cwd: options.cwd, config: options.config });
        state = committed;
      });
      await stateWrite;
      return committed;
    }
  };
}

async function processCurrentSelection(session: RunSession): Promise<ProcessSelectionResult> {
  const initialResume = detectInProgressRun(session.getState());
  const selected = await selectOrPlanWorkItem({
    cwd: session.cwd,
    config: session.config,
    agent: session.agent,
    queueItems: session.queueItems,
    state: session.getState(),
    ...(session.logger === undefined ? {} : { logger: session.logger }),
    ...(session.now === undefined ? {} : { now: session.now })
  });

  session.setState(selected.state);
  if (selected.workItem === null) {
    return { kind: "none" };
  }

  const workItem = selected.workItem;
  const persistedPlan = selected.plan;
  const phaseById = new Map(persistedPlan.phases.map((phase) => [phase.id, phase]));
  const resumed = initialResume?.workItem.id === workItem.id || selected.itemState.status === "running";
  const integrationBranch = integrationBranchName(workItem.id);

  if (selected.itemState.status === "verified") {
    const finalization = await finalizeVerifiedWorkItem({
      cwd: session.cwd,
      config: session.config,
      workItem,
      persistedPlan,
      state: session.getState(),
      commitState: session.commitState,
      ...(session.logger === undefined ? {} : { logger: session.logger }),
      ...(session.now === undefined ? {} : { now: session.now })
    });
    session.setState(finalization.state);
    const item = requireWorkItem(session.getState(), workItem.id);
    return {
      kind: "processed",
      workItemId: workItem.id,
      finalStatus: item.status,
      phasesRun: [],
      resumed: false,
      ...(finalization.reviewPackage === undefined ? {} : { reviewPackage: finalization.reviewPackage }),
      ...(finalization.integrationBranch === undefined ? {} : { integrationBranch: finalization.integrationBranch })
    };
  }

  session.setState(
    await session.commitState((current) =>
      startOrResumeWorkItem(current, workItem.id, session.runId, integrationBranch, resumed)
    )
  );
  session.setState(
    await session.commitState((current) =>
      updateWorkItemPhases(current, workItem.id, normalizeResumablePhases(requirePhases(current, workItem.id)))
    )
  );

  if (allPhasesVerified(requirePhases(session.getState(), workItem.id))) {
    session.setState(
      await session.commitState((current) => transition(current, workItem.id, { type: "verify_passed" }))
    );
    const finalization = await finalizeVerifiedWorkItem({
      cwd: session.cwd,
      config: session.config,
      workItem,
      persistedPlan,
      state: session.getState(),
      commitState: session.commitState,
      ...(session.logger === undefined ? {} : { logger: session.logger }),
      ...(session.now === undefined ? {} : { now: session.now })
    });
    session.setState(finalization.state);
    const item = requireWorkItem(session.getState(), workItem.id);
    return {
      kind: "processed",
      workItemId: workItem.id,
      finalStatus: item.status,
      phasesRun: [],
      resumed,
      ...(finalization.reviewPackage === undefined ? {} : { reviewPackage: finalization.reviewPackage }),
      ...(finalization.integrationBranch === undefined ? {} : { integrationBranch: finalization.integrationBranch })
    };
  }

  const prepared = await preparePhaseWorktrees({
    cwd: session.cwd,
    workItemId: workItem.id,
    phases: requirePhases(session.getState(), workItem.id),
    phaseById
  });

  session.setState(
    await session.commitState((current) =>
      updateWorkItemPhases(
        current,
        workItem.id,
        requirePhases(current, workItem.id).map((phase) => {
          const branch = prepared.get(phase.id)?.branch ?? phase.branch;
          return branch === undefined ? phase : { ...phase, branch };
        })
      )
    )
  );

  const phasesRun: string[] = [];

  await runPhaseScheduler({
    maxParallelPhases: session.config.maxParallelPhases,
    phases: () =>
      requireWorkItem(session.getState(), workItem.id).status === "running"
        ? requirePhases(session.getState(), workItem.id)
        : [],
    runPhase: async (phaseState) => {
      const phase = phaseById.get(phaseState.id);
      const worktree = prepared.get(phaseState.id);
      if (phase === undefined || worktree === undefined) {
        throw new UsageError(`Missing persisted plan or worktree for phase "${phaseState.id}".`);
      }

      session.setState(
        await session.commitState((current) =>
          markPhaseRunning(current, workItem.id, phaseState.id, worktree.branch)
        )
      );

      try {
        const result = await runPhase({
          cwd: session.cwd,
          config: session.config,
          agent: session.agent,
          workItem,
          phase,
          branch: worktree.branch,
          worktreePath: worktree.worktreePath
        });
        await session.postPhaseHook?.({
          cwd: session.cwd,
          config: session.config,
          workItem,
          phase,
          result
        });
        const currentItem = requireWorkItem(session.getState(), workItem.id);
        if (currentItem.status !== "running") {
          return result;
        }

        const verification = await verifyAndRepairPhase({
          cwd: session.cwd,
          config: session.config,
          agent: session.agent,
          workItem,
          phase,
          branch: worktree.branch,
          worktreePath: worktree.worktreePath,
          runId: result.runId,
          artifacts: result.artifacts,
          initialRepairAttempts: currentItem.repairAttempts ?? 0,
          onRepairAttempt: async (repairAttempts) => {
            session.setState(
              await session.commitState((current) => {
                const item = requireWorkItem(current, workItem.id);
                if (item.status !== "running") {
                  return current;
                }
                return transition(current, workItem.id, {
                  type: "verify_failed",
                  repairAttempts,
                  currentPhase: phaseState.id
                });
              })
            );
          }
        });
        phasesRun.push(phaseState.id);
        if (verification.status === "rejected") {
          session.setState(
            await session.commitState((current) => {
              const item = requireWorkItem(current, workItem.id);
              if (item.status !== "running") {
                return current;
              }
              const failed = markPhaseFailed(current, workItem.id, phaseState.id);
              return transition(failed, workItem.id, {
                type: "repair_budget_exhausted",
                rejectedAt: new Date().toISOString(),
                ...(verification.reason === undefined ? {} : { reason: verification.reason })
              });
            })
          );
          session.logger?.info(`Rejected ${workItem.id} after verification failed for ${phaseState.id}.`);
          return result;
        }

        session.setState(
          await session.commitState((current) =>
            requireWorkItem(current, workItem.id).status === "running"
              ? markPhaseVerified(current, workItem.id, phaseState.id)
              : current
          )
        );
        session.logger?.info(`Completed ${workItem.id} ${phaseState.id}.`);
        return result;
      } catch (error) {
        session.setState(
          await session.commitState((current) => markPhaseFailed(current, workItem.id, phaseState.id))
        );
        throw error;
      }
    }
  });

  session.logger?.info(`Ran ${phasesRun.length} phase(s) for ${workItem.id}.`);
  const finalization = await finalizeVerifiedWorkItem({
    cwd: session.cwd,
    config: session.config,
    workItem,
    persistedPlan,
    state: session.getState(),
    commitState: session.commitState,
    ...(session.logger === undefined ? {} : { logger: session.logger }),
    ...(session.now === undefined ? {} : { now: session.now })
  });
  session.setState(finalization.state);
  const item = requireWorkItem(session.getState(), workItem.id);

  return {
    kind: "processed",
    workItemId: workItem.id,
    finalStatus: item.status,
    phasesRun,
    resumed,
    ...(finalization.reviewPackage === undefined ? {} : { reviewPackage: finalization.reviewPackage }),
    ...(finalization.integrationBranch === undefined ? {} : { integrationBranch: finalization.integrationBranch })
  };
}

async function selectOrPlanWorkItem(options: {
  cwd: string;
  config: LupeConfig;
  agent: AgentAdapter;
  queueItems: readonly WorkItem[];
  state: State;
  logger?: Logger;
  now?: Date;
}): Promise<{
  state: State;
  workItem: WorkItem | null;
  itemState: WorkItemState;
  plan: PersistedPlan;
} | {
  state: State;
  workItem: null;
  itemState: null;
  plan: null;
}> {
  const reviewable =
    options.config.review === "per-item" ? selectCurrentReviewable(options.state) : undefined;
  const selectedState =
    selectCurrentRunnable(options.state) ??
    reviewable ??
    options.state.workItems.find((item) => item.status === "planned") ??
    options.state.workItems.find((item) => item.status === "discovered" && !item.planned);

  if (selectedState === undefined) {
    return {
      state: options.state,
      workItem: null,
      itemState: null,
      plan: null
    };
  }

  const workItem = options.queueItems.find((item) => item.id === selectedState.id);
  if (workItem === undefined) {
    throw new UsageError(`Work item "${selectedState.id}" is not present in the input queue.`);
  }

  if (selectedState.status === "discovered") {
    const planned = await planWorkItem(workItem, options.state, {
      cwd: options.cwd,
      config: options.config,
      agent: options.agent,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.now === undefined ? {} : { now: options.now })
    });
    const itemState = requireWorkItem(planned.state, workItem.id);
    return {
      state: planned.state,
      workItem,
      itemState,
      plan: planned.persisted.plan
    };
  }

  return {
    state: options.state,
    workItem,
    itemState: selectedState,
    plan: await loadPersistedPlan(options.cwd, workItem.id)
  };
}

async function loadPersistedPlan(cwd: string, workItemId: string): Promise<PersistedPlan> {
  const path = resolveWorkItemPlanPaths(workItemId, { cwd }).planPath;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new UsageError(`Failed to read persisted plan for "${workItemId}". Run "lupe plan" first.`, error);
  }

  if (!isPersistedPlan(parsed)) {
    throw new UsageError(`Persisted plan for "${workItemId}" is invalid.`);
  }
  return parsed;
}

async function preparePhaseWorktrees(options: {
  cwd: string;
  workItemId: string;
  phases: readonly PhaseState[];
  phaseById: ReadonlyMap<string, PersistedPlanPhase>;
}): Promise<Map<string, PreparedPhase>> {
  const prepared = new Map<string, PreparedPhase>();

  for (const phaseState of options.phases) {
    if (phaseState.status === "verified" || phaseState.status === "skipped") {
      continue;
    }

    const phase = options.phaseById.get(phaseState.id);
    if (phase === undefined) {
      throw new UsageError(`Missing persisted plan for phase "${phaseState.id}".`);
    }

    const worktree = await createPhaseWorktree({
      repoDir: options.cwd,
      workItemId: options.workItemId,
      phaseId: phaseState.id
    });

    prepared.set(phaseState.id, {
      phase,
      branch: worktree.branch,
      worktreePath: worktree.path
    });
  }

  return prepared;
}

function selectCurrentRunnable(state: State): WorkItemState | undefined {
  const currentId = state.current.workItem;
  if (currentId === undefined) {
    return state.workItems.find((item) => item.status === "running");
  }

  const item = state.workItems.find((candidate) => candidate.id === currentId);
  if (item?.status === "planned" || item?.status === "running" || item?.status === "discovered") {
    return item;
  }
  return undefined;
}

function selectCurrentReviewable(state: State): WorkItemState | undefined {
  const currentId = state.current.workItem;
  if (currentId !== undefined) {
    const current = state.workItems.find((candidate) => candidate.id === currentId);
    if (current?.status === "verified") {
      return current;
    }
  }

  return state.workItems.find((item) => item.status === "verified");
}

async function finalizeVerifiedWorkItem(options: {
  cwd: string;
  config: LupeConfig;
  workItem: WorkItem;
  persistedPlan: PersistedPlan;
  state: State;
  commitState: (fn: (current: State) => State) => Promise<State>;
  logger?: Logger;
  now?: Date;
}): Promise<{
  state: State;
  reviewPackage?: string;
  integrationBranch?: string;
}> {
  const item = requireWorkItem(options.state, options.workItem.id);
  if (item.status !== "verified") {
    return {
      state: options.state
    };
  }

  const generatedAt = options.now ?? new Date();
  if (options.config.review === "batch") {
    const batch = await generateBatchReviewPackage({
      cwd: options.cwd,
      items: selectBatchReviewItems(options.state),
      generatedAt
    });
    const state = await options.commitState((current) =>
      recordBatchReviewDecision({
        state: current,
        reviewPath: batch.paths.relativeDir,
        generatedAt,
        itemCount: batch.itemCount
      })
    );
    options.logger?.info(`Generated batch review package at ${batch.paths.relativeDir}.`);
    return {
      state,
      reviewPackage: batch.paths.relativeDir
    };
  }

  const result = await integrateAndReviewWorkItem({
    cwd: options.cwd,
    config: options.config,
    workItem: options.workItem,
    itemState: item,
    plan: options.persistedPlan,
    generatedAt
  });
  const state = await options.commitState((current) =>
    transitionReviewGenerated({
      state: current,
      workItemId: options.workItem.id,
      reviewPath: result.review.paths.relativeDir,
      integrationBranch: result.merge.branch,
      generatedAt
    })
  );
  options.logger?.info(`Generated final review package at ${result.review.paths.relativeDir}.`);

  return {
    state,
    reviewPackage: result.review.paths.relativeDir,
    integrationBranch: result.merge.branch
  };
}

function startOrResumeWorkItem(
  state: State,
  workItemId: string,
  runId: string,
  integrationBranch: string,
  resumed: boolean
): State {
  if (resumed) {
    return transition(state, workItemId, {
      type: "run_resumed",
      run: runId
    });
  }

  return transition(state, workItemId, {
    type: "run_started",
    run: runId,
    integrationBranch
  });
}

async function mutateState(
  state: State,
  cwd: string,
  config: LupeConfig,
  fn: (state: State) => State
): Promise<State> {
  const next = fn(state);
  await saveState(next, { cwd, config });
  return next;
}

function markPhaseRunning(state: State, workItemId: string, phaseId: string, branch: string): State {
  return updateWorkItemPhases(
    state,
    workItemId,
    requirePhases(state, workItemId).map((phase) =>
      phase.id === phaseId
        ? {
            ...phase,
            branch,
            status: "running",
            startedAt: new Date().toISOString()
          }
        : phase
    ),
    phaseId
  );
}

function markPhaseVerified(state: State, workItemId: string, phaseId: string): State {
  const updated = updateWorkItemPhases(
    state,
    workItemId,
    refreshPhaseReadiness(
      requirePhases(state, workItemId).map((phase) =>
        phase.id === phaseId
          ? {
              ...phase,
              status: "verified",
              completedAt: new Date().toISOString()
            }
          : phase
      )
    )
  );

  return allPhasesVerified(requirePhases(updated, workItemId))
    ? transition(updated, workItemId, { type: "verify_passed" })
    : updated;
}

function markPhaseFailed(state: State, workItemId: string, phaseId: string): State {
  return updateWorkItemPhases(
    state,
    workItemId,
    requirePhases(state, workItemId).map((phase) =>
      phase.id === phaseId
        ? {
            ...phase,
            status: "failed",
            completedAt: new Date().toISOString()
          }
        : phase
    ),
    phaseId
  );
}

function refreshPhaseReadiness(phases: readonly PhaseState[]): PhaseState[] {
  const verified = new Set(phases.filter((phase) => phase.status === "verified").map((phase) => phase.id));
  return phases.map((phase) => {
    if (phase.status !== "blocked" && phase.status !== "planned") {
      return clonePhase(phase);
    }

    return {
      ...clonePhase(phase),
      status: phase.deps.every((dep) => verified.has(dep)) ? "ready" : "blocked"
    };
  });
}

function updateWorkItemPhases(
  state: State,
  workItemId: string,
  phases: readonly PhaseState[],
  currentPhase?: string
): State {
  return {
    ...state,
    current: {
      ...state.current,
      status: "active",
      workItem: workItemId
    },
    workItems: state.workItems.map((item) => {
      if (item.id !== workItemId) {
        return item;
      }

      const updated: WorkItemState = {
        ...item,
        phases: phases.map(clonePhase)
      };
      if (currentPhase !== undefined) {
        updated.currentPhase = currentPhase;
      }
      return updated;
    })
  };
}

function requireWorkItem(state: State, workItemId: string): WorkItemState {
  const item = state.workItems.find((candidate) => candidate.id === workItemId);
  if (item === undefined) {
    throw new UsageError(`Work item "${workItemId}" is not in state.`);
  }
  return item;
}

function requirePhases(state: State, workItemId: string): PhaseState[] {
  const phases = requireWorkItem(state, workItemId).phases;
  if (phases === undefined || phases.length === 0) {
    throw new UsageError(`Work item "${workItemId}" does not have a phase plan.`);
  }
  return phases.map(clonePhase);
}

function allPhasesVerified(phases: readonly PhaseState[]): boolean {
  return phases.every((phase) => phase.status === "verified" || phase.status === "skipped");
}

function clonePhase(phase: PhaseState): PhaseState {
  return {
    ...phase,
    deps: [...phase.deps]
  };
}

function isPersistedPlan(value: unknown): value is PersistedPlan {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.workItem) || !Array.isArray(value.phases)) {
    return false;
  }
  return value.phases.every(
    (phase) =>
      isRecord(phase) &&
      typeof phase.id === "string" &&
      typeof phase.title === "string" &&
      typeof phase.goal === "string" &&
      Array.isArray(phase.scope) &&
      Array.isArray(phase.deps) &&
      Array.isArray(phase.acceptanceHints)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
