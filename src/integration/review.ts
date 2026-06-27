import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { LupeConfig, ReviewMode } from "../config/schema";
import { INTERNAL_DIR } from "../fs/contract";
import { runGit } from "../git";
import type { PersistedPlan } from "../planner/persist";
import { WORK_ITEMS_DIR } from "../planner/persist";
import type { WorkItem } from "../queue/workItem";
import { transition } from "../state/machine";
import type { PhaseState, State, WorkItemState } from "../state/schema";
import { UsageError } from "../util/errors";
import { runVerifyCommands, type VerifyRunResult } from "../verify/run";
import { mergeVerifiedPhases, type IntegrationMergeResult } from "./merge";

export const FINAL_REVIEW_DIR = "final-review";
export const FINAL_REVIEW_FILES = [
  "summary.md",
  "phase-summary.md",
  "diff-summary.md",
  "verification.md",
  "risks.md",
  "unresolved-items.md"
] as const;

export type FinalReviewFile = (typeof FINAL_REVIEW_FILES)[number];

export interface FinalReviewPaths {
  dir: string;
  relativeDir: string;
  summaryPath: string;
  phaseSummaryPath: string;
  diffSummaryPath: string;
  verificationPath: string;
  risksPath: string;
  unresolvedItemsPath: string;
}

export interface GenerateFinalReviewPackageOptions {
  cwd?: string;
  internalDir?: string;
  generatedAt?: Date;
  reviewMode: ReviewMode;
  workItem: WorkItem;
  itemState: WorkItemState;
  plan: PersistedPlan;
  merge: IntegrationMergeResult;
  verification: VerifyRunResult;
}

export interface FinalReviewPackage {
  paths: FinalReviewPaths;
  summary: string;
  phaseSummary: string;
  diffSummary: string;
  verification: string;
  risks: string;
  unresolvedItems: string;
}

export interface IntegrateAndReviewOptions {
  cwd?: string;
  internalDir?: string;
  config: LupeConfig;
  workItem: WorkItem;
  itemState: WorkItemState;
  plan: PersistedPlan;
  generatedAt?: Date;
}

export interface IntegrateAndReviewResult {
  merge: IntegrationMergeResult;
  verification: VerifyRunResult;
  review: FinalReviewPackage;
}

export function resolveFinalReviewPaths(
  workItemId: string,
  options: { cwd?: string; internalDir?: string } = {}
): FinalReviewPaths {
  const cwd = resolve(options.cwd ?? process.cwd());
  const relativeDir = join(options.internalDir ?? INTERNAL_DIR, WORK_ITEMS_DIR, workItemId, FINAL_REVIEW_DIR);
  const dir = join(cwd, relativeDir);

  return {
    dir,
    relativeDir,
    summaryPath: join(dir, "summary.md"),
    phaseSummaryPath: join(dir, "phase-summary.md"),
    diffSummaryPath: join(dir, "diff-summary.md"),
    verificationPath: join(dir, "verification.md"),
    risksPath: join(dir, "risks.md"),
    unresolvedItemsPath: join(dir, "unresolved-items.md")
  };
}

export async function integrateAndReviewWorkItem(
  options: IntegrateAndReviewOptions
): Promise<IntegrateAndReviewResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const merge = await mergeVerifiedPhases({
    repoDir: cwd,
    workItemId: options.workItem.id,
    phases: requirePhases(options.itemState),
    ...(options.internalDir === undefined ? {} : { internalDir: options.internalDir })
  });
  const verification = await runVerifyCommands({
    cwd: merge.worktreePath,
    commands: options.config.verify
  });
  const review = await generateFinalReviewPackage({
    cwd,
    reviewMode: options.config.review,
    workItem: options.workItem,
    itemState: options.itemState,
    plan: options.plan,
    merge,
    verification,
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
    ...(options.internalDir === undefined ? {} : { internalDir: options.internalDir })
  });

  if (!verification.passed) {
    throw new UsageError(
      `Integrated verification failed for "${options.workItem.id}". See ${review.paths.verificationPath}.`
    );
  }

  return {
    merge,
    verification,
    review
  };
}

