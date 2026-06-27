import { readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { LupeConfig } from "../config/schema";
import { INTERNAL_DIR } from "../fs/contract";
import { runGit, removeWorktree } from "../git";
import { integrationBranchName } from "../integration/merge";
import { createGhPullRequestProvider, type PullRequestInfo, type PullRequestProvider } from "../git/pr";
import { loadQueue } from "../queue/discover";
import type { WorkItem } from "../queue/workItem";
import type { State, WorkItemState } from "../state/schema";
import { loadState, saveState } from "../state/store";
import { UsageError } from "../util/errors";
import type { Logger } from "../util/logger";
import { applyTerminalQueuePolicy } from "./advance";
import { detectAcceptedFileDrift, warnAcceptedFileDrift } from "./immutability";

export interface AcceptWorkItemOptions {
  cwd?: string;
  internalDir?: string;
  config: LupeConfig;
  prProvider?: PullRequestProvider;
  now?: Date;
  logger?: Logger;
}

export interface AcceptWorkItemResult {
  state: State;
  workItemId: string;
  pr: PullRequestInfo;
  completedAt: string;
}

export interface RejectWorkItemOptions {
  cwd?: string;
  internalDir?: string;
  config: LupeConfig;
  reason?: string;
  now?: Date;
  logger?: Logger;
}

export interface RejectWorkItemResult {
  state: State;
  workItemId: string;
  rejectedAt: string;
}

export interface SkipWorkItemOptions {
  cwd?: string;
  config: LupeConfig;
  now?: Date;
}

export interface SkipWorkItemResult {
  state: State;
  workItemId: string;
  skippedAt: string;
}

export async function acceptWorkItem(options: AcceptWorkItemOptions): Promise<AcceptWorkItemResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const internalDir = options.internalDir ?? INTERNAL_DIR;
  const now = options.now ?? new Date();
  const queue = await loadQueue(options.config, {
    cwd,
    ...(options.logger === undefined ? {} : { logger: options.logger })
  });
  const state = await loadState({ cwd, internalDir, config: options.config });
  warnAcceptedFileDrift(
    detectAcceptedFileDrift(queue.items, state, {
      immutableCompleted: options.config.input.immutableCompleted
    }),
    options.logger
  );

  const item = selectAcceptableItem(state, options.config);
  const workItem = requireQueueItem(queue.items, item.id);
  const completedAt = now.toISOString();
  const head =
    state.current.workItem === item.id
      ? state.current.integrationBranch ?? integrationBranchName(item.id)
      : integrationBranchName(item.id);
  const prProvider = options.prProvider ?? createGhPullRequestProvider();
  const pr = await prProvider.openPullRequest({
    repoDir: cwd,
    base: "main",
    head,
    title: `Lupe: ${item.id}`,
    body: renderPullRequestBody(cwd, workItem, item)
  });

  const accepted = recordAccepted(state, item.id, {
    completedAt,
    fileHash: workItem.fileHash,
    pr
  });
  await saveState(accepted, { cwd, internalDir, config: options.config });
  await cleanupWorkItemWorktrees({
    repoDir: cwd,
    internalDir,
    workItemId: item.id
  });

  return {
    state: accepted,
    workItemId: item.id,
    pr,
    completedAt
  };
}

export async function rejectWorkItem(options: RejectWorkItemOptions): Promise<RejectWorkItemResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const internalDir = options.internalDir ?? INTERNAL_DIR;
  const state = await loadState({ cwd, internalDir, config: options.config });
  const item = selectRejectableItem(state);
  const rejectedAt = (options.now ?? new Date()).toISOString();
  const rejected = recordRejected(state, item.id, {
    rejectedAt,
    onItemRejected: options.config.onItemRejected,
    ...(options.reason === undefined ? {} : { reason: options.reason })
  });

  await saveState(rejected, { cwd, internalDir, config: options.config });
  await cleanupWorkItemWorktrees({
    repoDir: cwd,
    internalDir,
    workItemId: item.id
  });

  return {
    state: rejected,
    workItemId: item.id,
    rejectedAt
  };
}

export async function skipWorkItem(options: SkipWorkItemOptions): Promise<SkipWorkItemResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const state = await loadState({ cwd, config: options.config });
  const item = selectSkippableItem(state);
  const skippedAt = (options.now ?? new Date()).toISOString();
  const skipped = recordSkipped(state, item.id, {
    skippedAt
  });

  await saveState(skipped, { cwd, config: options.config });

  return {
    state: skipped,
    workItemId: item.id,
    skippedAt
  };
}

export function recordAccepted(
  state: State,
  workItemId: string,
  options: { completedAt: string; fileHash: string; pr: PullRequestInfo }
): State {
  const item = requireStateItem(state, workItemId);
  if (item.status !== "in_review" && item.status !== "verified") {
    throw new UsageError(`Work item "${workItemId}" cannot be accepted from status "${item.status}".`);
  }

  const updated = {
    ...state,
    workItems: state.workItems.map((candidate) =>
      candidate.id === workItemId
        ? {
            ...candidate,
            status: "accepted" as const,
            planned: true,
            verified: true,
            fileHash: options.fileHash,
            completedAt: options.completedAt,
            pr: {
              provider: options.pr.provider,
              url: options.pr.url,
              base: options.pr.base,
              head: options.pr.head,
              openedAt: options.completedAt,
              ...(options.pr.number === undefined ? {} : { number: options.pr.number }),
              ...(options.pr.title === undefined ? {} : { title: options.pr.title })
            }
          }
        : candidate
    ),
    decisions: [
      ...state.decisions,
      {
        date: options.completedAt,
        note: `Accepted ${workItemId}; opened PR ${options.pr.url}.`
      }
    ]
  };

  return applyTerminalQueuePolicy(updated, workItemId, "accepted");
}

