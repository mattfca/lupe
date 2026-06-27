import type { LupeConfig } from "../config/schema";
import type { PersistedPlanPhase } from "../planner/persist";
import type { WorkItem } from "../queue/workItem";

export interface PlanningPhaseDraft {
  id?: string;
  title?: string;
  goal?: string;
  scope?: string | string[];
  deps?: string[];
  acceptanceHints?: string[];
}

export interface PlanningResult {
  phases: PlanningPhaseDraft[];
}

export interface PlanningContext {
  cwd: string;
  config: LupeConfig;
}

export interface PhaseExecutionContext {
  cwd: string;
  worktreePath: string;
  branch: string;
  runId: string;
  prompt: string;
  config: LupeConfig;
  subagents: boolean;
  skills: boolean;
}

export interface PhaseExecutionResult {
  output: string;
  subagents?: string;
}

export interface PhaseRepairContext extends PhaseExecutionContext {
  repairAttempt: number;
  maxRepairAttempts: number;
  failedVerification: string;
}

export interface AgentAdapter {
  readonly name: string;
  plan(workItem: WorkItem, context: PlanningContext): Promise<PlanningResult> | PlanningResult;
  executePhase?(
    workItem: WorkItem,
    phase: PersistedPlanPhase,
    context: PhaseExecutionContext
  ): Promise<PhaseExecutionResult> | PhaseExecutionResult;
  repairPhase?(
    workItem: WorkItem,
    phase: PersistedPlanPhase,
    context: PhaseRepairContext
  ): Promise<PhaseExecutionResult> | PhaseExecutionResult;
}

export type MockPlanHandler =
  | PlanningResult
  | ((workItem: WorkItem, context: PlanningContext) => Promise<PlanningResult> | PlanningResult);

export type MockPhaseHandler =
  | PhaseExecutionResult
  | ((
      workItem: WorkItem,
      phase: PersistedPlanPhase,
      context: PhaseExecutionContext
    ) => Promise<PhaseExecutionResult> | PhaseExecutionResult);

export type MockRepairHandler =
  | PhaseExecutionResult
  | ((
      workItem: WorkItem,
      phase: PersistedPlanPhase,
      context: PhaseRepairContext
    ) => Promise<PhaseExecutionResult> | PhaseExecutionResult);

export function createMockAgentAdapter(
  handler: MockPlanHandler,
  phaseHandler?: MockPhaseHandler,
  repairHandler?: MockRepairHandler
): AgentAdapter {
  return {
    name: "mock",
    plan(workItem, context) {
      return typeof handler === "function" ? handler(workItem, context) : handler;
    },
    ...(phaseHandler === undefined
      ? {}
      : {
          executePhase(workItem: WorkItem, phase: PersistedPlanPhase, context: PhaseExecutionContext) {
            return typeof phaseHandler === "function" ? phaseHandler(workItem, phase, context) : phaseHandler;
          }
        }),
    ...(repairHandler === undefined
      ? {}
      : {
          repairPhase(workItem: WorkItem, phase: PersistedPlanPhase, context: PhaseRepairContext) {
            return typeof repairHandler === "function" ? repairHandler(workItem, phase, context) : repairHandler;
          }
        })
  };
}
