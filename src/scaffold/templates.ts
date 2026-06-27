import { DEFAULT_CONFIG } from "../config/schema";

export const INITIAL_SCOPE_SLUG = "initial_scope";

export function formatUtcTimestamp(date: Date): string {
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hour = pad(date.getUTCHours());
  const minute = pad(date.getUTCMinutes());
  const second = pad(date.getUTCSeconds());

  return `${year}${month}${day}T${hour}${minute}${second}`;
}

export function slugifyTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");

  return slug === "" ? "work_item" : slug;
}

export function workItemFilename(date: Date, slug: string): string {
  return `${formatUtcTimestamp(date)}_${slug}.md`;
}

export function renderConfigTemplate(): string {
  return `import type { UserLupeConfig } from "@mattfca/lupe";

const config: UserLupeConfig = {
  input: {
    dir: "${DEFAULT_CONFIG.input.dir}",
    pattern: "${escapeString(DEFAULT_CONFIG.input.pattern)}",
    order: "${DEFAULT_CONFIG.input.order}",
    onDuplicatePrefix: "${DEFAULT_CONFIG.input.onDuplicatePrefix}",
    onUnmatchedFile: "${DEFAULT_CONFIG.input.onUnmatchedFile}",
    immutableCompleted: ${DEFAULT_CONFIG.input.immutableCompleted}
  },

  agent: "${DEFAULT_CONFIG.agent}",
  mode: "${DEFAULT_CONFIG.mode}",
  review: "${DEFAULT_CONFIG.review}",
  autoAccept: ${DEFAULT_CONFIG.autoAccept},
  onItemRejected: "${DEFAULT_CONFIG.onItemRejected}",

  verify: ${JSON.stringify(DEFAULT_CONFIG.verify)},

  maxParallelPhases: ${DEFAULT_CONFIG.maxParallelPhases},
  maxRepairAttempts: ${DEFAULT_CONFIG.maxRepairAttempts},

  subagents: ${DEFAULT_CONFIG.subagents},
  skills: ${DEFAULT_CONFIG.skills}
};

export default config;
`;
}

export function renderInitialWorkItemTemplate(): string {
  return `# Initial Scope

Describe what you want Lupe to build.

Include:
- Product goal
- Tech stack
- Main features
- Non-goals
- Acceptance criteria
- Risks or constraints
`;
}

export function renderNewWorkItemTemplate(title: string): string {
  return `# ${title}

## Goal
Describe the change or bug fix.

## Context
Add relevant background.

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Constraints
- Add constraints or non-goals.
`;
}

export function renderMigratedScopeWorkItem(scopeContents: string): string {
  return ensureTrailingNewline(scopeContents);
}

export function renderQuickStartSnippet(): string {
  return `lupe init
lupe new "add your next work item"
lupe plan
lupe run
lupe review
lupe accept
`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function escapeString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
