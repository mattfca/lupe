# Lupe Scope Update: Ordered Work Queue (v2)

## Summary of changes from v1

This revision keeps the migration-style ordered work queue but resolves the
ambiguities found in review:

- **Timestamp-ordered work items** instead of fragile `NNNN_` prefixes
  (natural insertion, no collisions, no renumbering).
- **Distinct input directory name** (`lupe-queue/`) so it can never be visually
  confused with the hidden internal directory (`.lupe/`).
- **Canonical machine-readable state** (`.lupe/state.json`) with a generated,
  human-readable `STATE.md` view.
- **Explicit accept/merge contract**: phases → per-item integration branch → PR.
- **Halt-on-reject** queue policy.
- Plus: single-runner lock, bounded repair, explicit `autoAccept`, aligned
  review terminology (`per-item` / `batch`), a real state-machine transition
  table, and `migrate` / `acknowledge` / `reject` / `skip` commands.

---

## Input Model Change

Lupe is no longer centered around a single `SCOPE.md` file.

Instead, Lupe uses a migration-style work queue directory containing
user-authored markdown files that describe work Lupe should perform. Each file
is a **work item** — a unit of user intent — and is processed in chronological
order.

Each file may contain a large product scope, a small feature request, a bug
ticket, a refactor, a cleanup task, a documentation task, a design change, or a
follow-up revision from a previous run. Lupe breaks each file into build phases,
runs those phases, verifies the work, records state, and moves to the next
pending file.

---

## Directory Convention

Lupe uses two clearly distinct directories:

```txt
lupe-queue/   = input  (user-authored work items)
.lupe/        = output / internal state (Lupe-generated)
```

The input directory is deliberately **not** named `lupe/`, because `lupe/` and
`.lupe/` differ only by a leading dot and are easy to confuse in tab-completion,
globs, and `.gitignore`.

### `lupe-queue/`

```txt
lupe-queue/
  20260625T0900_initial_scope.md
  20260625T1030_fix_login_redirect.md
  20260626T1415_add_billing_page.md
```

### `.lupe/`

```txt
.lupe/
  state.json          # canonical source of truth
  lock                # single-runner guard
  STATE.md            # generated human-readable view of state.json
  work-items/
  runs/
```

### Validation

Lupe hard-errors if:

- a work item appears under `.lupe/`, or
- a generated artifact appears under `lupe-queue/`.

---

## Work Item Files

A work item can be broad:

```md
# Initial Product Scope

Build a simple SaaS dashboard with auth, projects, billing, and an admin area.
```

Or narrow:

```md
# Fix Signup Redirect Bug

After signup, users are sent to /login.
They should be sent to /dashboard.

Acceptance criteria:
- New users land on /dashboard
- Existing login behavior is unchanged
- Test coverage is added
```

Lupe treats both as work items. The planner decides how many build phases are
needed: a large file may become many phases; a small bug ticket may become one.

---

## File Naming (timestamp-ordered)

Work item files use a timestamp prefix:

```txt
YYYYMMDDThhmmss_description.md
```

Examples:

```txt
20260625T0900_initial_scope.md
20260625T1030_authentication.md
20260626T1415_fix_login_redirect.md
```

Rules:

- Prefix is a 14-digit UTC timestamp followed by `T`-free compact form
  `YYYYMMDDThhmmss` (lexicographic order == chronological order).
- Files are processed in ascending lexicographic order of the prefix.
- Description should be kebab-case or snake_case.
- Markdown is the default and only supported format in v1.
- Files that do **not** match the pattern produce a **warning** (not a silent
  skip), so users never lose work to a typo'd filename.
- Insertion between two items is natural: pick any timestamp between them.
- Duplicate prefixes are practically impossible; if one occurs, Lupe errors.

Supported v1 pattern:

```txt
^[0-9]{8}T[0-9]{6}_.+\.md$
```

---

## Processing Order

Lupe processes pending work items in ascending chronological order. Work item
ordering is strict and sequential by default.

Phases **inside** a work item may run in parallel if safe (bounded by
`maxParallelPhases`), but work items themselves are processed one at a time.

This gives Lupe a clear, durable project timeline.

---

## Work Item Lifecycle (state machine)

States:

```txt
discovered  planned  running  verified  in_review  accepted  rejected  skipped
```

Legal transitions and triggers:

| From       | To         | Trigger                                              |
|------------|------------|------------------------------------------------------|
| (new file) | discovered | found in `lupe-queue/` matching the pattern               |
| discovered | planned    | `lupe plan` produces a phase graph                   |
| planned    | running    | `lupe run` starts the first eligible phase           |
| running    | running    | crash/resume re-enters the in-progress run           |
| running    | verified   | all phases pass `verify`                             |
| running    | running    | failed verify → repair (≤ `maxRepairAttempts`)       |
| running    | rejected   | repair budget exhausted, or user rejects             |
| verified   | in_review  | final-review package generated (`review: per-item`)  |
| in_review  | accepted   | user `lupe accept` (or `autoAccept: true`)           |
| in_review  | rejected   | user `lupe reject`                                   |
| any         | skipped    | user `lupe skip`                                     |

