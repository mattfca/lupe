import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export interface ProjectSkill {
  name: string;
  description: string;
  body: string;
}

export interface WriteProjectSkillsOptions {
  cwd?: string;
}

export interface WriteProjectSkillsResult {
  written: string[];
  skipped: string[];
}

export const LUPE_PROJECT_SKILLS: readonly ProjectSkill[] = [
  {
    name: "lupe-planning",
    description:
      "Guides Cursor when planning Lupe work items, translating queued markdown requests into focused implementation phases.",
    body: `# Lupe Planning

Use this skill when a prompt asks you to plan a Lupe work item or break queued work into phases.

- Read the current work item and existing repository before proposing phases.
- Keep phases small, reviewable, and ordered by dependency.
- Include verification expectations for each phase.
- Do not implement code while planning unless the prompt explicitly asks for implementation.
`
  },
  {
    name: "lupe-running",
    description:
      "Guides Cursor when executing Lupe phases in isolated worktrees, including verification and bounded repair.",
    body: `# Lupe Running

Use this skill when a Lupe phase prompt asks you to implement work in an isolated worktree.

- Stay within the phase goal, scope, and acceptance hints.
- Keep changes local to the assigned worktree and branch.
- Run the requested verification when practical and record useful failures.
- Do not open pull requests, accept work, or modify Lupe state directly.
`
  },
  {
    name: "lupe-review",
    description:
      "Guides Cursor when reviewing Lupe final-review packages and deciding whether queued work is ready to accept.",
    body: `# Lupe Review

Use this skill when inspecting a Lupe final-review package or preparing an accept/reject decision.

- Start with behavioral risks, verification gaps, and unresolved items.
- Compare the final review against the source work item and phase summaries.
- Treat acceptance as a PR-opening step, not a direct merge to main.
- If changes are needed, recommend reject or a follow-up work item.
`
  }
];

export async function writeProjectSkills(
  options: WriteProjectSkillsOptions = {}
): Promise<WriteProjectSkillsResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const written: string[] = [];
  const skipped: string[] = [];

  for (const skill of LUPE_PROJECT_SKILLS) {
    const skillDir = join(cwd, ".cursor", "skills", skill.name);
    const skillPath = join(skillDir, "SKILL.md");
    await mkdir(skillDir, { recursive: true });

    try {
      await writeFile(skillPath, renderProjectSkill(skill), { encoding: "utf8", flag: "wx" });
      written.push(relative(cwd, skillPath));
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        skipped.push(relative(cwd, skillPath));
        continue;
      }
      throw error;
    }
  }

  return { written, skipped };
}

export function renderProjectSkill(skill: ProjectSkill): string {
  return `---
name: ${skill.name}
description: ${skill.description}
---

${skill.body}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
