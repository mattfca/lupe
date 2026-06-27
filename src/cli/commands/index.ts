import { acceptCommand } from "./accept";
import { acknowledgeCommand } from "./acknowledge";
import { initCommand } from "./init";
import { migrateCommand } from "./migrate";
import { newCommand } from "./new";
import { planCommand } from "./plan";
import { rejectCommand } from "./reject";
import { reviewCommand } from "./review";
import { runCommand } from "./run";
import { skipCommand } from "./skip";

import type { CommandDefinition } from "../types";

export const commands = [
  initCommand,
  migrateCommand,
  newCommand,
  planCommand,
  runCommand,
  reviewCommand,
  acceptCommand,
  rejectCommand,
  skipCommand,
  acknowledgeCommand
] satisfies CommandDefinition[];

export const commandMap = new Map(commands.map((command) => [command.name, command]));
