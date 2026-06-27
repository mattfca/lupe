import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { INTERNAL_DIR } from "../fs/contract";
import { WORK_ITEMS_DIR } from "../planner/persist";

export const RUNS_DIR = "runs";
export const RUN_ID_WIDTH = 3;

export interface RunArtifactPaths {
  runsDir: string;
  runId: string;
  runDir: string;
  promptPath: string;
  outputPath: string;
  diffSummaryPath: string;
  subagentsPath: string;
  verificationPath: string;
}

export interface ResolveRunArtifactsOptions {
  cwd?: string;
  internalDir?: string;
  workItemId: string;
  runId: string;
}

export interface CreateRunArtifactsOptions {
  cwd?: string;
  internalDir?: string;
  workItemId: string;
  prompt: string;
  verification?: string;
}

export interface CompleteRunArtifactsOptions {
  paths: RunArtifactPaths;
  output: string;
  diffSummary: string;
  subagents?: string;
}

export async function createRunArtifacts(options: CreateRunArtifactsOptions): Promise<RunArtifactPaths> {
  const runsDir = resolveRunsDir(options);
  await mkdir(runsDir, { recursive: true });

  const paths = await allocateRunDirectory(options);
  await writeNew(paths.promptPath, normalizeMarkdown(options.prompt));
  await writeNew(
    paths.verificationPath,
    normalizeMarkdown(options.verification ?? "Verification report pending Phase 06 execution.")
  );

  return paths;
}

export async function completeRunArtifacts(options: CompleteRunArtifactsOptions): Promise<void> {
  await writeNew(options.paths.outputPath, normalizeMarkdown(options.output));
  await writeNew(options.paths.diffSummaryPath, normalizeMarkdown(options.diffSummary));
  await writeNew(
    options.paths.subagentsPath,
    normalizeMarkdown(options.subagents ?? "No subagent activity was reported.")
  );
}

export function resolveRunArtifactPaths(options: ResolveRunArtifactsOptions): RunArtifactPaths {
  const runsDir = resolveRunsDir(options);
  const runDir = join(runsDir, options.runId);

  return {
    runsDir,
    runId: options.runId,
    runDir,
    promptPath: join(runDir, "prompt.md"),
    outputPath: join(runDir, "output.md"),
    diffSummaryPath: join(runDir, "diff-summary.md"),
    subagentsPath: join(runDir, "subagents.md"),
    verificationPath: join(runDir, "verification.md")
  };
}

export async function listRunIds(options: { cwd?: string; internalDir?: string; workItemId: string }): Promise<string[]> {
  const runsDir = resolveRunsDir(options);
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return entries.filter(isRunId).sort();
}

function resolveRunsDir(options: { cwd?: string; internalDir?: string; workItemId: string }): string {
  return join(
    resolve(options.cwd ?? process.cwd()),
    options.internalDir ?? INTERNAL_DIR,
    WORK_ITEMS_DIR,
    options.workItemId,
    RUNS_DIR
  );
}

async function nextRunId(runsDir: string): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      entries = [];
    } else {
      throw error;
    }
  }

  const numbers = entries.filter(isRunId).map((entry) => Number(entry.slice("run-".length)));
  const next = numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
  return `run-${String(next).padStart(RUN_ID_WIDTH, "0")}`;
}

async function allocateRunDirectory(options: CreateRunArtifactsOptions): Promise<RunArtifactPaths> {
  const runsDir = resolveRunsDir(options);
  let candidate = Number((await nextRunId(runsDir)).slice("run-".length));

  while (true) {
    const runId = `run-${String(candidate).padStart(RUN_ID_WIDTH, "0")}`;
    const paths = resolveRunArtifactPaths({
      workItemId: options.workItemId,
      runId,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.internalDir === undefined ? {} : { internalDir: options.internalDir })
    });

    try {
      await mkdir(paths.runDir, { recursive: false });
      return paths;
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        candidate += 1;
        continue;
      }
      throw error;
    }
  }
}

async function writeNew(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, {
    encoding: "utf8",
    flag: "wx"
  });
}

function normalizeMarkdown(contents: string): string {
  return contents.endsWith("\n") ? contents : `${contents}\n`;
}

function isRunId(value: string): boolean {
  return /^run-[0-9]{3}$/.test(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
