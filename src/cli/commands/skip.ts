import { loadConfig } from "../../config/load";
import { skipWorkItem } from "../../lifecycle/accept";
import { UsageError } from "../../util/errors";
import type { CommandDefinition } from "../types";

export const skipCommand: CommandDefinition = {
  name: "skip",
  summary: "Skip the current work item.",
  usage: "lupe skip",
  async run(context) {
    if (context.args.length > 0) {
      throw new UsageError("lupe skip does not accept positional arguments.");
    }

    const loaded = await loadConfig({ cwd: context.flags.cwd });
    const result = await skipWorkItem({
      cwd: loaded.cwd,
      config: loaded.config
    });

    context.logger.info(`Skipped ${result.workItemId}.`);
    return 0;
  }
};
