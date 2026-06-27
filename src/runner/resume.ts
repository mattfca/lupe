import type { PhaseState, State, WorkItemState } from "../state/schema";

export interface ResumeRunInfo {
  workItem: WorkItemState;
  completedPhaseIds: Set<string>;
  inProgressPhaseIds: Set<string>;
}

export function detectInProgressRun(state: State): ResumeRunInfo | null {
  const currentId = state.current.workItem;
  const candidates =
    currentId === undefined
      ? state.workItems.filter((item) => item.status === "running")
      : state.workItems.filter((item) => item.id === currentId && item.status === "running");

  const workItem = candidates[0];
  if (workItem === undefined) {
    return null;
  }

  const phases = workItem.phases ?? [];
  return {
    workItem,
    completedPhaseIds: new Set(phases.filter((phase) => phase.status === "verified").map((phase) => phase.id)),
    inProgressPhaseIds: new Set(phases.filter((phase) => phase.status === "running").map((phase) => phase.id))
  };
}

export function normalizeResumablePhases(phases: readonly PhaseState[]): PhaseState[] {
  const verified = new Set(phases.filter((phase) => phase.status === "verified").map((phase) => phase.id));

  return phases.map((phase) => {
    if (phase.status === "verified" || phase.status === "failed" || phase.status === "skipped") {
      return clonePhase(phase);
    }

    if (phase.status === "running") {
      return {
        ...clonePhase(phase),
        status: "ready"
      };
    }

    if (phase.deps.every((dep) => verified.has(dep))) {
      return {
        ...clonePhase(phase),
        status: "ready"
      };
    }

    return {
      ...clonePhase(phase),
      status: "blocked"
    };
  });
}

function clonePhase(phase: PhaseState): PhaseState {
  return {
    ...phase,
    deps: [...phase.deps]
  };
}
