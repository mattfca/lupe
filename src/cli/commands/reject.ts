import { loadConfig } from "../../config/load";
import { rejectWorkItem } from "../../lifecycle/accept";
import type { CommandDefinition } from "../types";

export const rejectCommand: CommandDefinition = {
  name: "reject",
  summary: "Reject the current work item.",
  usage: "lupe reject [reason]",
  async run(context) {
    const loaded = await loadConfig({ cwd: context.flags.cwd });
    const reason = context.args.join(" ").trim();
    const result = await rejectWorkItem({
      cwd: loaded.cwd,
      config: loaded.config,
      logger: context.logger,
      ...(reason === "" ? {} : { reason })
    });

    context.logger.info(`Rejected ${result.workItemId}; queue halted.`);
    return 0;
  }
};
