import { relative } from "node:path";

import { scaffoldInit } from "../../scaffold/project";
import { UsageError } from "../../util/errors";
import type { CommandDefinition } from "../types";

export const initCommand: CommandDefinition = {
  name: "init",
  summary: "Scaffold Lupe project files.",
  usage: "lupe init",
  async run(context) {
    if (context.args.length > 0) {
      throw new UsageError("lupe init does not accept positional arguments.");
    }

    const result = await scaffoldInit({
      cwd: context.flags.cwd,
      logger: context.logger
    });
    const rel = (path: string) => relative(result.cwd, path);

    context.logger.info(`Initialized Lupe in ${result.cwd}.`);
    context.logger.info(`Config: ${rel(result.configPath)}${result.configCreated ? "" : " (existing)"}`);
    context.logger.info(`State: ${rel(result.statePath)}`);
    if (result.firstItemPath !== undefined) {
      context.logger.info(`First work item: ${rel(result.firstItemPath)}`);
    } else {
      context.logger.info("First work item: existing queue preserved");
    }
    context.logger.info(
      `Skills: ${result.skills.written.length} written, ${result.skills.skipped.length} existing`
    );
    return 0;
  }
};
