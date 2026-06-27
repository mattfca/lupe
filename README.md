# Lupe

Lupe is an ordered implementation queue for agentic development. Add markdown work items to `lupe-queue/`; Lupe plans them, runs phases in isolated git worktrees, verifies the result, writes a final review package, and opens a PR when you accept the work.

## Install

Lupe requires [Bun](https://bun.sh) on your PATH.

Install globally:

```bash
bun install -g @mattfca/lupe
lupe --help
```

Or add it to a project:

```bash
bun add -d @mattfca/lupe
bunx lupe --help
```

## Quick Start

```bash
lupe init
lupe new "add billing settings"
lupe plan
lupe run
lupe review
lupe accept
```

The flow is `init -> new -> plan -> run -> review -> accept`.

`lupe init` creates:

```txt
lupe-queue/
  <timestamp>_initial_scope.md
.lupe/
  state.json
  STATE.md
lupe.config.ts
.cursor/skills/lupe-*/
  SKILL.md
```

For existing projects with a `SCOPE.md`, run:

```bash
lupe migrate
```

This copies `SCOPE.md` into `lupe-queue/<timestamp>_initial_scope.md` and scaffolds the same Lupe state, config, and project skills.

## Commands

- `lupe init`: Scaffold `lupe-queue/`, `.lupe/`, `lupe.config.ts`, the first work item, and Lupe project skills.
- `lupe migrate`: Convert an existing `SCOPE.md` into the first queued work item.
- `lupe new "<title>"`: Create a UTC timestamped work item template.
- `lupe plan [--all] [target]`: Plan phases for the first unplanned item, all unplanned items, or a specific item.
- `lupe run`: Run one planned item, verify its phases, repair within budget, and generate a review package.
- `lupe run --all`: Drain runnable queue items in order, leaving each completed item in review unless auto-accept is enabled.
- `lupe run --all --auto-accept`: Drain the queue and open one PR per completed item, even when `autoAccept` is false.
- `lupe review`: Print the current final-review package summary.
- `lupe accept`: Open a PR for the integration branch and advance the queue.
- `lupe reject [reason]`: Reject the current item and halt the queue.
- `lupe skip`: Skip the current item and advance.
- `lupe acknowledge <id>`: Re-hash an accepted item after a non-functional edit.

## Config Reference

`lupe.config.ts` exports a config object:

```ts
import type { UserLupeConfig } from "@mattfca/lupe";

const config: UserLupeConfig = {
  input: {
    dir: "lupe-queue",
    pattern: "^[0-9]{8}T[0-9]{6}_.+\\.md$",
    order: "chronological",
    onDuplicatePrefix: "error",
    onUnmatchedFile: "warn",
    immutableCompleted: true
  },
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

export default config;
```

`subagents` and `skills` are passed into phase and repair prompts so the agent can honor project policy while running work.

## Filesystem Contract

User intent lives in `lupe-queue/`. Canonical state lives in `.lupe/state.json`, and `.lupe/STATE.md` is generated from it for humans.

All Lupe-generated artifacts live under `.lupe/`, including work item plans, phase briefs, run artifacts, worktrees, and final-review packages. Lupe warns or errors when user-authored work items are placed under `.lupe/` or generated artifacts are placed under `lupe-queue/`.
