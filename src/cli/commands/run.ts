import type { AgentAdapter } from "../../agent";
import { loadConfig } from "../../config/load";
import { runEngine } from "../../runner/engine";
import { UsageError } from "../../util/errors";
import type { CommandDefinition } from "../types";

export interface RunCommandOptions {
  agent?: AgentAdapter;
}

export function createRunCommand(options: RunCommandOptions = {}): CommandDefinition {
  return {
    name: "run",
    summary: "Run planned work phases.",
    usage: "lupe run",
    async run(context) {
      if (context.args.length > 0) {
        throw new UsageError("lupe run does not accept positional arguments yet.");
      }

      const loaded = await loadConfig({ cwd: context.flags.cwd });
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
