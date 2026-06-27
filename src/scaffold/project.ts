import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

import { CONFIG_FILENAME, loadConfig } from "../config/load";
import { INPUT_DIR } from "../fs/contract";
import { loadQueue } from "../queue/discover";
import { syncQueueIntoState } from "../planner/plan";
import { loadState, saveState } from "../state/store";
import { UsageError } from "../util/errors";
import type { Logger } from "../util/logger";
import { writeProjectSkills, type WriteProjectSkillsResult } from "./skills";
import {
  INITIAL_SCOPE_SLUG,
  renderConfigTemplate,
  renderInitialWorkItemTemplate,
  renderMigratedScopeWorkItem,
  renderNewWorkItemTemplate,
  slugifyTitle,
  workItemFilename
} from "./templates";

export interface ScaffoldProjectOptions {
  cwd?: string;
  now?: Date;
  logger?: Logger;
}

export interface ScaffoldInitResult {
  cwd: string;
  configPath: string;
  configCreated: boolean;
  inputDir: string;
  internalDir: string;
  firstItemPath?: string;
  statePath: string;
  skills: WriteProjectSkillsResult;
}

export interface ScaffoldMigrateResult extends ScaffoldInitResult {
  sourcePath: string;
  migratedItemPath: string;
}

export interface CreateNewWorkItemOptions extends ScaffoldProjectOptions {
  title: string;
}

export interface CreateNewWorkItemResult {
  cwd: string;
  path: string;
  id: string;
}

interface EnsureProjectScaffoldOptions extends ScaffoldProjectOptions {
  createInitialItem: boolean;
}

interface EnsureProjectScaffoldResult extends ScaffoldInitResult {
  config: Awaited<ReturnType<typeof loadConfig>>["config"];
}

export async function scaffoldInit(options: ScaffoldProjectOptions = {}): Promise<ScaffoldInitResult> {
  const result = await ensureProjectScaffold({
    ...options,
    createInitialItem: true
  });
  return stripConfig(result);
}

export async function scaffoldMigrate(options: ScaffoldProjectOptions = {}): Promise<ScaffoldMigrateResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const sourcePath = join(cwd, "SCOPE.md");
  let scopeContents: string;
  try {
    scopeContents = await readFile(sourcePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new UsageError("No SCOPE.md found to migrate.");
    }
    throw error;
  }

  const scaffold = await ensureProjectScaffold({
    ...options,
    cwd,
    createInitialItem: false
  });
  const inputDir = join(cwd, scaffold.config.input.dir);
  const existingInitial = (
    await loadQueue(scaffold.config, {
      cwd,
      ...(options.logger === undefined ? {} : { logger: options.logger })
    })
  ).items.find((item) => item.description === INITIAL_SCOPE_SLUG);
  let migratedItemPath: string | undefined;

  if (existingInitial === undefined) {
    migratedItemPath = await writeUniqueWorkItem({
      dir: inputDir,
      now: options.now ?? new Date(),
      slug: INITIAL_SCOPE_SLUG,
      contents: renderMigratedScopeWorkItem(scopeContents)
    });
  } else {
    migratedItemPath = existingInitial.path;
  }

  await refreshStateFromQueue(cwd, scaffold.config, options.logger);

  return {
    ...stripConfig(scaffold),
    sourcePath,
    migratedItemPath
  };
}

export async function createNewWorkItem(
  options: CreateNewWorkItemOptions
): Promise<CreateNewWorkItemResult> {
  const title = options.title.trim();
  if (title === "") {
    throw new UsageError('lupe new requires a title, for example: lupe new "fix signup redirect".');
  }

  const loaded = await loadConfig(options.cwd === undefined ? {} : { cwd: options.cwd });
  const inputDir = join(loaded.cwd, loaded.config.input.dir);
  await mkdir(inputDir, { recursive: true });
  const path = await writeUniqueWorkItem({
    dir: inputDir,
    now: options.now ?? new Date(),
    slug: slugifyTitle(title),
    contents: renderNewWorkItemTemplate(title)
  });

  return {
    cwd: loaded.cwd,
    path,
    id: basename(path, ".md")
  };
}

