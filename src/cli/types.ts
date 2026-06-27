import type { Logger } from "../util/logger";

export interface GlobalFlags {
  cwd: string;
  verbose: boolean;
  quiet: boolean;
  help: boolean;
  version: boolean;
}

export interface CommandContext {
  args: string[];
  flags: GlobalFlags;
  logger: Logger;
}

export interface CommandDefinition {
  name: string;
  summary: string;
  usage: string;
  run(context: CommandContext): Promise<number> | number;
}