Queue effects:

- `accepted` → advance to next pending item.
- `rejected` → **halt the queue** until the user resolves it (see Reject Policy).
- `skipped` → advance to next pending item.

`in_review` is only used in `per-item` review mode; `batch` mode aggregates
multiple `verified` items into a single review (see Review Model).

High-level flow:

```txt
1. Discover ordered files in lupe-queue/
2. Find the first pending work item
3. Plan phases for that work item (if not planned)
4. Run eligible phases (bounded parallelism)
5. Verify each phase
6. Repair failures if possible (bounded attempts)
7. Integrate phases into the work item's integration branch
8. Generate the final-review package
9. Record state in .lupe/state.json (and regenerate STATE.md)
10. On accept, advance to the next work item
```

---

## Resumability

`lupe run` is resumable. Runs are append-only under
`.lupe/work-items/<id>/runs/run-NNN/`. On restart, Lupe reads `state.json`,
re-acquires the lock, and resumes the in-progress run/phase rather than starting
over.

---

## Phase Planning Per Work Item

Each work item gets its own generated plan, keyed by the work item's full id
(timestamp + description):

```txt
.lupe/work-items/20260626T1415_admin_dashboard/
  plan.json
  phases/
    phase-001.md
    phase-002.md
    phase-003.md
  runs/
  final-review/
```

Every generated phase traces back to its source work item.

---

## Internal Artifact Layout

```txt
.lupe/
  state.json
  lock
  STATE.md
  work-items/
    20260625T0900_initial_scope/
      plan.json
      phases/
        phase-001.md
        phase-002.md
      runs/
        run-001/
          prompt.md
          output.md
          verification.md
          diff-summary.md
          subagents.md
      final-review/
        summary.md
        phase-summary.md
        diff-summary.md
        verification.md
        risks.md
        unresolved-items.md
    20260625T1030_authentication/
      ...
```

---

## State Tracking

`.lupe/state.json` is the **canonical source of truth**. `STATE.md` is a
generated, human-readable rendering and must never be hand-edited as truth.

Canonical `state.json` (sketch):

```json
{
  "project": {
    "input": "lupe-queue",
    "internal": ".lupe",
    "agent": "cursor",
    "mode": "auto",
    "review": "per-item",
    "autoAccept": false,
    "subagents": true,
    "skills": true
  },
  "current": {
    "status": "active",
    "workItem": "20260626T1415_admin_dashboard",
    "run": "run-2026-06-26-001",
    "integrationBranch": "lupe/20260626T1415_admin_dashboard"
  },
  "workItems": [
    {
      "id": "20260625T0900_initial_scope",
      "status": "accepted",
      "planned": true,
      "verified": true,
      "fileHash": "sha256:abc123",
      "finalReview": ".lupe/work-items/20260625T0900_initial_scope/final-review/summary.md",
      "completedAt": "2026-06-25"
    },
    {
      "id": "20260626T1415_admin_dashboard",
      "status": "running",
      "planned": true,
      "verified": false,
      "fileHash": "sha256:def456",
      "currentPhase": "phase-002",
      "repairAttempts": 0,
      "phases": [
        {"id": "phase-001", "status": "verified", "deps": [], "branch": "lupe/20260626T1415_admin_dashboard/phase-001"},
        {"id": "phase-002", "status": "running",  "deps": ["phase-001"], "branch": "lupe/20260626T1415_admin_dashboard/phase-002"},
        {"id": "phase-003", "status": "blocked",  "deps": ["phase-002"]}
      ]
    }
  ],
  "decisions": [
    {"date": "2026-06-26", "note": "Use lupe-queue/ as the user-authored ordered work queue."},
    {"date": "2026-06-26", "note": "state.json is canonical; STATE.md is generated."},
    {"date": "2026-06-26", "note": "Process work items in chronological (timestamp) order."},
    {"date": "2026-06-26", "note": "Halt the queue on a rejected work item."}
  ]
}
```

`STATE.md` (generated view, abbreviated):

```md
# Lupe State

## Current
- Status: active
- Work item: 20260626T1415_admin_dashboard
- Run: run-2026-06-26-001
- Integration branch: lupe/20260626T1415_admin_dashboard

## Work Items
- [accepted] 20260625T0900_initial_scope (completed 2026-06-25)
- [running]  20260626T1415_admin_dashboard (phase-002)
```

### Concurrency

`.lupe/lock` guards against concurrent `lupe run` / `lupe plan` invocations. If
the lock is held, Lupe refuses to start and reports the holding PID/run.

---

## Immutability Rule

Lupe treats **accepted** work item files like applied migrations. Once accepted,
the user should not edit the file to create new work — they add a new file
instead. Rejected and skipped items remain freely editable.

Lupe stores a content hash per accepted item (`fileHash` in `state.json`). If an
accepted file later changes:

```txt
Warning:
  lupe-queue/20260625T1030_authentication.md was already accepted but has changed.

Recommended:
  Create a new work item:
    lupe new "authentication followup"

If the edit was non-substantive (typo/formatting):
    lupe acknowledge 20260625T1030_authentication
  (re-hashes the file without re-running it)
```

