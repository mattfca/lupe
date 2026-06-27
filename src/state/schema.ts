import type { Agent, Mode, ReviewMode } from "../config/schema";
import { ExitCode, LupeError } from "../util/errors";

export type CurrentStatus = "idle" | "active" | "halted";

export type WorkItemStatus =
  | "discovered"
  | "planned"
  | "running"
  | "verified"
  | "in_review"
  | "accepted"
  | "rejected"
  | "skipped";

export type TerminalWorkItemStatus = "accepted" | "rejected" | "skipped";

export type PhaseStatus =
  | "ready"
  | "planned"
  | "running"
  | "blocked"
  | "verified"
  | "failed"
  | "skipped";

export interface ProjectState {
  input: string;
  internal: string;
  agent: Agent;
  mode: Mode;
  review: ReviewMode;
  autoAccept: boolean;
  subagents: boolean;
  skills: boolean;
}

export interface CurrentState {
  status: CurrentStatus;
  workItem?: string;
  run?: string;
  integrationBranch?: string;
}

export interface PhaseState {
  id: string;
  status: PhaseStatus;
  deps: string[];
  branch?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface WorkItemState {
  id: string;
  status: WorkItemStatus;
  planned: boolean;
  verified: boolean;
  fileHash: string;
  currentPhase?: string;
  repairAttempts?: number;
  phases?: PhaseState[];
  finalReview?: string;
  completedAt?: string;
  rejectedAt?: string;
  skippedAt?: string;
  rejectionReason?: string;
  pr?: PullRequestState;
}

export interface PullRequestState {
  provider: string;
  url: string;
  base: string;
  head: string;
  openedAt: string;
  number?: number;
  title?: string;
}

export interface DecisionState {
  date: string;
  note: string;
}

export interface State {
  project: ProjectState;
  current: CurrentState;
  workItems: WorkItemState[];
  decisions: DecisionState[];
}

export class StateValidationError extends LupeError {
  constructor(message: string, cause?: unknown) {
    super(message, {
      code: "LUPE_STATE_INVALID",
      exitCode: ExitCode.Contract,
      cause
    });
    this.name = "StateValidationError";
  }
}

const currentStatuses = new Set<CurrentStatus>(["idle", "active", "halted"]);
const workItemStatuses = new Set<WorkItemStatus>([
  "discovered",
  "planned",
  "running",
  "verified",
  "in_review",
  "accepted",
  "rejected",
  "skipped"
]);
const phaseStatuses = new Set<PhaseStatus>([
  "ready",
  "planned",
  "running",
  "blocked",
  "verified",
  "failed",
  "skipped"
]);

export function isTerminalWorkItemStatus(status: WorkItemStatus): status is TerminalWorkItemStatus {
  return status === "accepted" || status === "rejected" || status === "skipped";
}

export function validateState(value: unknown): State {
  if (!isRecord(value)) {
    throw new StateValidationError("State must be a JSON object.");
  }

  const project = validateProjectState(value.project);
  const current = validateCurrentState(value.current);
  const workItems = validateWorkItems(value.workItems);
  const decisions = validateDecisions(value.decisions);

  return {
    project,
    current,
    workItems,
    decisions
  };
}

function validateProjectState(value: unknown): ProjectState {
  if (!isRecord(value)) {
    throw new StateValidationError("State field project must be an object.");
  }

  return {
    input: expectNonEmptyString(value.input, "project.input"),
    internal: expectNonEmptyString(value.internal, "project.internal"),
    agent: expectOneOf(value.agent, ["cursor"], "project.agent"),
    mode: expectOneOf(value.mode, ["auto"], "project.mode"),
    review: expectOneOf(value.review, ["per-item", "batch"], "project.review"),
    autoAccept: expectBoolean(value.autoAccept, "project.autoAccept"),
    subagents: expectBoolean(value.subagents, "project.subagents"),
    skills: expectBoolean(value.skills, "project.skills")
  };
}

function validateCurrentState(value: unknown): CurrentState {
  if (!isRecord(value)) {
    throw new StateValidationError("State field current must be an object.");
  }

  const status = expectSetMember(value.status, currentStatuses, "current.status");
  const current: CurrentState = { status };

  copyOptionalString(value, current, "workItem", "current.workItem");
  copyOptionalString(value, current, "run", "current.run");
  copyOptionalString(value, current, "integrationBranch", "current.integrationBranch");

  return current;
}

function validateWorkItems(value: unknown): WorkItemState[] {
  if (!Array.isArray(value)) {
    throw new StateValidationError("State field workItems must be an array.");
  }

  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new StateValidationError(`State field workItems[${index}] must be an object.`);
    }

    const id = expectNonEmptyString(item.id, `workItems[${index}].id`);
    if (seen.has(id)) {
      throw new StateValidationError(`State contains duplicate work item "${id}".`);
    }
    seen.add(id);

