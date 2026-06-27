import { relative } from "node:path";

import { scaffoldMigrate } from "../../scaffold/project";
import { UsageError } from "../../util/errors";
import type { CommandDefinition } from "../types";

export const migrateCommand: CommandDefinition = {
  name: "migrate",
  summary: "Convert SCOPE.md into a queued work item.",
  usage: "lupe migrate",
  async run(context) {
    if (context.args.length > 0) {
      throw new UsageError("lupe migrate does not accept positional arguments.");
    }

    const result = await scaffoldMigrate({
      cwd: context.flags.cwd,
      logger: context.logger
    });
    const rel = (path: string) => relative(result.cwd, path);

    context.logger.info(`Migrated ${rel(result.sourcePath)} into ${rel(result.migratedItemPath)}.`);
    context.logger.info(`Config: ${rel(result.configPath)}${result.configCreated ? "" : " (existing)"}`);
    context.logger.info(`State: ${rel(result.statePath)}`);
    context.logger.info(
      `Skills: ${result.skills.written.length} written, ${result.skills.skipped.length} existing`
    );
    return 0;
  }
};
