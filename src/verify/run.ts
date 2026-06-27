import { spawn } from "node:child_process";
import { resolve } from "node:path";

export interface VerifyCommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  startedAt: string;
  completedAt: string;
}

export interface VerifyRunResult {
  passed: boolean;
  commands: VerifyCommandResult[];
  durationMs: number;
  startedAt: string;
  completedAt: string;
  failedCommand?: VerifyCommandResult;
}

export interface RunVerifyCommandsOptions {
  cwd: string;
  commands: readonly string[];
  stopOnFailure?: boolean;
  env?: NodeJS.ProcessEnv;
}

export async function runVerifyCommands(options: RunVerifyCommandsOptions): Promise<VerifyRunResult> {
  const cwd = resolve(options.cwd);
  const stopOnFailure = options.stopOnFailure ?? true;
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const commands: VerifyCommandResult[] = [];

  for (const command of options.commands) {
    const result = await runVerifyCommand(command, {
      cwd,
      env: options.env ?? process.env
    });
    commands.push(result);

    if (result.exitCode !== 0 && stopOnFailure) {
      break;
    }
  }

  const completed = Date.now();
  const failedCommand = commands.find((command) => command.exitCode !== 0);
  return {
    passed: failedCommand === undefined,
    commands,
    durationMs: completed - started,
    startedAt,
    completedAt: new Date(completed).toISOString(),
    ...(failedCommand === undefined ? {} : { failedCommand })
  };
}

async function runVerifyCommand(
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<VerifyCommandResult> {
  return await new Promise((resolvePromise) => {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let spawnError: Error | undefined;

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code) => {
      const completed = Date.now();
      const stderrText = Buffer.concat(stderr).toString("utf8");
      resolvePromise({
        command,
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: spawnError === undefined ? stderrText : `${stderrText}${spawnError.message}\n`,
        durationMs: completed - started,
        startedAt,
        completedAt: new Date(completed).toISOString()
      });
    });
  });
}
