import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { INTERNAL_DIR } from "../fs/contract";
import { UsageError } from "../util/errors";

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitAdapterOptions {
  repoDir?: string;
  internalDir?: string;
}

export interface PhaseWorktreeOptions extends GitAdapterOptions {
  workItemId: string;
  phaseId: string;
  baseRef?: string;
}

export interface PhaseWorktree {
  branch: string;
  path: string;
}

export function phaseBranchName(workItemId: string, phaseId: string): string {
  return `lupe/${workItemId}/${phaseId}`;
}

export function phaseWorktreePath(options: PhaseWorktreeOptions): string {
  return join(
    resolve(options.repoDir ?? process.cwd()),
    options.internalDir ?? INTERNAL_DIR,
    "worktrees",
    options.workItemId,
    options.phaseId
  );
}

export async function createPhaseWorktree(options: PhaseWorktreeOptions): Promise<PhaseWorktree> {
  const repoDir = resolve(options.repoDir ?? process.cwd());
  const branch = phaseBranchName(options.workItemId, options.phaseId);
  const path = phaseWorktreePath(options);

  if (await worktreeExists(repoDir, path)) {
    return { branch, path };
  }

  await mkdir(dirname(path), { recursive: true });
  await runGit(repoDir, [
    "worktree",
    "add",
    "--force",
    "-B",
    branch,
    path,
    options.baseRef ?? "HEAD"
  ]);

  return { branch, path };
}

export async function captureDiffSummary(worktreePath: string): Promise<string> {
  const status = await runGit(worktreePath, ["status", "--short"], { allowFailure: true });
  const stat = await runGit(worktreePath, ["diff", "--stat", "HEAD"], { allowFailure: true });
  const names = await runGit(worktreePath, ["diff", "--name-status", "HEAD"], { allowFailure: true });

  const sections = [
    "# Diff Summary",
    "",
    "## Status",
    "",
    status.stdout.trim() === "" ? "Clean working tree." : fenced(status.stdout.trim()),
    "",
    "## Stat",
    "",
    stat.stdout.trim() === "" ? "No tracked diff." : fenced(stat.stdout.trim()),
    "",
    "## Changed Files",
    "",
    names.stdout.trim() === "" ? "No tracked file changes." : fenced(names.stdout.trim())
  ];

  return `${sections.join("\n")}\n`;
}

export async function removeWorktree(repoDir: string, worktreePath: string): Promise<void> {
  await runGit(resolve(repoDir), ["worktree", "remove", "--force", worktreePath], { allowFailure: true });
  await rm(worktreePath, { recursive: true, force: true });
}

export async function deleteBranch(repoDir: string, branch: string): Promise<void> {
  await runGit(resolve(repoDir), ["branch", "-D", branch], { allowFailure: true });
}

export async function runGit(
  cwd: string,
  args: readonly string[],
  options: { allowFailure?: boolean } = {}
): Promise<GitCommandResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (options.allowFailure) {
        resolvePromise({ stdout: "", stderr: messageFor(error) });
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      };
      if (code !== 0 && options.allowFailure !== true) {
        reject(new UsageError(`git ${args.join(" ")} failed${result.stderr.trim() ? `: ${result.stderr.trim()}` : "."}`));
        return;
      }
      resolvePromise(result);
    });
  });
}

async function worktreeExists(repoDir: string, path: string): Promise<boolean> {
  const result = await runGit(repoDir, ["worktree", "list", "--porcelain"], { allowFailure: true });
  return result.stdout
    .split(/\r?\n/)
    .some((line) => line === `worktree ${path}`);
}

function fenced(value: string): string {
  return `\`\`\`\n${value}\n\`\`\``;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
