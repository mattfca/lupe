import { DEFAULT_WORK_ITEM_PATTERN, INPUT_DIR } from "../fs/contract";
import { ConfigError } from "../util/errors";

export type Agent = "cursor";
export type Mode = "auto";
export type ReviewMode = "per-item" | "batch";
export type OnItemRejected = "halt";
export type InputOrder = "chronological";
export type OnDuplicatePrefix = "error";
export type OnUnmatchedFile = "warn" | "error";

export interface InputConfig {
  dir: string;
  pattern: string;
  order: InputOrder;
  onDuplicatePrefix: OnDuplicatePrefix;
  onUnmatchedFile: OnUnmatchedFile;
  immutableCompleted: boolean;
}

export type InputConfigInput = string | Partial<InputConfig>;

export interface LupeConfig {
  input: InputConfig;
  agent: Agent;
  mode: Mode;
  review: ReviewMode;
  autoAccept: boolean;
  onItemRejected: OnItemRejected;
  verify: string[];
  maxParallelPhases: number;
  maxRepairAttempts: number;
  subagents: boolean;
  skills: boolean;
}

export interface UserLupeConfig {
  input?: InputConfigInput;
  agent?: Agent;
  mode?: Mode;
  review?: ReviewMode;
  autoAccept?: boolean;
  onItemRejected?: OnItemRejected;
  verify?: string[];
  maxParallelPhases?: number;
  maxRepairAttempts?: number;
  subagents?: boolean;
  skills?: boolean;
}

export const DEFAULT_INPUT_CONFIG: InputConfig = {
  dir: INPUT_DIR,
  pattern: DEFAULT_WORK_ITEM_PATTERN,
  order: "chronological",
  onDuplicatePrefix: "error",
  onUnmatchedFile: "warn",
  immutableCompleted: true
};

export const DEFAULT_CONFIG: LupeConfig = {
  input: DEFAULT_INPUT_CONFIG,
  agent: "cursor",
  mode: "auto",
  review: "per-item",
  autoAccept: false,
  onItemRejected: "halt",
  verify: ["bun run typecheck", "bun test", "bun run lint"],
  maxParallelPhases: 2,
  maxRepairAttempts: 2,
  subagents: true,
  skills: true
};

const topLevelKeys = new Set([
  "input",
  "agent",
  "mode",
  "review",
  "autoAccept",
  "onItemRejected",
  "verify",
  "maxParallelPhases",
  "maxRepairAttempts",
  "subagents",
  "skills"
]);

const inputKeys = new Set([
  "dir",
  "pattern",
  "order",
  "onDuplicatePrefix",
  "onUnmatchedFile",
  "immutableCompleted"
]);

export function resolveConfig(input: unknown = {}): LupeConfig {
  if (!isRecord(input)) {
    throw new ConfigError("Config must export an object created with defineConfig(...).");
  }

  rejectUnknownKeys(input, topLevelKeys, "config");

  const userConfig = input as UserLupeConfig;
  const config: LupeConfig = {
    input: resolveInputConfig(userConfig.input),
    agent: userConfig.agent ?? DEFAULT_CONFIG.agent,
    mode: userConfig.mode ?? DEFAULT_CONFIG.mode,
    review: userConfig.review ?? DEFAULT_CONFIG.review,
    autoAccept: userConfig.autoAccept ?? DEFAULT_CONFIG.autoAccept,
    onItemRejected: userConfig.onItemRejected ?? DEFAULT_CONFIG.onItemRejected,
    verify: userConfig.verify ?? [...DEFAULT_CONFIG.verify],
    maxParallelPhases: userConfig.maxParallelPhases ?? DEFAULT_CONFIG.maxParallelPhases,
    maxRepairAttempts: userConfig.maxRepairAttempts ?? DEFAULT_CONFIG.maxRepairAttempts,
    subagents: userConfig.subagents ?? DEFAULT_CONFIG.subagents,
    skills: userConfig.skills ?? DEFAULT_CONFIG.skills
  };

  validateConfig(config);
  return config;
}

export function resolveInputConfig(input: unknown = DEFAULT_INPUT_CONFIG): InputConfig {
  if (input === undefined) {
    return { ...DEFAULT_INPUT_CONFIG };
  }

  if (typeof input === "string") {
    return { ...DEFAULT_INPUT_CONFIG, dir: input };
  }

  if (!isRecord(input)) {
    throw new ConfigError("Config field input must be a directory string or an object.");
  }

  rejectUnknownKeys(input, inputKeys, "input");

  return {
    ...DEFAULT_INPUT_CONFIG,
    ...input
  } as InputConfig;
}

export function validateConfig(config: LupeConfig): void {
  validateInputConfig(config.input);
  expectOneOf(config.agent, ["cursor"], "agent");
  expectOneOf(config.mode, ["auto"], "mode");
  expectOneOf(config.review, ["per-item", "batch"], "review");
  expectBoolean(config.autoAccept, "autoAccept");
  expectOneOf(config.onItemRejected, ["halt"], "onItemRejected");
  expectCommandList(config.verify, "verify");
  expectPositiveInteger(config.maxParallelPhases, "maxParallelPhases");
  expectPositiveInteger(config.maxRepairAttempts, "maxRepairAttempts");
  expectBoolean(config.subagents, "subagents");
  expectBoolean(config.skills, "skills");
}

export function validateInputConfig(input: InputConfig): void {
  expectNonEmptyRelativePath(input.dir, "input.dir");
  expectValidPattern(input.pattern, "input.pattern");
  expectOneOf(input.order, ["chronological"], "input.order");
  expectOneOf(input.onDuplicatePrefix, ["error"], "input.onDuplicatePrefix");
  expectOneOf(input.onUnmatchedFile, ["warn", "error"], "input.onUnmatchedFile");
  expectBoolean(input.immutableCompleted, "input.immutableCompleted");
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: Set<string>,
  label: string
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new ConfigError(`Unknown ${label} field "${key}".`);
    }
  }
}

function expectOneOf<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  field: string
): asserts value is T {
  if (typeof value !== "string" || !allowedValues.includes(value as T)) {
    throw new ConfigError(
      `Config field ${field} must be one of: ${allowedValues.map((item) => `"${item}"`).join(", ")}.`
    );
  }
}

function expectBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new ConfigError(`Config field ${field} must be a boolean.`);
  }
}

function expectCommandList(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new ConfigError(`Config field ${field} must be an array of non-empty command strings.`);
  }
}

function expectPositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    throw new ConfigError(`Config field ${field} must be a positive integer.`);
  }
}

function expectNonEmptyRelativePath(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`Config field ${field} must be a non-empty relative path.`);
  }

  if (value.startsWith("/") || value === "." || value.includes("..")) {
    throw new ConfigError(`Config field ${field} must be a relative path inside the project.`);
  }
}

function expectValidPattern(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`Config field ${field} must be a non-empty regular expression string.`);
  }

  try {
    new RegExp(value);
  } catch (error) {
    throw new ConfigError(`Config field ${field} must be a valid regular expression.`, error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
