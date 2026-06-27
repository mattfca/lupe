import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ConfigError } from "../util/errors";
import { DEFAULT_CONFIG, resolveConfig, type LupeConfig } from "./schema";

export const CONFIG_FILENAME = "lupe.config.ts";

export interface LoadedConfig {
  cwd: string;
  path: string | null;
  config: LupeConfig;
}

export interface LoadConfigOptions {
  cwd?: string;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = resolve(cwd, CONFIG_FILENAME);

  if (!existsSync(configPath)) {
    return {
      cwd,
      path: null,
      config: cloneConfig(DEFAULT_CONFIG)
    };
  }

  const exportedConfig = await importConfig(configPath);

  return {
    cwd,
    path: configPath,
    config: resolveConfig(exportedConfig)
  };
}

async function importConfig(configPath: string): Promise<unknown> {
  const source = await readFile(configPath, "utf8");
  const tempConfigPath = join(dirname(configPath), `.lupe.config.${randomUUID()}.tmp.ts`);
  await writeFile(tempConfigPath, `${source}\n/* lupe-cache-bust:${randomUUID()} */\n`, "utf8");

  try {
    const module = (await import(pathToFileURL(tempConfigPath).href)) as {
      default?: unknown;
      config?: unknown;
    };
    if (module.default !== undefined) {
      return module.default;
    }
    if (module.config !== undefined) {
      return module.config;
    }
    throw new ConfigError(`${CONFIG_FILENAME} must export a default config object.`);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(`Failed to load ${CONFIG_FILENAME}: ${messageFor(error)}`, error);
  } finally {
    await rm(tempConfigPath, { force: true });
  }
}

function cloneConfig(config: LupeConfig): LupeConfig {
  return {
    ...config,
    input: { ...config.input },
    verify: [...config.verify]
  };
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
