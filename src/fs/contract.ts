import { basename } from "node:path";

import { ContractError } from "../util/errors";

export const INPUT_DIR = "lupe-queue";
export const INTERNAL_DIR = ".lupe";

export const DEFAULT_WORK_ITEM_PATTERN = "^[0-9]{8}T[0-9]{6}_.+\\.md$";

export const GENERATED_ARTIFACT_SEGMENTS = new Set([
  "state.json",
  "STATE.md",
  "lock",
  "work-items",
  "worktrees",
  "runs",
  "phases",
  "final-review",
  "plan.json",
  "prompt.md",
  "output.md",
  "verification.md",
  "diff-summary.md",
  "subagents.md",
  "summary.md",
  "phase-summary.md",
  "risks.md",
  "unresolved-items.md"
]);

export interface DirectoryContractOptions {
  inputDir?: string;
  internalDir?: string;
  workItemPattern?: string;
}

export function assertNoWorkItemsUnderInternal(
  paths: Iterable<string>,
  options: DirectoryContractOptions = {}
): void {
  const internalDir = options.internalDir ?? INTERNAL_DIR;
  const pattern = new RegExp(options.workItemPattern ?? DEFAULT_WORK_ITEM_PATTERN);

  for (const path of paths) {
    const normalizedPath = normalizePath(path);
    if (isUnderDirectory(normalizedPath, internalDir) && pattern.test(basename(normalizedPath))) {
      throw new ContractError(
        `Work item "${path}" is under ${internalDir}/. User-authored work items must live in ${options.inputDir ?? INPUT_DIR}/.`
      );
    }
  }
}

export function assertNoGeneratedArtifactsUnderInput(
  paths: Iterable<string>,
  options: DirectoryContractOptions = {}
): void {
  const inputDir = options.inputDir ?? INPUT_DIR;

  for (const path of paths) {
    const normalizedPath = normalizePath(path);
    if (!isUnderDirectory(normalizedPath, inputDir)) {
      continue;
    }

    const artifact = normalizedPath
      .split("/")
      .find((segment) => GENERATED_ARTIFACT_SEGMENTS.has(segment));

    if (artifact !== undefined) {
      throw new ContractError(
        `Generated artifact "${artifact}" appears under ${inputDir}/ at "${path}". Lupe-generated files must live under ${options.internalDir ?? INTERNAL_DIR}/.`
      );
    }
  }
}

export function validateDirectoryContract(
  paths: Iterable<string>,
  options: DirectoryContractOptions = {}
): void {
  const pathList = [...paths];
  assertNoWorkItemsUnderInternal(pathList, options);
  assertNoGeneratedArtifactsUnderInput(pathList, options);
}

export function isUnderDirectory(path: string, directory: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedDirectory = normalizePath(directory);
  const segments = normalizedPath.split("/");

  return segments.includes(normalizedDirectory);
}

export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}
