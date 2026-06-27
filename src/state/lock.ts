import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { INTERNAL_DIR } from "../fs/contract";
import { ExitCode, LupeError } from "../util/errors";

export const LOCK_FILENAME = "lock";
export const DEFAULT_STALE_LOCK_MS = 24 * 60 * 60 * 1000;

export interface LockMetadata {
  pid: number;
  run: string;
  acquiredAt: string;
}

export interface LockOptions {
  cwd?: string;
  internalDir?: string;
  runId?: string;
  pid?: number;
  now?: Date;
  staleAfterMs?: number;
}

export interface LockHandle {
  path: string;
  metadata: LockMetadata;
  release(): Promise<void>;
}

export type LockInspectResult =
  | {
      status: "unlocked";
      path: string;
    }
  | {
      status: "locked";
      path: string;
      metadata: LockMetadata;
      stale: boolean;
    };

export class LockConflictError extends LupeError {
  readonly metadata: LockMetadata;

  constructor(path: string, metadata: LockMetadata) {
    super(`Lupe lock is held by pid ${metadata.pid} for run "${metadata.run}" at ${path}.`, {
      code: "LUPE_LOCK_CONFLICT",
      exitCode: ExitCode.Usage
    });
    this.name = "LockConflictError";
    this.metadata = metadata;
  }
}

export class LockValidationError extends LupeError {
  constructor(message: string, cause?: unknown) {
    super(message, {
      code: "LUPE_LOCK_INVALID",
      exitCode: ExitCode.Contract,
      cause
    });
    this.name = "LockValidationError";
  }
}

export async function acquireLock(options: LockOptions = {}): Promise<LockHandle> {
  const path = resolveLockPath(options);
  const metadata = createLockMetadata(options);

  await mkdir(dirname(path), { recursive: true });

  const existing = await inspectLock(options);
  if (existing.status === "locked") {
    if (!existing.stale) {
      throw new LockConflictError(path, existing.metadata);
    }
    await rm(path, { force: true });
  }

  try {
    await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx"
    });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      const conflict = await inspectLock(options);
      if (conflict.status === "locked") {
        throw new LockConflictError(path, conflict.metadata);
      }
    }
    throw error;
  }

  return {
    path,
    metadata,
    release: () => releaseLock({ path, metadata })
  };
}

export async function releaseLock(handle: Pick<LockHandle, "path" | "metadata">): Promise<void> {
  let current: LockMetadata;
  try {
    current = await readLockMetadata(handle.path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  if (!sameLock(current, handle.metadata)) {
    return;
  }

  await rm(handle.path, { force: true });
}

export async function inspectLock(options: LockOptions = {}): Promise<LockInspectResult> {
  const path = resolveLockPath(options);

  let metadata: LockMetadata;
  try {
    metadata = await readLockMetadata(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        status: "unlocked",
        path
      };
    }
    throw error;
  }

  return {
    status: "locked",
    path,
    metadata,
    stale: isStaleLock(metadata, options)
  };
}

export async function withLock<T>(
  fn: (handle: LockHandle) => T | Promise<T>,
  options: LockOptions = {}
): Promise<T> {
  const handle = await acquireLock(options);
  try {
    return await fn(handle);
  } finally {
    await handle.release();
  }
}

export function resolveLockPath(options: LockOptions = {}): string {
  return join(resolve(options.cwd ?? process.cwd()), options.internalDir ?? INTERNAL_DIR, LOCK_FILENAME);
}

export function isStaleLock(metadata: LockMetadata, options: LockOptions = {}): boolean {
  const acquiredAtMs = Date.parse(metadata.acquiredAt);
  if (!Number.isFinite(acquiredAtMs)) {
    return true;
  }

  const nowMs = (options.now ?? new Date()).getTime();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_LOCK_MS;
  if (nowMs - acquiredAtMs > staleAfterMs) {
    return true;
  }

  return !isProcessAlive(metadata.pid);
}

function createLockMetadata(options: LockOptions): LockMetadata {
  const now = options.now ?? new Date();

  return {
    pid: options.pid ?? process.pid,
    run: options.runId ?? `run-${randomUUID()}`,
    acquiredAt: now.toISOString()
  };
}

async function readLockMetadata(path: string): Promise<LockMetadata> {
  const contents = await readFile(path, "utf8");
  let parsed: unknown;

  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new LockValidationError(`Failed to parse lock file ${path}.`, error);
  }

  if (!isRecord(parsed)) {
    throw new LockValidationError(`Lock file ${path} must contain an object.`);
  }

  const pid = parsed.pid;
  const run = parsed.run;
  const acquiredAt = parsed.acquiredAt;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) {
    throw new LockValidationError("Lock field pid must be a positive integer.");
  }
  if (typeof run !== "string" || run.trim() === "") {
    throw new LockValidationError("Lock field run must be a non-empty string.");
  }
  if (typeof acquiredAt !== "string" || acquiredAt.trim() === "") {
    throw new LockValidationError("Lock field acquiredAt must be a non-empty string.");
  }

  return {
    pid,
    run,
    acquiredAt
  };
}

function sameLock(left: LockMetadata, right: LockMetadata): boolean {
  return left.pid === right.pid && left.run === right.run && left.acquiredAt === right.acquiredAt;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
