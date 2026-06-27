import type { CommandDefinition } from "../types";

export interface StubCommandOptions {
  name: string;
  summary: string;
  usage?: string;
}

export function createStubCommand(options: StubCommandOptions): CommandDefinition {
  return {
    name: options.name,
    summary: options.summary,
    usage: options.usage ?? `lupe ${options.name}`,
    run(context) {
      context.logger.info(
        `Command "${options.name}" is not implemented yet. This behavior is planned for a later phase.`
      );
      return 0;
    }
  };
}
