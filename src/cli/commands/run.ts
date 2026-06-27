import type { AgentAdapter } from "../../agent";
import { loadConfig } from "../../config/load";
import type { PullRequestProvider } from "../../git/pr";
import { runEngine, runQueue } from "../../runner/engine";
import { UsageError } from "../../util/errors";
import type { CommandDefinition } from "../types";

export interface RunCommandOptions {
  agent?: AgentAdapter;
  prProvider?: PullRequestProvider;
}

interface ParsedRunArgs {
  all: boolean;
  autoAccept: boolean;
}

export function createRunCommand(options: RunCommandOptions = {}): CommandDefinition {
  return {
    name: "run",
    summary: "Run planned work phases.",
    usage: "lupe run [--all] [--auto-accept]",
    async run(context) {
      const parsed = parseRunArgs(context.args);

      const loaded = await loadConfig({ cwd: context.flags.cwd });
      if (parsed.all) {
        const result = await runQueue({
          cwd: loaded.cwd,
          config: loaded.config,
          logger: context.logger,
          autoAccept: parsed.autoAccept,
          ...(options.agent === undefined ? {} : { agent: options.agent }),
          ...(options.prProvider === undefined ? {} : { prProvider: options.prProvider })
        });
        const accepted = result.processed.filter((item) => item.status === "accepted").length;
        const inReview = result.processed.filter((item) => item.status === "in_review").length;
        const rejected = result.processed.filter((item) => item.status === "rejected").length;

        context.logger.info(
          `Processed ${result.processed.length} item(s): ${accepted} accepted, ${inReview} in review, ${rejected} rejected.`
        );
        context.logger.info(`Stopped: ${result.stoppedReason}.`);
        return 0;
      }

      const result = await runEngine({
        cwd: loaded.cwd,
        config: loaded.config,
        logger: context.logger,
        ...(options.agent === undefined ? {} : { agent: options.agent })
      });

      if (result.workItemId === null) {
        return 0;
      }

      context.logger.info(
        `${result.resumed ? "Resumed" : "Ran"} ${result.workItemId}; completed ${result.phasesRun.length} phase(s).`
      );
      return 0;
    }
  };
}

export const runCommand = createRunCommand();

export function parseRunArgs(args: readonly string[]): ParsedRunArgs {
  let all = false;
  let autoAccept = false;

  for (const arg of args) {
    if (arg === "--all") {
      all = true;
      continue;
    }

    if (arg === "--auto-accept") {
      autoAccept = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new UsageError(`Unknown run option "${arg}".`);
    }

    throw new UsageError("lupe run does not accept positional arguments.");
  }

  if (autoAccept && !all) {
    throw new UsageError("lupe run --auto-accept requires --all.");
  }

  return { all, autoAccept };
}