    const status = expectSetMember(item.status, workItemStatuses, `workItems[${index}].status`);
    const workItem: WorkItemState = {
      id,
      status,
      planned: expectBoolean(item.planned, `workItems[${index}].planned`),
      verified: expectBoolean(item.verified, `workItems[${index}].verified`),
      fileHash: expectNonEmptyString(item.fileHash, `workItems[${index}].fileHash`)
    };

    copyOptionalString(item, workItem, "currentPhase", `workItems[${index}].currentPhase`);
    copyOptionalInteger(item, workItem, "repairAttempts", `workItems[${index}].repairAttempts`);
    copyOptionalString(item, workItem, "finalReview", `workItems[${index}].finalReview`);
    copyOptionalString(item, workItem, "completedAt", `workItems[${index}].completedAt`);
    copyOptionalString(item, workItem, "rejectedAt", `workItems[${index}].rejectedAt`);
    copyOptionalString(item, workItem, "skippedAt", `workItems[${index}].skippedAt`);
    copyOptionalString(item, workItem, "rejectionReason", `workItems[${index}].rejectionReason`);

    if (item.phases !== undefined) {
      workItem.phases = validatePhases(item.phases, `workItems[${index}].phases`);
    }
    if (item.pr !== undefined) {
      workItem.pr = validatePullRequest(item.pr, `workItems[${index}].pr`);
    }

    return workItem;
  });
}

function validatePullRequest(value: unknown, field: string): PullRequestState {
  if (!isRecord(value)) {
    throw new StateValidationError(`State field ${field} must be an object.`);
  }

  const pr: PullRequestState = {
    provider: expectNonEmptyString(value.provider, `${field}.provider`),
    url: expectNonEmptyString(value.url, `${field}.url`),
    base: expectNonEmptyString(value.base, `${field}.base`),
    head: expectNonEmptyString(value.head, `${field}.head`),
    openedAt: expectNonEmptyString(value.openedAt, `${field}.openedAt`)
  };
  copyOptionalString(value, pr, "title", `${field}.title`);
  copyOptionalInteger(value, pr, "number", `${field}.number`);
  return pr;
}

function validatePhases(value: unknown, field: string): PhaseState[] {
  if (!Array.isArray(value)) {
    throw new StateValidationError(`State field ${field} must be an array.`);
  }

  const seen = new Set<string>();
  return value.map((phase, index) => {
    if (!isRecord(phase)) {
      throw new StateValidationError(`State field ${field}[${index}] must be an object.`);
    }

    const id = expectNonEmptyString(phase.id, `${field}[${index}].id`);
    if (seen.has(id)) {
      throw new StateValidationError(`State contains duplicate phase "${id}" in ${field}.`);
    }
    seen.add(id);

    const phaseState: PhaseState = {
      id,
      status: expectSetMember(phase.status, phaseStatuses, `${field}[${index}].status`),
      deps: expectStringArray(phase.deps, `${field}[${index}].deps`)
    };

    copyOptionalString(phase, phaseState, "branch", `${field}[${index}].branch`);
    copyOptionalString(phase, phaseState, "startedAt", `${field}[${index}].startedAt`);
    copyOptionalString(phase, phaseState, "completedAt", `${field}[${index}].completedAt`);

    return phaseState;
  });
}

function validateDecisions(value: unknown): DecisionState[] {
  if (!Array.isArray(value)) {
    throw new StateValidationError("State field decisions must be an array.");
  }

  return value.map((decision, index) => {
    if (!isRecord(decision)) {
      throw new StateValidationError(`State field decisions[${index}] must be an object.`);
    }

    return {
      date: expectNonEmptyString(decision.date, `decisions[${index}].date`),
      note: expectNonEmptyString(decision.note, `decisions[${index}].note`)
    };
  });
}

function copyOptionalString(
  source: Record<string, unknown>,
  target: object,
  key: string,
  field: string
): void {
  if (source[key] === undefined) {
    return;
  }
  (target as Record<string, unknown>)[key] = expectNonEmptyString(source[key], field);
}

function copyOptionalInteger(
  source: Record<string, unknown>,
  target: object,
  key: string,
  field: string
): void {
  if (source[key] === undefined) {
    return;
  }
  const value = source[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new StateValidationError(`State field ${field} must be a non-negative integer.`);
  }
  (target as Record<string, unknown>)[key] = value;
}

function expectStringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    throw new StateValidationError(`State field ${field} must be an array of non-empty strings.`);
  }

  return [...value];
}

function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new StateValidationError(`State field ${field} must be a boolean.`);
  }
  return value;
}

function expectNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new StateValidationError(`State field ${field} must be a non-empty string.`);
  }
  return value;
}

function expectOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new StateValidationError(
      `State field ${field} must be one of: ${allowed.map((item) => `"${item}"`).join(", ")}.`
    );
  }
  return value as T;
}

function expectSetMember<T extends string>(value: unknown, allowed: Set<T>, field: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new StateValidationError(`State field ${field} has invalid value "${String(value)}".`);
  }
  return value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
