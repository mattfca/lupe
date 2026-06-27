import { ExitCode, LupeError } from "../util/errors";
import type { WorkItem } from "../queue/workItem";
import {
  isTerminalWorkItemStatus,
  type PhaseState,
  type State,
  type WorkItemState,
  type WorkItemStatus
} from "./schema";

export type TransitionTrigger =
  | "found"
  | "planned"
  | "started"
  | "resumed"
  | "verified"
  | "repair"
  | "repair_exhausted"
  | "final_review"
  | "accepted"
  | "rejected"
  | "skipped";

export type TransitionEvent =
  | {
      type: "plan_completed";
      phases?: PhaseState[];
      integrationBranch?: string;
    }
  | {
      type: "run_started";
      run?: string;
      integrationBranch?: string;
      currentPhase?: string;
    }
  | {
      type: "run_resumed";
      run?: string;
      currentPhase?: string;
    }
  | { type: "verify_passed" }
  | {
      type: "verify_failed";
      repairAttempts?: number;
      currentPhase?: string;
    }
  | {
      type: "repair_budget_exhausted";
      reason?: string;
      rejectedAt?: string;
    }
  | {
      type: "final_review_generated";
      finalReview?: string;
      integrationBranch?: string;
    }
  | {
      type: "accept";
      completedAt?: string;
    }
  | {
      type: "reject";
      reason?: string;
      rejectedAt?: string;
    }
  | {
      type: "skip";
      skippedAt?: string;
    };

export interface TransitionRule {
  from: WorkItemStatus | "new" | "any";
  to: WorkItemStatus;
  trigger: TransitionTrigger;
}

export type QueueEffect = "none" | "advance" | "halt";

export class IllegalTransitionError extends LupeError {
  constructor(itemId: string, from: WorkItemStatus, event: TransitionEvent) {
    super(`Illegal transition for work item "${itemId}": ${from} cannot handle ${event.type}.`, {
      code: "LUPE_ILLEGAL_TRANSITION",
      exitCode: ExitCode.Usage
    });
    this.name = "IllegalTransitionError";
  }
}

export const LEGAL_TRANSITIONS: readonly TransitionRule[] = [
  { from: "new", to: "discovered", trigger: "found" },
  { from: "discovered", to: "planned", trigger: "planned" },
  { from: "planned", to: "running", trigger: "started" },
  { from: "running", to: "running", trigger: "resumed" },
  { from: "running", to: "verified", trigger: "verified" },
  { from: "running", to: "running", trigger: "repair" },
  { from: "running", to: "rejected", trigger: "repair_exhausted" },
  { from: "running", to: "rejected", trigger: "rejected" },
  { from: "verified", to: "in_review", trigger: "final_review" },
  { from: "in_review", to: "accepted", trigger: "accepted" },
  { from: "in_review", to: "rejected", trigger: "rejected" },
  { from: "any", to: "skipped", trigger: "skipped" }
];

export function transition(state: State, itemId: string, event: TransitionEvent): State {
  const cloned = cloneState(state);
  const index = cloned.workItems.findIndex((item) => item.id === itemId);
  const item = cloned.workItems[index];

  if (item === undefined) {
    throw new IllegalTransitionError(itemId, "discovered", event);
  }

  const trigger = triggerFor(event);
  const to = targetStatusFor(item.status, trigger);
  if (to === null) {
    throw new IllegalTransitionError(itemId, item.status, event);
  }

  const updatedItem = applyEvent(item, to, event);
  cloned.workItems[index] = updatedItem;
  applyCurrentMetadata(cloned, event);

  return applyQueueEffect(cloned, updatedItem, queueEffectFor(to));
}

export function queueEffectFor(status: WorkItemStatus): QueueEffect {
  if (status === "accepted" || status === "skipped") {
    return "advance";
  }
  if (status === "rejected") {
    return "halt";
  }
  return "none";
}

export type SyncDiscoveredQueue = { items: readonly WorkItem[] } | readonly WorkItem[];

export function syncDiscovered(queue: SyncDiscoveredQueue, state: State): State {
  const items = isQueueObject(queue) ? queue.items : queue;
  const cloned = cloneState(state);
  const existingById = new Map(cloned.workItems.map((item) => [item.id, item]));
  const ordered: WorkItemState[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const existing = existingById.get(item.id);
    ordered.push(
      existing ?? {
        id: item.id,
        status: "discovered",
        planned: false,
        verified: false,
        fileHash: item.fileHash
      }
    );
    seen.add(item.id);
  }

  for (const existing of cloned.workItems) {
    if (!seen.has(existing.id)) {
      ordered.push(existing);
    }
  }

  return {
    ...cloned,
    workItems: ordered
  };
}

