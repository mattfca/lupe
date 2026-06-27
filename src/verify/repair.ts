import type { AgentAdapter, PhaseExecutionResult, PhaseRepairContext } from "../agent";
import type { LupeConfig } from "../config/schema";
import type { PersistedPlanPhase } from "../planner/persist";
import type { WorkItem } from "../queue/workItem";
import type { RunArtifactPaths } from "../runner/artifacts";
import { UsageError } from "../util/errors";
import { renderVerificationReport, summarizeVerifyFailure, writeVerificationReport, type VerificationReportAttempt } from "./report";
import { runVerifyCommands, type VerifyRunResult } from "./run";

export type VerificationRepairStatus = "verified" | "rejected";

export interface VerifyAndRepairPhaseOptions {
  cwd: string;
  config: LupeConfig;
  agent: AgentAdapter;
  workItem: WorkItem;
  phase: PersistedPlanPhase;
  worktreePath: string;
  branch: string;
  runId: string;
  artifacts: RunArtifactPaths;
  initialRepairAttempts?: number;
  onRepairAttempt?: (repairAttempts: number) => Promise<void> | void;
}

export interface VerifyAndRepairPhaseResult {
  status: VerificationRepairStatus;
  verification: VerifyRunResult;
  repairAttempts: number;
  attempts: VerificationReportAttempt[];
  reason?: string;
}

export async function verifyAndRepairPhase(
  options: VerifyAndRepairPhaseOptions
): Promise<VerifyAndRepairPhaseResult> {
  let repairAttempts = options.initialRepairAttempts ?? 0;
  const attempts: VerificationReportAttempt[] = [];

  let verification = await runVerifyCommands({
    cwd: options.worktreePath,
    commands: options.config.verify
  });
  attempts.push({
    label: "Initial Verification",
    verification
  });

  await writeProgressReport(options, attempts, verification, repairAttempts);
  if (verification.passed) {
    await writeFinalReport(options, attempts, "passed", repairAttempts, verification);
    return {
      status: "verified",
      verification,
      repairAttempts,
      attempts
    };
  }

  while (!verification.passed) {
    if (repairAttempts >= options.config.maxRepairAttempts) {
      const reason = summarizeVerifyFailure(verification);
      await writeFinalReport(options, attempts, "rejected", repairAttempts, verification, reason);
      return {
        status: "rejected",
        verification,
        repairAttempts,
        attempts,
        reason
      };
    }

    repairAttempts += 1;
    await options.onRepairAttempt?.(repairAttempts);

    const repair = await runRepairAttempt(options, verification, repairAttempts);
    verification = await runVerifyCommands({
      cwd: options.worktreePath,
      commands: options.config.verify
    });
    attempts.push({
      label: `Verification After Repair ${repairAttempts}`,
      repairAttempt: repairAttempts,
      repairOutput: repair.output,
      ...(repair.subagents === undefined ? {} : { repairSubagents: repair.subagents }),
      verification
    });

    await writeProgressReport(options, attempts, verification, repairAttempts);
  }

  await writeFinalReport(options, attempts, "repaired", repairAttempts, verification);
  return {
    status: "verified",
    verification,
    repairAttempts,
    attempts
  };
}

