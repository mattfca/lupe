export enum ExitCode {
  Ok = 0,
  Unexpected = 1,
  Usage = 2,
  Config = 3,
  Contract = 4,
  NotImplemented = 10
}

export interface LupeErrorOptions {
  code: string;
  exitCode: ExitCode;
  cause?: unknown;
}

export class LupeError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  override readonly cause?: unknown;

  constructor(message: string, options: LupeErrorOptions) {
    super(message);
    this.name = "LupeError";
    this.code = options.code;
    this.exitCode = options.exitCode;
    this.cause = options.cause;
  }
}

export class UsageError extends LupeError {
  constructor(message: string, cause?: unknown) {
    super(message, {
      code: "LUPE_USAGE_ERROR",
      exitCode: ExitCode.Usage,
      cause
    });
    this.name = "UsageError";
  }
}

export class ConfigError extends LupeError {
  constructor(message: string, cause?: unknown) {
    super(message, {
      code: "LUPE_CONFIG_ERROR",
      exitCode: ExitCode.Config,
      cause
    });
    this.name = "ConfigError";
  }
}

export class ContractError extends LupeError {
  constructor(message: string, cause?: unknown) {
    super(message, {
      code: "LUPE_CONTRACT_ERROR",
      exitCode: ExitCode.Contract,
      cause
    });
    this.name = "ContractError";
  }
}

export class CommandNotImplementedError extends LupeError {
  constructor(command: string) {
    super(`Command "${command}" is not implemented yet.`, {
      code: "LUPE_COMMAND_NOT_IMPLEMENTED",
      exitCode: ExitCode.NotImplemented
    });
    this.name = "CommandNotImplementedError";
  }
}

export function isLupeError(error: unknown): error is LupeError {
  return error instanceof LupeError;
}

export function exitCodeFor(error: unknown): ExitCode {
  return isLupeError(error) ? error.exitCode : ExitCode.Unexpected;
}

export function formatError(error: unknown): string {
  if (isLupeError(error)) {
    return `${error.name}: ${error.message}`;
  }

  if (error instanceof Error) {
    return `UnexpectedError: ${error.message}`;
  }

  return `UnexpectedError: ${String(error)}`;
}
