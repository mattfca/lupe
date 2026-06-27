import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { LoadedConfig } from "../config/load";
import type { LupeConfig } from "../config/schema";
import { INTERNAL_DIR } from "../fs/contract";
import type { Logger } from "../util/logger";
import { parseWorkItemFilename } from "./filename";
import {
  handleUnmatchedFile,
  validateDuplicatePrefixes,
  validateQueueDirectoryContract,
  type ParsedQueueFile,
  type QueueWarning
} from "./validate";
import { createWorkItem, type WorkItem } from "./workItem";

export interface LoadQueueOptions {
  cwd?: string;
  logger?: Logger;
}

export interface LoadedQueue {
  items: WorkItem[];
  warnings: QueueWarning[];
}

export type LoadQueueConfig = LoadedConfig | LupeConfig;

interface ResolvedQueueConfig {
  cwd: string;
  config: LupeConfig;
}

interface DiscoveredPath {
  path: string;
  relativePath: string;
  isFile: boolean;
}

export async function loadQueue(
  queueConfig: LoadQueueConfig,
  options: LoadQueueOptions = {}
): Promise<LoadedQueue> {
  const { cwd, config } = resolveQueueConfig(queueConfig, options);
  const inputDir = resolve(cwd, config.input.dir);
  const contractPaths = await collectContractPaths(cwd, inputDir);
  validateQueueDirectoryContract(
    contractPaths.map((path) => path.relativePath),
    { input: config.input }
  );

  const inputEntries = await readDirectory(inputDir);
  const warnings: QueueWarning[] = [];
  const parsedFiles: ParsedQueueFile[] = [];

  for (const entry of inputEntries) {
    if (!entry.isFile()) {
      continue;
    }

    const path = join(inputDir, entry.name);
    const parsedFilename = parseWorkItemFilename(entry.name, config.input.pattern);

    if (parsedFilename === null) {
      const warning = handleUnmatchedFile(path, { input: config.input });
      if (warning !== null) {
        warnings.push(warning);
        options.logger?.warn(warning.message);
      }
      continue;
    }

    parsedFiles.push({
      path,
      relativePath: relative(cwd, path),
      parsedFilename
    });
  }

  validateDuplicatePrefixes(parsedFiles, { input: config.input });
  parsedFiles.sort((left, right) => left.parsedFilename.id.localeCompare(right.parsedFilename.id));

  const items = await Promise.all(
    parsedFiles.map(async (file) =>
      createWorkItem({
        parsedFilename: file.parsedFilename,
        path: file.path,
        contents: await readFile(file.path, "utf8")
      })
    )
  );

  return {
    items,
    warnings
  };
}

function resolveQueueConfig(
  queueConfig: LoadQueueConfig,
  options: LoadQueueOptions
): ResolvedQueueConfig {
  if ("config" in queueConfig && "cwd" in queueConfig) {
    return {
      cwd: resolve(options.cwd ?? queueConfig.cwd),
      config: queueConfig.config
    };
  }

  return {
    cwd: resolve(options.cwd ?? process.cwd()),
    config: queueConfig
  };
}

async function collectContractPaths(cwd: string, inputDir: string): Promise<DiscoveredPath[]> {
  const internalDir = resolve(cwd, INTERNAL_DIR);
  return [
    ...(await walkExistingDirectory(inputDir, cwd)),
    ...(await walkExistingDirectory(internalDir, cwd, {
      excludedDirs: new Set([join(internalDir, "worktrees")])
    }))
  ];
}

async function walkExistingDirectory(
  dir: string,
  cwd: string,
  options: { excludedDirs?: ReadonlySet<string> } = {}
): Promise<DiscoveredPath[]> {
  if (options.excludedDirs?.has(dir)) {
    return [];
  }

  const entries = await readDirectory(dir);
  const paths: DiscoveredPath[] = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);
    paths.push({
      path,
      relativePath: relative(cwd, path),
      isFile: entry.isFile()
    });

    if (entry.isDirectory()) {
      paths.push(...(await walkExistingDirectory(path, cwd, options)));
    }
  }

  return paths;
}

async function readDirectory(dir: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