export async function generateFinalReviewPackage(
  options: GenerateFinalReviewPackageOptions
): Promise<FinalReviewPackage> {
  const generatedAt = options.generatedAt ?? new Date();
  const paths = resolveFinalReviewPaths(options.workItem.id, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.internalDir === undefined ? {} : { internalDir: options.internalDir })
  });
  const diffSummary = await renderDiffSummary(options.merge);
  const rendered = {
    summary: renderSummaryMarkdown({
      generatedAt,
      reviewMode: options.reviewMode,
      workItem: options.workItem,
      itemState: options.itemState,
      plan: options.plan,
      merge: options.merge,
      verification: options.verification
    }),
    phaseSummary: renderPhaseSummaryMarkdown({
      plan: options.plan,
      phases: requirePhases(options.itemState),
      merge: options.merge
    }),
    diffSummary,
    verification: renderIntegratedVerificationMarkdown({
      workItemId: options.workItem.id,
      branch: options.merge.branch,
      worktreePath: options.merge.worktreePath,
      verification: options.verification
    }),
    risks: renderRisksMarkdown(options.verification),
    unresolvedItems: renderUnresolvedItemsMarkdown(options.verification)
  };

  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.summaryPath, rendered.summary, "utf8");
  await writeFile(paths.phaseSummaryPath, rendered.phaseSummary, "utf8");
  await writeFile(paths.diffSummaryPath, rendered.diffSummary, "utf8");
  await writeFile(paths.verificationPath, rendered.verification, "utf8");
  await writeFile(paths.risksPath, rendered.risks, "utf8");
  await writeFile(paths.unresolvedItemsPath, rendered.unresolvedItems, "utf8");

  return {
    paths,
    ...rendered
  };
}

export function transitionReviewGenerated(options: {
  state: State;
  workItemId: string;
  reviewPath: string;
  integrationBranch: string;
  generatedAt?: Date;
}): State {
  const generatedAt = options.generatedAt ?? new Date();
  const transitioned = transition(options.state, options.workItemId, {
    type: "final_review_generated",
    finalReview: options.reviewPath,
    integrationBranch: options.integrationBranch
  });

  return {
    ...transitioned,
    decisions: [
      ...transitioned.decisions,
      {
        date: generatedAt.toISOString(),
        note: `Generated final review for ${options.workItemId} on ${options.integrationBranch}: ${options.reviewPath}`
      }
    ]
  };
}

export async function readReviewSummary(path: string): Promise<string> {
  return await readFile(join(path, "summary.md"), "utf8");
}

export function renderSummaryMarkdown(options: {
  generatedAt: Date;
  reviewMode: ReviewMode;
  workItem: WorkItem;
  itemState: WorkItemState;
  plan: PersistedPlan;
  merge: IntegrationMergeResult;
  verification: VerifyRunResult;
}): string {
  const phases = requirePhases(options.itemState);
  const verifiedCount = phases.filter((phase) => phase.status === "verified").length;
  const skippedCount = phases.filter((phase) => phase.status === "skipped").length;

  return `${[
    `# Final Review: ${options.workItem.id}`,
    "",
    `- Generated: ${options.generatedAt.toISOString()}`,
    `- Review mode: ${options.reviewMode}`,
    `- Integration branch: ${options.merge.branch}`,
    `- Integration commit: ${options.merge.integrationCommit}`,
    `- Integrated verification: ${options.verification.passed ? "passed" : "failed"}`,
    `- Phases: ${verifiedCount} verified, ${skippedCount} skipped`,
    "",
    "## Work Item",
    "",
    `- Source: ${options.workItem.path}`,
    `- File hash: ${options.workItem.fileHash}`,
    "",
    "## Plan",
    "",
    `- Generated: ${options.plan.generatedAt}`,
    `- Phase count: ${options.plan.phases.length}`,
    "",
    "## Merge",
    "",
    `- Base: ${options.merge.baseRef} (${options.merge.baseCommit})`,
    `- Merged branches: ${options.merge.mergedPhases.length}`,
    "",
    "## Review Checklist",
    "",
    "- Inspect diff-summary.md for the integrated code delta.",
    "- Inspect verification.md for the integrated verification run.",
    "- Inspect risks.md and unresolved-items.md before accepting."
  ].join("\n")}\n`;
}

function renderPhaseSummaryMarkdown(options: {
  plan: PersistedPlan;
  phases: readonly PhaseState[];
  merge: IntegrationMergeResult;
}): string {
  const stateById = new Map(options.phases.map((phase) => [phase.id, phase]));
  const mergeById = new Map(options.merge.phases.map((phase) => [phase.id, phase]));
  const lines = ["# Phase Summary", ""];

  for (const phase of options.plan.phases) {
    const state = stateById.get(phase.id);
    const merged = mergeById.get(phase.id);
    lines.push(
      `## ${phase.id}: ${phase.title}`,
      "",
      `- Status: ${state?.status ?? "unknown"}`,
      `- Branch: ${merged?.branch ?? state?.branch ?? "none"}`,
      `- Commit: ${merged?.commit === "" || merged?.commit === undefined ? "none" : merged.commit}`,
      `- Dependencies: ${phase.deps.length === 0 ? "none" : phase.deps.join(", ")}`,
      "",
      phase.goal,
      ""
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