---

## Config

```ts
import { defineConfig } from "lupe"

export default defineConfig({
  input: "lupe-queue",

  agent: "cursor",
  mode: "auto",

  review: "per-item",        // "per-item" | "batch"
  autoAccept: false,         // gate moving to next item on user acceptance
  onItemRejected: "halt",    // queue policy

  verify: ["bun run typecheck", "bun test", "bun run lint"],

  maxParallelPhases: 2,      // concurrency *within* a work item
  maxRepairAttempts: 2,      // bound the repair/verify loop

  subagents: true,
  skills: true,
})
```

Advanced input config:

```ts
export default defineConfig({
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
})
```

---

## Accept / Merge Contract

This is the highest-stakes operation, so it is explicit:

1. Each phase runs in its own branch/worktree:
   - branch: `lupe/<work-item-id>/phase-NNN`
   - worktree: `.lupe/worktrees/<work-item-id>/phase-NNN`
2. Verified phases are merged into the work item's **integration branch**:
   - `lupe/<work-item-id>`
3. After all phases integrate and the work item verifies, Lupe generates the
   final-review package.
4. `lupe accept`:
   - opens a **pull request** from the integration branch into `main`
     (Lupe does not push directly to `main`),
   - records `accepted` + completion timestamp + file hash in `state.json`,
   - advances the queue to the next pending work item.

Worktrees are cleaned up after the work item is accepted or rejected.

---

## Reject Policy

When a work item is rejected (`lupe reject` or repair budget exhausted) and
`onItemRejected: "halt"`:

- The queue **halts**; Lupe does not advance to later items.
- The rejected file becomes editable again.
- The user resolves it by editing + re-running, skipping (`lupe skip`), or
  adding a follow-up item.

This is the safe default because items are sequential and later items may depend
on the rejected one.

---

## Review Model

Two levels, with aligned naming:

### `per-item` (default)

Each work item gets its own review package at
`.lupe/work-items/<id>/final-review/`. The user reviews and accepts before Lupe
moves to the next item.

### `batch` (advanced)

Lupe runs multiple pending items and produces one combined final review.
Faster, but riskier (many intent files stack changes before review). Not the
default.

### Recommended v1 behavior

```txt
Phases inside a work item run autonomously.
Work items are reviewed one at a time (per-item).
```

---

## Init Flow

```bash
lupe init
```

Creates:

```txt
lupe-queue/
  20260626T1200_initial_scope.md
.lupe/
  state.json
  STATE.md          # generated human-readable view (under .lupe/ only)
lupe.config.ts
.cursor/skills/lupe-*
```

Generated first work item:

```md
# Initial Scope

Describe what you want Lupe to build.

Include:
- Product goal
- Tech stack
- Main features
- Non-goals
- Acceptance criteria
- Risks or constraints
```

---

## Migration From SCOPE.md

For existing users:

```bash
lupe migrate
```

Converts an existing `SCOPE.md` into the first work item:

```txt
lupe-queue/20260626T1200_initial_scope.md
```

and scaffolds `.lupe/` + config.

---

## Commands

```bash
lupe init                 # scaffold lupe-queue/, .lupe/, config, first work item
lupe migrate              # SCOPE.md -> lupe-queue/<ts>_initial_scope.md

lupe new "fix signup redirect bug"
                          # creates lupe-queue/<now>_fix_signup_redirect_bug.md

lupe plan [target]        # plan first unplanned item; or --all / specific id/path
lupe run                  # lock -> plan-if-needed -> run phases -> verify
                          #   -> repair (bounded) -> integrate -> final review
lupe review               # show the current item's review package
lupe accept               # open PR per accept contract; advance queue
lupe reject [reason]      # mark rejected; apply onItemRejected policy
lupe skip                 # mark skipped; advance
lupe acknowledge <id>     # re-hash an accepted file after a non-substantive edit
```

`lupe new` template:

```md
# <Title>

## Goal
Describe the change or bug fix.

## Context
Add relevant background.

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Constraints
- Add constraints or non-goals.
```

---

## User Flow

```txt
User writes ordered files in lupe-queue/
        ↓
lupe init  (or lupe migrate)
        ↓
lupe plan        → plans first pending item
        ↓
lupe run         → runs phases autonomously, verifies, integrates
        ↓
Final review package for that item
        ↓
lupe accept      → opens PR into main, advances queue
        ↓
Repeat for the next item
```

---

## Product Positioning

Lupe is not a one-shot scope runner. Lupe is an **ordered implementation queue
for agentic development**.

> Add markdown work items to `lupe-queue/`. Lupe processes them in order, breaks each
> into phases, runs Cursor loops, verifies the result, records state, and gives
> you a review package (and a PR) before moving on.

---

## Core File-System Contract

> User intent lives in `lupe-queue/`. Canonical state lives in `.lupe/state.json`
> (rendered as `.lupe/STATE.md`). All Lupe artifacts live in `.lupe/`.
