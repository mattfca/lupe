import { spawn } from "node:child_process";

import type { WorkItem } from "../queue/workItem";
import { ConfigError, UsageError } from "../util/errors";
import type {
  AgentAdapter,
  PhaseExecutionContext,
  PhaseExecutionResult,
  PhaseRepairContext,
  PlanningContext,
  PlanningResult
} from "./index";

export interface CursorAgentAdapterOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

export function createCursorAgentAdapter(options: CursorAgentAdapterOptions = {}): AgentAdapter {
  return new CursorAgentAdapter(options);
}

export class CursorAgentAdapter implements AgentAdapter {
  readonly name = "cursor";

  private readonly command: string;
  private readonly args: string[];
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: CursorAgentAdapterOptions = {}) {
    this.command = options.command ?? process.env.LUPE_CURSOR_COMMAND ?? "cursor-agent";
    this.args = options.args ?? commandArgsFromEnv();
    this.env = options.env ?? process.env;
  }

  async plan(workItem: WorkItem, context: PlanningContext): Promise<PlanningResult> {
    if (!(await commandAvailable(this.command, context.cwd, this.env))) {
      throw new ConfigError(
        `Cursor planning command "${this.command}" is not available. Set LUPE_CURSOR_COMMAND to a planning command that accepts a prompt on stdin and returns JSON.`
      );
    }

    const output = await runCommand(this.command, this.args, buildPlanningPrompt(workItem, context.config), {
      cwd: context.cwd,
      env: this.env
    });

    return parsePlanningResult(output);
  }

  async executePhase(_workItem: WorkItem, _phase: unknown, context: PhaseExecutionContext): Promise<PhaseExecutionResult> {
    return await this.executePrompt(context);
  }

  async repairPhase(_workItem: WorkItem, _phase: unknown, context: PhaseRepairContext): Promise<PhaseExecutionResult> {
    return await this.executePrompt(context);
  }

  private async executePrompt(context: PhaseExecutionContext): Promise<PhaseExecutionResult> {
    if (!(await commandAvailable(this.command, context.worktreePath, this.env))) {
      throw new ConfigError(
        `Cursor agent command "${this.command}" is not available. Set LUPE_CURSOR_COMMAND to an agent command that accepts a prompt on stdin.`
      );
    }

    const output = await runCommand(this.command, this.args, context.prompt, {
      cwd: context.worktreePath,
      env: this.env
    });

    return { output };
  }
}

function commandArgsFromEnv(): string[] {
  const raw = process.env.LUPE_CURSOR_ARGS;
  if (raw === undefined || raw.trim() === "") {
    return [];
  }
  return raw.split(/\s+/).filter((arg) => arg.length > 0);
}

function buildPlanningPrompt(workItem: WorkItem, config: PlanningContext["config"]): string {
  return `You are planning a Lupe work item.

Return only JSON with this shape:
{
  "phases": [
    {
      "id": "phase-001",
      "title": "Short title",
      "goal": "Outcome for this phase",
      "scope": ["Implementation boundaries"],
      "deps": [],
      "acceptanceHints": ["How to know this phase is done"]
    }
  ]
}

Work item id: ${workItem.id}
Work item path: ${workItem.path}

Configuration:
- config.subagents: ${config.subagents}
- config.skills: ${config.skills}

${workItem.contents}
`;
}

async function commandAvailable(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const result = await runCommand("sh", ["-c", `command -v ${shellQuote(command)}`], "", {
    cwd,
    env,
    allowFailure: true
  });
  return result.trim().length > 0;
}

interface RunCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  allowFailure?: boolean;
}

async function runCommand(
  command: string,
  args: string[],
  input: string,
  options: RunCommandOptions
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (options.allowFailure) {
        resolve("");
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0 && !options.allowFailure) {
        reject(new UsageError(`Cursor planning command failed${errorOutput ? `: ${errorOutput}` : "."}`));
        return;
      }
      resolve(output);
    });

    child.stdin.end(input);
  });
}

function parsePlanningResult(output: string): PlanningResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new UsageError("Cursor planning command must return JSON.", error);
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.phases)) {
    throw new UsageError('Cursor planning command output must contain a "phases" array.');
  }

  return {
    phases: parsed.phases as PlanningResult["phases"]
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