async function renderDiffSummary(merge: IntegrationMergeResult): Promise<string> {
  const stat = await runGit(merge.worktreePath, ["diff", "--stat", `${merge.baseCommit}..HEAD`], {
    allowFailure: true
  });
  const names = await runGit(merge.worktreePath, ["diff", "--name-status", `${merge.baseCommit}..HEAD`], {
    allowFailure: true
  });
  const log = await runGit(merge.worktreePath, ["log", "--oneline", `${merge.baseCommit}..HEAD`], {
    allowFailure: true
  });

  return `${[
    "# Diff Summary",
    "",
    `- Integration branch: ${merge.branch}`,
    `- Base commit: ${merge.baseCommit}`,
    `- Integration commit: ${merge.integrationCommit}`,
    "",
    "## Commit Log",
    "",
    fencedOrNone(log.stdout, "No integration commits."),
    "",
    "## Stat",
    "",
    fencedOrNone(stat.stdout, "No tracked diff."),
    "",
    "## Changed Files",
    "",
    fencedOrNone(names.stdout, "No tracked file changes.")
  ].join("\n")}\n`;
}

function renderIntegratedVerificationMarkdown(options: {
  workItemId: string;
  branch: string;
  worktreePath: string;
  verification: VerifyRunResult;
}): string {
  const lines = [
    "# Integrated Verification",
    "",
    `- Work item: ${options.workItemId}`,
    `- Branch: ${options.branch}`,
    `- Worktree: ${options.worktreePath}`,
    `- Status: ${options.verification.passed ? "passed" : "failed"}`,
    `- Duration: ${options.verification.durationMs}ms`,
    ""
  ];

  if (options.verification.commands.length === 0) {
    lines.push("No verification commands were configured.", "");
  }

  for (const command of options.verification.commands) {
    lines.push(
      `## Command: ${command.command}`,
      "",
      `- Exit code: ${command.exitCode}`,
      `- Duration: ${command.durationMs}ms`,
      "",
      "Stdout:",
      "",
      fenced(trimOrPlaceholder(command.stdout)),
      "",
      "Stderr:",
      "",
      fenced(trimOrPlaceholder(command.stderr)),
      ""
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderRisksMarkdown(verification: VerifyRunResult): string {
  const lines = ["# Risks", ""];
  if (verification.passed) {
    lines.push(
      "- Integrated verification passed.",
      "- Review the aggregate diff for cross-phase interactions before accepting."
    );
  } else {
    lines.push(
      "- Integrated verification failed.",
      "- Do not accept this work item until unresolved-items.md is addressed."
    );
  }

  return `${lines.join("\n")}\n`;
}

function renderUnresolvedItemsMarkdown(verification: VerifyRunResult): string {
  const failed = verification.failedCommand;
  if (failed === undefined) {
    return "# Unresolved Items\n\nNo unresolved items recorded.\n";
  }

  return `${[
    "# Unresolved Items",
    "",
    `- Integrated verification command failed: ${failed.command}`,
    `- Exit code: ${failed.exitCode}`,
    "",
    "## Stderr",
    "",
    fenced(trimOrPlaceholder(failed.stderr)),
    "",
    "## Stdout",
    "",
    fenced(trimOrPlaceholder(failed.stdout))
  ].join("\n")}\n`;
}

function requirePhases(item: WorkItemState): PhaseState[] {
  if (item.phases === undefined || item.phases.length === 0) {
    throw new UsageError(`Work item "${item.id}" does not have a phase plan.`);
  }

  return item.phases.map((phase) => ({
    ...phase,
    deps: [...phase.deps]
  }));
}

function fencedOrNone(value: string, placeholder: string): string {
  const trimmed = value.trim();
  return trimmed === "" ? placeholder : fenced(trimmed);
}

function fenced(value: string): string {
  return `\`\`\`\n${value}\n\`\`\``;
}

function trimOrPlaceholder(value: string): string {
  const trimmed = value.trim();
  return trimmed === "" ? "(empty)" : trimmed;
}

export function relativeReviewPath(cwd: string, path: string): string {
  const relativePath = relative(resolve(cwd), path);
  return relativePath === "" ? "." : relativePath;
}
