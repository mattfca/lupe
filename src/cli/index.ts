import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { commandMap, commands } from "./commands";
import type { CommandDefinition, GlobalFlags } from "./types";
import { exitCodeFor, formatError, UsageError } from "../util/errors";
import { createLogger } from "../util/logger";

export interface RunCliOptions {
  argv?: string[];
  cwd?: string;
  packageVersion?: string;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
}

interface ParsedArgv {
  commandName: string | null;
  commandArgs: string[];
  flags: GlobalFlags;
}

const helpText = `Usage:
  lupe [global options] <command> [command options]
  lupe --help
  lupe --version

Global options:
  --cwd <path>     Run as if Lupe was started in another directory.
  --verbose        Enable debug logging.
  --quiet          Suppress non-error output.
  --help, -h       Show help.
  --version, -v    Show the Lupe version.

Commands:
${commands.map((command) => `  ${command.name.padEnd(12)} ${command.summary}`).join("\n")}
`;

export async function runCli(options: RunCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((message: string) => process.stdout.write(message));
  const stderr = options.stderr ?? ((message: string) => process.stderr.write(message));

  try {
    const parsed = parseArgv(options.argv ?? Bun.argv.slice(2), options.cwd ?? process.cwd());

    if (parsed.flags.version) {
      stdout(`${options.packageVersion ?? readPackageVersion()}\n`);
      return 0;
    }

    if (parsed.flags.help && parsed.commandName === null) {
      stdout(helpText);
      return 0;
    }

    if (parsed.commandName === null) {
      stdout(helpText);
      return 0;
    }

    const command = commandMap.get(parsed.commandName);
    if (command === undefined) {
      throw new UsageError(
        `Unknown command "${parsed.commandName}". Run "lupe --help" to see available commands.`
      );
    }

    if (parsed.flags.help) {
      stdout(commandHelp(command));
      return 0;
    }

    const logger = createLogger({
      verbose: parsed.flags.verbose,
      quiet: parsed.flags.quiet,
      stdout,
      stderr
    });

    return await command.run({
      args: parsed.commandArgs,
      flags: parsed.flags,
      logger
    });
  } catch (error) {
    stderr(`${formatError(error)}\n`);
    return exitCodeFor(error);
  }
}

export function parseArgv(argv: string[], cwd: string): ParsedArgv {
  const flags: GlobalFlags = {
    cwd: resolve(cwd),
    verbose: false,
    quiet: false,
    help: false,
    version: false
  };

  let commandName: string | null = null;
  const commandArgs: string[] = [];
  let passThrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === undefined) {
      continue;
    }

    if (passThrough) {
      commandArgs.push(arg);
      continue;
    }

    if (arg === "--") {
      passThrough = true;
      continue;
    }

    if (arg === "--cwd") {
      const value = argv[index + 1];
      if (value === undefined || value.trim() === "") {
        throw new UsageError("--cwd requires a path value.");
      }
      flags.cwd = resolve(cwd, value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--cwd=")) {
      const value = arg.slice("--cwd=".length);
      if (value.trim() === "") {
        throw new UsageError("--cwd requires a path value.");
      }
      flags.cwd = resolve(cwd, value);
      continue;
    }

    if (arg === "--verbose") {
      flags.verbose = true;
      continue;
    }

    if (arg === "--quiet") {
      flags.quiet = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }

    if (arg === "--version" || arg === "-v") {
      flags.version = true;
      continue;
    }

    if (commandName === null) {
      if (arg.startsWith("-")) {
        throw new UsageError(`Unknown global option "${arg}".`);
      }
      commandName = arg;
      continue;
    }

    commandArgs.push(arg);
  }

  if (flags.quiet && flags.verbose) {
    throw new UsageError("--quiet and --verbose cannot be used together.");
  }

  return {
    commandName,
    commandArgs,
    flags
  };
}

function commandHelp(command: CommandDefinition): string {
  return `Usage:
  ${command.usage}

${command.summary}
`;
}

function readPackageVersion(): string {
  const packageJsonPath = new URL("../../package.json", import.meta.url);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
}

if (import.meta.main) {
  const exitCode = await runCli();
  process.exit(exitCode);
}
