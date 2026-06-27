import { loadConfig } from "../../config/load";
import { acceptWorkItem } from "../../lifecycle/accept";
import type { PullRequestProvider } from "../../git/pr";
import { UsageError } from "../../util/errors";
import type { CommandDefinition } from "../types";

export interface AcceptCommandOptions {
  prProvider?: PullRequestProvider;
}

export function createAcceptCommand(options: AcceptCommandOptions = {}): CommandDefinition {
  return {
    name: "accept",
    summary: "Accept reviewed work.",
    usage: "lupe accept",
    async run(context) {
      if (context.args.length > 0) {
        throw new UsageError("lupe accept does not accept positional arguments.");
      }

      const loaded = await loadConfig({ cwd: context.flags.cwd });
      const result = await acceptWorkItem({
        cwd: loaded.cwd,
        config: loaded.config,
        logger: context.logger,
        ...(options.prProvider === undefined ? {} : { prProvider: options.prProvider })
      });

      context.logger.info(`Accepted ${result.workItemId}; opened PR ${result.pr.url}.`);
      return 0;
    }
  };
}

export const acceptCommand = createAcceptCommand();
