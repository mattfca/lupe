import type { OnItemRejected } from "../config/schema";
import { isTerminalWorkItemStatus, type State, type WorkItemStatus } from "../state/schema";

export interface QueuePolicyOptions {
  onItemRejected?: OnItemRejected;
}

export function advanceQueue(state: State): State {
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

export function haltQueueOnRejected(state: State, workItemId: string): State {
  return {
    ...state,
    current: {
      status: "halted",
      workItem: workItemId
    }
  };
}

export function applyTerminalQueuePolicy(
  state: State,
  workItemId: string,
  status: WorkItemStatus,
  options: QueuePolicyOptions = {}
): State {
  if (status === "accepted" || status === "skipped") {
    return advanceQueue(state);
  }

  if (status === "rejected") {
    const onItemRejected = options.onItemRejected ?? "halt";
    if (onItemRejected === "halt") {
      return haltQueueOnRejected(state, workItemId);
    }
  }

  return state;
}
