import { loadConfig } from "../../config/load";
import { acknowledgeAcceptedFileDrift } from "../../lifecycle/immutability";
import { loadQueue } from "../../queue/discover";
import { loadState, saveState } from "../../state/store";
import { UsageError } from "../../util/errors";
import type { CommandDefinition } from "../types";

export const acknowledgeCommand: CommandDefinition = {
  name: "acknowledge",
  summary: "Acknowledge a non-substantive accepted-item edit.",
  usage: "lupe acknowledge <id>",
  async run(context) {
    if (context.args.length !== 1) {
      throw new UsageError("lupe acknowledge requires exactly one work item id.");
    }

    const loaded = await loadConfig({ cwd: context.flags.cwd });
    const queue = await loadQueue(loaded, {
      logger: context.logger
    });
    const state = await loadState({
      cwd: loaded.cwd,
      config: loaded.config
    });
    const itemId = context.args[0] as string;
    const acknowledged = acknowledgeAcceptedFileDrift(state, queue.items, itemId);
    await saveState(acknowledged, {
      cwd: loaded.cwd,
      config: loaded.config
    });

    context.logger.info(`Acknowledged ${itemId}; stored accepted-file hash updated.`);
    return 0;
  }
};
