import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { DEFAULT_CONFIG, type LupeConfig } from "../config/schema";
import { INTERNAL_DIR } from "../fs/contract";
import { renderStateMarkdown } from "./render";
import { StateValidationError, validateState, type ProjectState, type State } from "./schema";

export const STATE_FILENAME = "state.json";
export const STATE_MARKDOWN_FILENAME = "STATE.md";

export interface StateStoreOptions {
  cwd?: string;
  internalDir?: string;
  config?: LupeConfig;
}

export interface StateStorePaths {
  cwd: string;
  internalDir: string;
  statePath: string;
  renderedStatePath: string;
}

export async function loadState(options: StateStoreOptions = {}): Promise<State> {
  const paths = resolveStateStorePaths(options);

  let contents: string;
  try {
    contents = await readFile(paths.statePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return createInitialState(options.config, options.internalDir);
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new StateValidationError(`Failed to parse ${paths.statePath} as JSON.`, error);
  }

  return validateState(parsed);
}

export async function saveState(state: State, options: StateStoreOptions = {}): Promise<void> {
  const paths = resolveStateStorePaths(options);
  const validState = validateState(state);

  await mkdir(paths.internalDir, { recursive: true });
  await writeFileAtomic(paths.statePath, `${JSON.stringify(validState, null, 2)}\n`);
  await writeFileAtomic(paths.renderedStatePath, renderStateMarkdown(validState));
}

export function createInitialState(
  config: LupeConfig = DEFAULT_CONFIG,
  internalDir = INTERNAL_DIR
): State {
  return {
    project: createProjectState(config, internalDir),
    current: {
      status: "idle"
    },
    workItems: [],
    decisions: []
  };
}

export function resolveStateStorePaths(options: StateStoreOptions = {}): StateStorePaths {
  const cwd = resolve(options.cwd ?? process.cwd());
  const internalDir = resolve(cwd, options.internalDir ?? INTERNAL_DIR);

  return {
    cwd,
    internalDir,
    statePath: join(internalDir, STATE_FILENAME),
    renderedStatePath: join(internalDir, STATE_MARKDOWN_FILENAME)
  };
}

async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });

  const tempPath = join(dir, `.${process.pid}.${randomUUID()}.${basename(path)}.tmp`);
  try {
    await writeFile(tempPath, contents, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await removeTempFile(tempPath);
    throw error;
  }
}

async function removeTempFile(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // Best-effort cleanup after a failed atomic write.
  }
}

function createProjectState(config: LupeConfig, internalDir: string): ProjectState {
  return {
    input: config.input.dir,
    internal: internalDir,
    agent: config.agent,
    mode: config.mode,
    review: config.review,
    autoAccept: config.autoAccept,
    subagents: config.subagents,
    skills: config.skills
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
