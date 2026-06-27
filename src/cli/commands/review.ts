import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadConfig } from "../../config/load";
import { FINAL_REVIEW_FILES } from "../../integration/review";
import { resolveBatchReviewPaths } from "../../integration/batch";
import type { WorkItemState } from "../../state/schema";
import { loadState } from "../../state/store";
import { UsageError } from "../../util/errors";
import type { CommandDefinition } from "../types";

export const reviewCommand: CommandDefinition = {
  name: "review",
  summary: "Show the current review package.",
  usage: "lupe review",
  async run(context) {
    if (context.args.length > 0) {
      throw new UsageError("lupe review does not accept positional arguments.");
    }

    const loaded = await loadConfig({ cwd: context.flags.cwd });
    const state = await loadState({ cwd: loaded.cwd, config: loaded.config });
    const located = locateReviewPackage(loaded.cwd, state.current.workItem, state.workItems, loaded.config.review);
    const summary = await readSummary(located.absoluteDir);

    context.logger.info(`Review package: ${located.displayDir}`);
    context.logger.info("");
    context.logger.info(summary.trimEnd());
    context.logger.info("");
    context.logger.info("Review files:");
    for (const file of FINAL_REVIEW_FILES) {
      context.logger.info(`- ${join(located.displayDir, file)}`);
    }

    return 0;
  }
};

function locateReviewPackage(
  cwd: string,
  currentWorkItem: string | undefined,
  items: readonly WorkItemState[],
  reviewMode: "per-item" | "batch"
): { absoluteDir: string; displayDir: string } {
  if (reviewMode === "batch") {
    const paths = resolveBatchReviewPaths({ cwd });
    return {
      absoluteDir: paths.dir,
      displayDir: paths.relativeDir
    };
  }

  const item =
    (currentWorkItem === undefined ? undefined : items.find((candidate) => candidate.id === currentWorkItem)) ??
    items.find((candidate) => candidate.status === "in_review");

  if (item === undefined) {
    throw new UsageError("No current work item has a review package.");
  }
  if (item.finalReview === undefined) {
    throw new UsageError(`Work item "${item.id}" does not have a final review package yet.`);
  }

  return {
    absoluteDir: resolve(cwd, item.finalReview),
    displayDir: item.finalReview
  };
}

async function readSummary(reviewDir: string): Promise<string> {
  try {
    return await readFile(join(reviewDir, "summary.md"), "utf8");
  } catch (error) {
    throw new UsageError(`Review package is missing summary.md at ${reviewDir}.`, error);
  }
}