export function renderRepairPrompt(options: {
  workItem: WorkItem;
  phase: PersistedPlanPhase;
  branch: string;
  worktreePath: string;
  repairAttempt: number;
  maxRepairAttempts: number;
  verification: VerifyRunResult;
}): string {
  return `${[
    `# Lupe Verification Repair: ${options.phase.title}`,
    "",
    "You are repairing one Lupe phase in its isolated git worktree.",
    "",
    "## Execution Context",
    "",
    `- Work item: ${options.workItem.id}`,
    `- Work item path: ${options.workItem.path}`,
    `- Phase: ${options.phase.id}`,
    `- Branch: ${options.branch}`,
    `- Worktree: ${options.worktreePath}`,
    `- Repair attempt: ${options.repairAttempt}/${options.maxRepairAttempts}`,
    "",
    "## Instructions",
    "",
    "- Use the verification failure below to make the smallest correct repair.",
    "- Keep the fix scoped to this phase and worktree.",
    "- Do not commit, merge, open reviews, or start PR lifecycle work.",
    "- Stop after applying the repair; Lupe will rerun verification.",
    "",
    "## Failed Verification",
    "",
    summarizeVerifyFailure(options.verification),
    "",
    "## Phase Goal",
    "",
    options.phase.goal,
    "",
    "## Scope",
    "",
    ...renderList(options.phase.scope),
    "",
    "## Acceptance Hints",
    "",
    ...renderList(options.phase.acceptanceHints),
    "",
    "## Work Item",
    "",
    options.workItem.contents
  ].join("\n")}\n`;
}

async function runRepairAttempt(
  options: VerifyAndRepairPhaseOptions,
  verification: VerifyRunResult,
  repairAttempt: number
): Promise<PhaseExecutionResult> {
  const prompt = renderRepairPrompt({
    workItem: options.workItem,
    phase: options.phase,
    branch: options.branch,
    worktreePath: options.worktreePath,
    repairAttempt,
    maxRepairAttempts: options.config.maxRepairAttempts,
    verification
  });
  const context: PhaseRepairContext = {
    cwd: options.cwd,
    worktreePath: options.worktreePath,
    branch: options.branch,
    runId: options.runId,
    prompt,
    config: options.config,
    subagents: options.config.subagents,
    skills: options.config.skills,
    repairAttempt,
    maxRepairAttempts: options.config.maxRepairAttempts,
    failedVerification: renderVerificationReport({
      paths: options.artifacts,
      workItemId: options.workItem.id,
      phaseId: options.phase.id,
      finalStatus: "failed",
      repairAttempts: repairAttempt,
      maxRepairAttempts: options.config.maxRepairAttempts,
      attempts: [
        {
          label: "Failed Verification",
          verification
        }
      ]
    })
  };

  if (options.agent.repairPhase === undefined && options.agent.executePhase === undefined) {
    throw new UsageError(`Agent adapter "${options.agent.name}" cannot repair failed verification.`);
  }

  try {
    if (options.agent.repairPhase !== undefined) {
      return await options.agent.repairPhase(options.workItem, options.phase, context);
    }
    return await options.agent.executePhase!(options.workItem, options.phase, context);
  } catch (error) {
    return {
      output: `Repair attempt failed before completion.\n\n${messageFor(error)}`
    };
  }
}

async function writeProgressReport(
  options: VerifyAndRepairPhaseOptions,
  attempts: readonly VerificationReportAttempt[],
  verification: VerifyRunResult,
  repairAttempts: number
): Promise<void> {
  await writeFinalReport(
    options,
    attempts,
    verification.passed ? (repairAttempts === 0 ? "passed" : "repaired") : "failed",
    repairAttempts,
    verification
  );
}

async function writeFinalReport(
  options: VerifyAndRepairPhaseOptions,
  attempts: readonly VerificationReportAttempt[],
  finalStatus: "passed" | "repaired" | "failed" | "rejected",
  repairAttempts: number,
  verification: VerifyRunResult,
  failureReason?: string
): Promise<void> {
  await writeVerificationReport({
    paths: options.artifacts,
    workItemId: options.workItem.id,
    phaseId: options.phase.id,
    finalStatus,
    repairAttempts,
    maxRepairAttempts: options.config.maxRepairAttempts,
    attempts,
    ...(failureReason === undefined && !verification.passed
      ? { failureReason: summarizeVerifyFailure(verification) }
      : {}),
    ...(failureReason === undefined ? {} : { failureReason })
  });
}

function renderList(items: readonly string[]): string[] {
  return items.length === 0 ? ["- none"] : items.map((item) => `- ${item}`);
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
