export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface LoggerOptions {
  verbose?: boolean;
  quiet?: boolean;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
}

export interface Logger {
  readonly level: LogLevel;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = resolveLevel(options);
  const stdout = options.stdout ?? ((message: string) => process.stdout.write(message));
  const stderr = options.stderr ?? ((message: string) => process.stderr.write(message));

  function enabled(messageLevel: LogLevel): boolean {
    return levelPriority[messageLevel] >= levelPriority[level] && level !== "silent";
  }

  function write(
    messageLevel: Exclude<LogLevel, "silent">,
    sink: (message: string) => void,
    message: string
  ): void {
    if (!enabled(messageLevel)) {
      return;
    }
    sink(`${message}\n`);
  }

  return {
    level,
    debug: (message) => write("debug", stderr, message),
    info: (message) => write("info", stdout, message),
    warn: (message) => write("warn", stderr, message),
    error: (message) => write("error", stderr, message)
  };
}

function resolveLevel(options: LoggerOptions): LogLevel {
  if (options.quiet) {
    return "error";
  }

  if (options.verbose) {
    return "debug";
  }

  return "info";
}