function targetStatusFor(from: WorkItemStatus, trigger: TransitionTrigger): WorkItemStatus | null {
  const rule = LEGAL_TRANSITIONS.find(
    (candidate) =>
      (candidate.from === from || candidate.from === "any") && candidate.trigger === trigger
  );

  return rule?.to ?? null;
}

function triggerFor(event: TransitionEvent): TransitionTrigger {
  switch (event.type) {
    case "plan_completed":
      return "planned";
    case "run_started":
      return "started";
    case "run_resumed":
      return "resumed";
    case "verify_passed":
      return "verified";
    case "verify_failed":
      return "repair";
    case "repair_budget_exhausted":
      return "repair_exhausted";
    case "final_review_generated":
      return "final_review";
    case "accept":
      return "accepted";
    case "reject":
      return "rejected";
    case "skip":
      return "skipped";
  }
}

function applyEvent(
  item: WorkItemState,
  status: WorkItemStatus,
  event: TransitionEvent
): WorkItemState {
  const updated: WorkItemState = {
    ...item,
    status,
    planned: item.planned || status === "planned" || status === "running" || status === "verified" || status === "in_review" || status === "accepted",
    verified: item.verified || status === "verified" || status === "in_review" || status === "accepted"
  };

  switch (event.type) {
    case "plan_completed":
      updated.planned = true;
      if (event.phases !== undefined) {
        updated.phases = event.phases.map((phase) => ({
          ...phase,
          deps: [...phase.deps]
        }));
      }
      break;
    case "run_started":
    case "run_resumed":
      updated.planned = true;
      setOptional(updated, "currentPhase", event.currentPhase);
      break;
    case "verify_passed":
      updated.verified = true;
      break;
    case "verify_failed":
      setOptional(updated, "repairAttempts", event.repairAttempts);
      setOptional(updated, "currentPhase", event.currentPhase);
      break;
    case "repair_budget_exhausted":
      setOptional(updated, "rejectionReason", event.reason);
      setOptional(updated, "rejectedAt", event.rejectedAt);
      break;
    case "final_review_generated":
      updated.verified = true;
      setOptional(updated, "finalReview", event.finalReview);
      break;
    case "accept":
      updated.verified = true;
      setOptional(updated, "completedAt", event.completedAt);
      break;
    case "reject":
      setOptional(updated, "rejectionReason", event.reason);
      setOptional(updated, "rejectedAt", event.rejectedAt);
      break;
    case "skip":
      setOptional(updated, "skippedAt", event.skippedAt);
      break;
  }

  return updated;
}

function applyQueueEffect(state: State, item: WorkItemState, effect: QueueEffect): State {
  if (effect === "halt") {
    return {
      ...state,
      current: {
        status: "halted",
        workItem: item.id
      }
    };
  }

  if (effect === "advance") {
    return advanceQueue(state);
  }

  return {
    ...state,
    current: {
      ...state.current,
      status: "active",
      workItem: item.id
    }
  };
}

function applyCurrentMetadata(state: State, event: TransitionEvent): void {
  switch (event.type) {
    case "plan_completed":
      setOptional(state.current, "integrationBranch", event.integrationBranch);
      break;
    case "run_started":
      setOptional(state.current, "run", event.run);
      setOptional(state.current, "integrationBranch", event.integrationBranch);
      break;
    case "run_resumed":
      setOptional(state.current, "run", event.run);
      break;
    case "verify_passed":
    case "verify_failed":
    case "repair_budget_exhausted":
      break;
    case "final_review_generated":
      setOptional(state.current, "integrationBranch", event.integrationBranch);
      break;
    case "accept":
    case "reject":
    case "skip":
      break;
  }
}

function advanceQueue(state: State): State {
  const next = state.workItems.find((item) => !isTerminalWorkItemStatus(item.status));

  if (next === undefined) {
    return {
      ...state,
      current: {
        status: "idle"
      }
    };
  }

  return {
    ...state,
    current: {
      status: "active",
      workItem: next.id
    }
  };
}

function cloneState(state: State): State {
  return {
    project: { ...state.project },
    current: { ...state.current },
    workItems: state.workItems.map(cloneWorkItem),
    decisions: state.decisions.map((decision) => ({ ...decision }))
  };
}

function cloneWorkItem(item: WorkItemState): WorkItemState {
  const cloned: WorkItemState = { ...item };
  if (item.phases !== undefined) {
    cloned.phases = item.phases.map((phase) => ({
      ...phase,
      deps: [...phase.deps]
    }));
  }
  return cloned;
}

function setOptional<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function isQueueObject(queue: SyncDiscoveredQueue): queue is { items: readonly WorkItem[] } {
  return "items" in queue;
}
