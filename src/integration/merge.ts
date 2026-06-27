import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { INTERNAL_DIR } from "../fs/contract";
import {
  deleteBranch,
  phaseBranchName,
  phaseWorktreePath,
  removeWorktree,
  runGit,
  type GitCommandResult
} from "../git";
import type { PhaseState } from "../state/schema";
import { ExitCode, LupeError, UsageError } from "../util/errors";

export interface IntegrationMergeOptions {
  repoDir?: string;
  internalDir?: string;
  workItemId: string;
  phases: readonly PhaseState[];
  baseRef?: string;
}

export interface IntegratedPhase {
  id: string;
  branch: string;
  commit: string;
  skipped: boolean;
}

export interface PhaseMergeResult extends IntegratedPhase {
  stdout: string;
  stderr: string;
}

export interface IntegrationMergeResult {
  workItemId: string;
  branch: string;
  temporaryBranch: string;
  worktreePath: string;
  baseRef: string;
  baseCommit: string;
  integrationCommit: string;
  phases: IntegratedPhase[];
  mergedPhases: PhaseMergeResult[];
}

export interface IntegrationConflictDetails {
  workItemId: string;
  branch: string;
  temporaryBranch: string;
  worktreePath: string;
  phaseId: string;
  phaseBranch: string;
  conflictedFiles: string[];
  status: string;
  stdout: string;
  stderr: string;
}

export class IntegrationConflictError extends LupeError {
  readonly details: IntegrationConflictDetails;

  constructor(details: IntegrationConflictDetails) {
    super(renderConflictMessage(details), {
      code: "LUPE_INTEGRATION_CONFLICT",
      exitCode: ExitCode.Usage
    });
    this.name = "IntegrationConflictError";
    this.details = details;
  }
}

export function integrationBranchName(workItemId: string): string {
  return `lupe/${workItemId}`;
}

export function temporaryIntegrationBranchName(workItemId: string): string {
  return `lupe-integration/${workItemId}`;
}

export function integrationWorktreePath(options: {
  repoDir?: string;
  internalDir?: string;
  workItemId: string;
}): string {
  return join(
    resolve(options.repoDir ?? process.cwd()),
    options.internalDir ?? INTERNAL_DIR,
    "worktrees",
    options.workItemId,
    "integration"
  );
}

export async function mergeVerifiedPhases(
  options: IntegrationMergeOptions
): Promise<IntegrationMergeResult> {
  const repoDir = resolve(options.repoDir ?? process.cwd());
  const internalDir = options.internalDir ?? INTERNAL_DIR;
  const baseRef = options.baseRef ?? "HEAD";
  const branch = integrationBranchName(options.workItemId);
  const temporaryBranch = temporaryIntegrationBranchName(options.workItemId);
  const worktreePath = integrationWorktreePath({
    repoDir,
    internalDir,
    workItemId: options.workItemId
  });

  const ordered = orderVerifiedPhases(options.phases);
  const integratedPhases = await resolveIntegratedPhases(repoDir, options.workItemId, ordered);
  const existingBranch = await branchExists(repoDir, branch);
  if (existingBranch && integratedPhases.every((phase) => phase.skipped)) {
    await ensureIntegrationWorktree(repoDir, worktreePath, branch, branch);
    return {
      workItemId: options.workItemId,
      branch,
      temporaryBranch,
      worktreePath,
      baseRef,
      baseCommit: await revParse(repoDir, `${branch}~0`),
      integrationCommit: await revParse(repoDir, branch),
      phases: integratedPhases,
      mergedPhases: []
    };
  }

  if (existingBranch) {
    throw new UsageError(
      `Integration branch "${branch}" already exists, but phase branches are still present. ` +
        "Accept or clean up the existing review before integrating again."
    );
  }

  for (const phase of ordered) {
    if (phase.status === "verified") {
      await commitPhaseWorktreeIfNeeded({
        repoDir,
        internalDir,
        workItemId: options.workItemId,
        phase
      });
    }
  }

  const refreshedPhases = await resolveIntegratedPhases(repoDir, options.workItemId, ordered);
  const baseCommit = await revParse(repoDir, baseRef);
  await ensureIntegrationWorktree(repoDir, worktreePath, temporaryBranch, baseCommit);

  const mergedPhases: PhaseMergeResult[] = [];
  for (const phase of refreshedPhases) {
    if (phase.skipped) {
      continue;
    }

    const result = await runGit(
      worktreePath,
      [
        "-c",
        "user.name=Lupe",
        "-c",
        "user.email=lupe@example.com",
        "merge",
        "--no-ff",
        "--no-edit",
        phase.branch
      ],
      { allowFailure: true }
    );

    if (await hasUnmergedFiles(worktreePath)) {
      throw await createConflictError({
        workItemId: options.workItemId,
        branch,
        temporaryBranch,
        worktreePath,
        phase,
        result
      });
    }

    mergedPhases.push({
      ...phase,
      stdout: result.stdout,
      stderr: result.stderr
    });
  }

  await removeIntegratedPhaseRefs({
    repoDir,
    internalDir,
    workItemId: options.workItemId,
    phases: refreshedPhases
  });
  await runGit(worktreePath, ["branch", "-M", branch]);

  return {
    workItemId: options.workItemId,
    branch,
    temporaryBranch,
    worktreePath,
    baseRef,
    baseCommit,
    integrationCommit: await revParse(worktreePath, "HEAD"),
    phases: refreshedPhases,
    mergedPhases
  };
}

