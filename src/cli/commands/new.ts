import { relative } from "node:path";

import { createNewWorkItem } from "../../scaffold/project";
import { UsageError } from "../../util/errors";
import type { CommandDefinition } from "../types";

export const newCommand: CommandDefinition = {
  name: "new",
  summary: "Create a new queued work item.",
  usage: 'lupe new "work item title"',
  async run(context) {
    if (context.args.length === 0) {
      throw new UsageError('lupe new requires a title, for example: lupe new "fix signup redirect".');
    }

    const result = await createNewWorkItem({
      cwd: context.flags.cwd,
      title: context.args.join(" ")
    });

    context.logger.info(`Created work item ${result.id}: ${relative(result.cwd, result.path)}`);
    return 0;
  }
};
