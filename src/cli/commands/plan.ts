import type { AgentAdapter } from "../../agent";
import { createCursorAgentAdapter } from "../../agent/cursor";
import { loadConfig } from "../../config/load";
import { loadQueue } from "../../queue/discover";
import { withLock } from "../../state/lock";
import { loadState, saveState } from "../../state/store";
import { planWorkItem, selectPlanTargets, syncQueueIntoState } from "../../planner/plan";
import { UsageError } from "../../util/errors";
import type { CommandDefinition } from "../types";

export interface PlanCommandOptions {
  agent?: AgentAdapter;
}

interface ParsedPlanArgs {
  all: boolean;
  target?: string;
}

export function createPlanCommand(options: PlanCommandOptions = {}): CommandDefinition {
  return {
    name: "plan",
    summary: "Plan phases for queued work.",
    usage: "lupe plan [--all] [target]",
    async run(context) {
      const parsed = parsePlanArgs(context.args);
      const loaded = await loadConfig({ cwd: context.flags.cwd });
      const adapter = options.agent ?? createCursorAgentAdapter();

      await withLock(
        async () => {
          const queue = await loadQueue(loaded, {
            logger: context.logger
          });
          let state = syncQueueIntoState(queue.items, await loadState({ cwd: loaded.cwd, config: loaded.config }), {
            immutableCompleted: loaded.config.input.immutableCompleted,
            logger: context.logger
          });
          await saveState(state, {
            cwd: loaded.cwd,
            config: loaded.config
          });

          const targets = selectPlanTargets({
            queueItems: queue.items,
            state,
            all: parsed.all,
            cwd: loaded.cwd,
            ...(parsed.target === undefined ? {} : { target: parsed.target })
          });

          if (targets.length === 0) {
            context.logger.info("No unplanned discovered work items.");
            return;
          }

          for (const item of targets) {
            const result = await planWorkItem(item, state, {
              cwd: loaded.cwd,
              config: loaded.config,
              agent: adapter,
              logger: context.logger
            });
            state = result.state;
            await saveState(state, {
              cwd: loaded.cwd,
              config: loaded.config
            });
            context.logger.info(
              `${result.replanned ? "Replanned" : "Planned"} ${item.id} with ${result.phases.length} phase(s).`
            );
          }
        },
        { cwd: loaded.cwd }
      );

      return 0;
    }
  };
}

export const planCommand = createPlanCommand();

export function parsePlanArgs(args: readonly string[]): ParsedPlanArgs {
  let all = false;
  let target: string | undefined;

  for (const arg of args) {
    if (arg === "--all") {
      all = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new UsageError(`Unknown plan option "${arg}".`);
    }

    if (target !== undefined) {
      throw new UsageError("lupe plan accepts at most one target.");
    }
    target = arg;
  }

  if (all && target !== undefined) {
    throw new UsageError("lupe plan accepts either --all or a target, not both.");
  }

  return target === undefined ? { all } : { all, target };
}