async function ensureProjectScaffold(
  options: EnsureProjectScaffoldOptions
): Promise<EnsureProjectScaffoldResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const loaded = await loadConfig({ cwd });
  const configPath = join(cwd, CONFIG_FILENAME);
  const configCreated = await writeConfigIfMissing(configPath);
  const inputDir = join(cwd, loaded.config.input.dir);
  await mkdir(inputDir, { recursive: true });

  let firstItemPath: string | undefined;
  let queue = await loadQueue(loaded.config, {
    cwd,
    ...(options.logger === undefined ? {} : { logger: options.logger })
  });
  if (options.createInitialItem && queue.items.length === 0) {
    firstItemPath = await writeUniqueWorkItem({
      dir: inputDir,
      now: options.now ?? new Date(),
      slug: INITIAL_SCOPE_SLUG,
      contents: renderInitialWorkItemTemplate()
    });
    queue = await loadQueue(loaded.config, {
      cwd,
      ...(options.logger === undefined ? {} : { logger: options.logger })
    });
  }

  const statePath = await refreshStateFromQueue(cwd, loaded.config, options.logger, queue.items);
  const skills = loaded.config.skills ? await writeProjectSkills({ cwd }) : { written: [], skipped: [] };

  return {
    cwd,
    config: loaded.config,
    configPath,
    configCreated,
    inputDir,
    internalDir: join(cwd, ".lupe"),
    ...(firstItemPath === undefined ? {} : { firstItemPath }),
    statePath,
    skills
  };
}

async function refreshStateFromQueue(
  cwd: string,
  config: Awaited<ReturnType<typeof loadConfig>>["config"],
  logger?: Logger,
  queueItems?: Awaited<ReturnType<typeof loadQueue>>["items"]
): Promise<string> {
  const items =
    queueItems ??
    (
      await loadQueue(config, {
        cwd,
        ...(logger === undefined ? {} : { logger })
      })
    ).items;
  const state = syncQueueIntoState(items, await loadState({ cwd, config }), {
    immutableCompleted: config.input.immutableCompleted,
    ...(logger === undefined ? {} : { logger })
  });
  await saveState(state, { cwd, config });
  return join(cwd, ".lupe", "state.json");
}

async function writeConfigIfMissing(configPath: string): Promise<boolean> {
  try {
    await writeFile(configPath, renderConfigTemplate(), { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

async function writeUniqueWorkItem(options: {
  dir: string;
  now: Date;
  slug: string;
  contents: string;
}): Promise<string> {
  for (let offsetSeconds = 0; offsetSeconds < 1000; offsetSeconds += 1) {
    const candidateDate = new Date(options.now.getTime() + offsetSeconds * 1000);
    const filename = workItemFilename(candidateDate, options.slug);
    const timestampPrefix = filename.slice(0, 15);
    if (await timestampPrefixExists(options.dir, timestampPrefix)) {
      continue;
    }

    const path = join(options.dir, filename);
    try {
      await writeFile(path, options.contents, { encoding: "utf8", flag: "wx" });
      return path;
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }

  throw new UsageError(
    `Could not allocate a unique work item filename in ${relative(process.cwd(), options.dir)}.`
  );
}

async function timestampPrefixExists(dir: string, prefix: string): Promise<boolean> {
  const entries = await readdir(dir);
  return entries.some((entry) => entry.startsWith(`${prefix}_`));
}

function stripConfig(result: EnsureProjectScaffoldResult): ScaffoldInitResult {
  return {
    cwd: result.cwd,
    configPath: result.configPath,
    configCreated: result.configCreated,
    inputDir: result.inputDir,
    internalDir: result.internalDir,
    ...(result.firstItemPath === undefined ? {} : { firstItemPath: result.firstItemPath }),
    statePath: result.statePath,
    skills: result.skills
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
