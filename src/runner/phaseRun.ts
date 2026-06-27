import type { AgentAdapter, PhaseExecutionResult } from "../agent";
import type { LupeConfig } from "../config/schema";
import { captureDiffSummary } from "../git";
import type { PersistedPlanPhase } from "../planner/persist";
import type { WorkItem } from "../queue/workItem";
import { UsageError } from "../util/errors";
import { completeRunArtifacts, createRunArtifacts, type RunArtifactPaths } from "./artifacts";

export interface RunPhaseOptions {
  cwd: string;
  config: LupeConfig;
  agent: AgentAdapter;
  workItem: WorkItem;
  phase: PersistedPlanPhase;
  worktreePath: string;
  branch: string;
}

export interface RunPhaseResult {
  runId: string;
  artifacts: RunArtifactPaths;
  output: string;
  diffSummary: string;
  subagents: string;
}

export async function runPhase(options: RunPhaseOptions): Promise<RunPhaseResult> {
  if (options.agent.executePhase === undefined) {
    throw new UsageError(`Agent adapter "${options.agent.name}" cannot execute phases.`);
  }

  const prompt = renderPhasePrompt(options);
  const artifacts = await createRunArtifacts({
    cwd: options.cwd,
    workItemId: options.workItem.id,
    prompt,
    verification: "Verification report pending Phase 06 execution."
  });

  let execution: PhaseExecutionResult;
  try {
    execution = await options.agent.executePhase(options.workItem, options.phase, {
      cwd: options.cwd,
      worktreePath: options.worktreePath,
      branch: options.branch,
      runId: artifacts.runId,
      prompt,
      config: options.config,
      subagents: options.config.subagents,
      skills: options.config.skills
    });
  } catch (error) {
    const diffSummary = await captureDiffSummary(options.worktreePath);
    const message = error instanceof Error ? error.message : String(error);
    await completeRunArtifacts({
      paths: artifacts,
      output: `Phase execution failed before completion.\n\n${message}`,
      diffSummary,
      subagents: "No subagent activity was reported before failure."
    });
    throw error;
  }

  const diffSummary = await captureDiffSummary(options.worktreePath);
  const subagents = execution.subagents ?? "No subagent activity was reported.";
  await completeRunArtifacts({
    paths: artifacts,
    output: execution.output,
    diffSummary,
    subagents
  });

  return {
    runId: artifacts.runId,
    artifacts,
    output: execution.output,
    diffSummary,
    subagents
  };
}

export function renderPhasePrompt(options: RunPhaseOptions): string {
  return `${[
    `# Lupe Phase Run: ${options.phase.title}`,
    "",
    "You are executing one phase of a Lupe work item in an isolated git worktree.",
    "",
    "## Execution Context",
    "",
    `- Work item: ${options.workItem.id}`,
    `- Work item path: ${options.workItem.path}`,
    `- Phase: ${options.phase.id}`,
    `- Branch: ${options.branch}`,
    `- Worktree: ${options.worktreePath}`,
    `- Subagents enabled: ${options.config.subagents ? "yes" : "no"}`,
    `- Skills enabled: ${options.config.skills ? "yes" : "no"}`,
    "",
    "## Phase Goal",
    "",
    options.phase.goal,
    "",
    "## Scope",
    "",
    ...renderList(options.phase.scope),
    "",
    "## Dependencies",
    "",
    ...renderList(options.phase.deps),
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

function renderList(items: readonly string[]): string[] {
  return items.length === 0 ? ["- none"] : items.map((item) => `- ${item}`);
}
