import type { WorkItem } from "../queue/workItem";
import type { State } from "../state/schema";
import { UsageError } from "../util/errors";
import type { Logger } from "../util/logger";

export interface AcceptedFileDrift {
  id: string;
  path: string;
  storedHash: string;
  currentHash: string;
  message: string;
  recommendation: string;
}

export interface DetectAcceptedFileDriftOptions {
  immutableCompleted?: boolean;
}

export function detectAcceptedFileDrift(
  queueItems: readonly WorkItem[],
  state: State,
  options: DetectAcceptedFileDriftOptions = {}
): AcceptedFileDrift[] {
  if (options.immutableCompleted === false) {
    return [];
  }

  const queueById = new Map(queueItems.map((item) => [item.id, item]));
  const drifts: AcceptedFileDrift[] = [];

  for (const item of state.workItems) {
    if (item.status !== "accepted") {
      continue;
    }

    const current = queueById.get(item.id);
    if (current === undefined || current.fileHash === item.fileHash) {
      continue;
    }

    drifts.push({
      id: item.id,
      path: current.path,
      storedHash: item.fileHash,
      currentHash: current.fileHash,
      message: `Accepted work item "${item.id}" has changed since acceptance.`,
      recommendation:
        "Accepted items are immutable. Create a new work item for substantive changes, or run `lupe acknowledge " +
        `${item.id}\` to re-hash a non-substantive edit.`
    });
  }

  return drifts;
}

export function warnAcceptedFileDrift(drifts: readonly AcceptedFileDrift[], logger?: Logger): void {
  for (const drift of drifts) {
    logger?.warn(`${drift.message} ${drift.recommendation}`);
  }
}

export function acknowledgeAcceptedFileDrift(
  state: State,
  queueItems: readonly WorkItem[],
  workItemId: string,
  options: { acknowledgedAt?: Date } = {}
): State {
  const queueItem = queueItems.find((item) => item.id === workItemId);
  if (queueItem === undefined) {
    throw new UsageError(`Work item "${workItemId}" is not present in the input queue.`);
  }

  let found = false;
  const acknowledgedAt = options.acknowledgedAt ?? new Date();
  const workItems = state.workItems.map((item) => {
    if (item.id !== workItemId) {
      return item;
    }
    found = true;
    if (item.status !== "accepted") {
      throw new UsageError(`Work item "${workItemId}" is "${item.status}" and cannot be acknowledged.`);
    }
    return {
      ...item,
      fileHash: queueItem.fileHash
    };
  });

  if (!found) {
    throw new UsageError(`Work item "${workItemId}" is not in state.`);
  }

  return {
    ...state,
    workItems,
    decisions: [
      ...state.decisions,
      {
        date: acknowledgedAt.toISOString(),
        note: `Acknowledged accepted-file edit for ${workItemId}; stored hash updated.`
      }
    ]
  };
}