function orderVerifiedPhases(phases: readonly PhaseState[]): PhaseState[] {
  const remaining = new Map(phases.map((phase) => [phase.id, clonePhase(phase)]));
  const ordered: PhaseState[] = [];
  const resolved = new Set<string>();

  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((phase) =>
      phase.deps.every((dep) => resolved.has(dep) || !remaining.has(dep))
    );
    if (ready.length === 0) {
      throw new UsageError("Cannot order phase branches for integration because the phase graph has a cycle.");
    }

    for (const phase of ready) {
      if (phase.status !== "verified" && phase.status !== "skipped") {
        throw new UsageError(
          `Phase "${phase.id}" is "${phase.status}" and cannot be integrated until it is verified or skipped.`
        );
      }
      ordered.push(phase);
      resolved.add(phase.id);
      remaining.delete(phase.id);
    }
  }

  return ordered;
}

async function resolveIntegratedPhases(
  repoDir: string,
  workItemId: string,
  phases: readonly PhaseState[]
): Promise<IntegratedPhase[]> {
  const integrated: IntegratedPhase[] = [];

  for (const phase of phases) {
    const branch = phase.branch ?? phaseBranchName(workItemId, phase.id);
    integrated.push({
      id: phase.id,
      branch,
      commit: phase.status === "skipped" ? "" : await revParse(repoDir, branch),
      skipped: phase.status === "skipped"
    });
  }

  return integrated;
}

async function commitPhaseWorktreeIfNeeded(options: {
  repoDir: string;
  internalDir: string;
  workItemId: string;
  phase: PhaseState;
}): Promise<void> {
  const worktreePath = phaseWorktreePath({
    repoDir: options.repoDir,
    internalDir: options.internalDir,
    workItemId: options.workItemId,
    phaseId: options.phase.id
  });
  const status = await runGit(worktreePath, ["status", "--porcelain"], { allowFailure: true });
  if (status.stdout.trim() === "") {
    return;
  }

  await runGit(worktreePath, ["add", "-A"]);
  await runGit(worktreePath, [
    "-c",
    "user.name=Lupe",
    "-c",
    "user.email=lupe@example.com",
    "commit",
    "-m",
    `Lupe phase ${options.phase.id}`
  ]);
}

async function ensureIntegrationWorktree(
  repoDir: string,
  worktreePath: string,
  branch: string,
  startPoint: string
): Promise<void> {
  if (await worktreeExists(repoDir, worktreePath)) {
    return;
  }

  await mkdir(dirname(worktreePath), { recursive: true });
  await runGit(repoDir, ["worktree", "add", "--force", "-B", branch, worktreePath, startPoint]);
}

async function removeIntegratedPhaseRefs(options: {
  repoDir: string;
  internalDir: string;
  workItemId: string;
  phases: readonly IntegratedPhase[];
}): Promise<void> {
  for (const phase of options.phases) {
    if (phase.skipped) {
      continue;
    }

    const path = phaseWorktreePath({
      repoDir: options.repoDir,
      internalDir: options.internalDir,
      workItemId: options.workItemId,
      phaseId: phase.id
    });
    await removeWorktree(options.repoDir, path);
    await deleteBranch(options.repoDir, phase.branch);
  }
}

async function createConflictError(options: {
  workItemId: string;
  branch: string;
  temporaryBranch: string;
  worktreePath: string;
  phase: IntegratedPhase;
  result: GitCommandResult;
}): Promise<IntegrationConflictError> {
  const conflicted = await runGit(options.worktreePath, ["diff", "--name-only", "--diff-filter=U"], {
    allowFailure: true
  });
  const status = await runGit(options.worktreePath, ["status", "--short"], { allowFailure: true });

  return new IntegrationConflictError({
    workItemId: options.workItemId,
    branch: options.branch,
    temporaryBranch: options.temporaryBranch,
    worktreePath: options.worktreePath,
    phaseId: options.phase.id,
    phaseBranch: options.phase.branch,
    conflictedFiles: lines(conflicted.stdout),
    status: status.stdout.trim(),
    stdout: options.result.stdout.trim(),
    stderr: options.result.stderr.trim()
  });
}

async function hasUnmergedFiles(worktreePath: string): Promise<boolean> {
  const result = await runGit(worktreePath, ["diff", "--name-only", "--diff-filter=U"], {
    allowFailure: true
  });
  return result.stdout.trim() !== "";
}

async function branchExists(repoDir: string, branch: string): Promise<boolean> {
  const result = await runGit(repoDir, ["branch", "--list", branch], { allowFailure: true });
  return result.stdout.trim() !== "";
}

async function worktreeExists(repoDir: string, path: string): Promise<boolean> {
  const result = await runGit(repoDir, ["worktree", "list", "--porcelain"], { allowFailure: true });
  return result.stdout.split(/\r?\n/).some((line) => line === `worktree ${path}`);
}

async function revParse(cwd: string, ref: string): Promise<string> {
  return (await runGit(cwd, ["rev-parse", ref])).stdout.trim();
}

function renderConflictMessage(details: IntegrationConflictDetails): string {
  const files =
    details.conflictedFiles.length === 0
      ? "- Git did not report specific conflicted files."
      : details.conflictedFiles.map((file) => `- ${file}`).join("\n");

  return [
    `Integration conflict while merging "${details.phaseBranch}" into "${details.branch}".`,
    "",
    "Conflicted files:",
    files,
    "",
    `Conflict worktree: ${details.worktreePath}`,
    `Temporary branch: ${details.temporaryBranch}`,
    "",
    "Resolve the conflicts in that worktree, commit the merge, then rerun integration.",
    details.status === "" ? "" : `\nGit status:\n${details.status}`,
    details.stderr === "" ? "" : `\nGit stderr:\n${details.stderr}`,
    details.stdout === "" ? "" : `\nGit stdout:\n${details.stdout}`
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function clonePhase(phase: PhaseState): PhaseState {
  return {
    ...phase,
    deps: [...phase.deps]
  };
}