export function recordRejected(
  state: State,
  workItemId: string,
  options: { rejectedAt: string; reason?: string; onItemRejected?: LupeConfig["onItemRejected"] }
): State {
  const item = requireStateItem(state, workItemId);
  if (!["running", "verified", "in_review"].includes(item.status)) {
    throw new UsageError(`Work item "${workItemId}" cannot be rejected from status "${item.status}".`);
  }

  const updated = {
    ...state,
    workItems: state.workItems.map((candidate) =>
      candidate.id === workItemId
        ? {
            ...candidate,
            status: "rejected" as const,
            rejectedAt: options.rejectedAt,
            ...(options.reason === undefined || options.reason.trim() === "" ? {} : { rejectionReason: options.reason })
          }
        : candidate
    ),
    decisions: [
      ...state.decisions,
      {
        date: options.rejectedAt,
        note: `Rejected ${workItemId}${options.reason === undefined ? "." : `: ${options.reason}`}`
      }
    ]
  };

  return applyTerminalQueuePolicy(updated, workItemId, "rejected", {
    ...(options.onItemRejected === undefined ? {} : { onItemRejected: options.onItemRejected })
  });
}

export function recordSkipped(
  state: State,
  workItemId: string,
  options: { skippedAt: string }
): State {
  const item = requireStateItem(state, workItemId);
  if (item.status === "accepted" || item.status === "rejected" || item.status === "skipped") {
    throw new UsageError(`Work item "${workItemId}" cannot be skipped from status "${item.status}".`);
  }

  const updated = {
    ...state,
    workItems: state.workItems.map((candidate) =>
      candidate.id === workItemId
        ? {
            ...candidate,
            status: "skipped" as const,
            skippedAt: options.skippedAt
          }
        : candidate
    ),
    decisions: [
      ...state.decisions,
      {
        date: options.skippedAt,
        note: `Skipped ${workItemId}.`
      }
    ]
  };

  return applyTerminalQueuePolicy(updated, workItemId, "skipped");
}

export async function cleanupWorkItemWorktrees(options: {
  repoDir?: string;
  internalDir?: string;
  workItemId: string;
}): Promise<void> {
  const repoDir = resolve(options.repoDir ?? process.cwd());
  const root = join(repoDir, options.internalDir ?? INTERNAL_DIR, "worktrees", options.workItemId);
  const entries = await readDirectory(root);

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await removeWorktree(repoDir, join(root, entry.name));
    }
  }

  await runGit(repoDir, ["worktree", "prune"], { allowFailure: true });
  await rm(root, { recursive: true, force: true });
}

function selectAcceptableItem(state: State, config: LupeConfig): WorkItemState {
  const current = currentStateItem(state);
  if (current?.status === "in_review") {
    return current;
  }
  if (config.autoAccept && current?.status === "verified") {
    return current;
  }
  const reviewable = state.workItems.find((item) => item.status === "in_review");
  if (reviewable !== undefined) {
    return reviewable;
  }
  throw new UsageError("No work item is in review and ready to accept.");
}

function selectRejectableItem(state: State): WorkItemState {
  const current = currentStateItem(state);
  if (current !== undefined && ["running", "verified", "in_review"].includes(current.status)) {
    return current;
  }
  const rejectable = state.workItems.find((item) => item.status === "in_review" || item.status === "running");
  if (rejectable !== undefined) {
    return rejectable;
  }
  throw new UsageError("No current work item can be rejected.");
}

function selectSkippableItem(state: State): WorkItemState {
  const current = currentStateItem(state);
  if (current !== undefined && !["accepted", "rejected", "skipped"].includes(current.status)) {
    return current;
  }
  const skippable = state.workItems.find((item) => !["accepted", "rejected", "skipped"].includes(item.status));
  if (skippable !== undefined) {
    return skippable;
  }
  throw new UsageError("No work item can be skipped.");
}

function currentStateItem(state: State): WorkItemState | undefined {
  const currentId = state.current.workItem;
  return currentId === undefined ? undefined : state.workItems.find((item) => item.id === currentId);
}

function requireStateItem(state: State, workItemId: string): WorkItemState {
  const item = state.workItems.find((candidate) => candidate.id === workItemId);
  if (item === undefined) {
    throw new UsageError(`Work item "${workItemId}" is not in state.`);
  }
  return item;
}

function requireQueueItem(queueItems: readonly WorkItem[], workItemId: string): WorkItem {
  const item = queueItems.find((candidate) => candidate.id === workItemId);
  if (item === undefined) {
    throw new UsageError(`Work item "${workItemId}" is not present in the input queue.`);
  }
  return item;
}

function renderPullRequestBody(cwd: string, workItem: WorkItem, itemState: WorkItemState): string {
  const review = itemState.finalReview ?? "No final review path recorded.";
  return [
    `Lupe acceptance for ${workItem.id}.`,
    "",
    `Work item: ${relative(cwd, workItem.path)}`,
    `Final review: ${review}`,
    "",
    "Review the generated package and merge this PR into main when ready."
  ].join("\n");
}

async function readDirectory(path: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
