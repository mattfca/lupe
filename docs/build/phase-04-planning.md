# Phase 04 — Planning

## Goal

Implement `lupe plan`: take a pending work item and break it into an ordered,
dependency-aware set of build phases, persisting `plan.json` and human-readable
`phases/phase-NNN.md` files under the work item's directory. Planning uses the
Cursor agent adapter so a large work item can become many phases and a small one
a single phase.

## Scope

In:

- `lupe plan` command: plan the first unplanned item by default; support
  `--all` and a specific id/path.
- Agent adapter interface for planning + a Cursor implementation.
- Phase graph: phases with `id`, `deps`, and status; validate it (no cycles,
  deps resolve).
- Persist `plan.json` and `phases/phase-NNN.md`; transition item to `planned`.

Out:

- Executing phases (Phase 05).
- Verification/repair (Phase 06).

## Key modules / files

```txt
src/cli/commands/plan.ts     # command wiring
src/planner/plan.ts          # orchestrates planning for a work item
src/planner/graph.ts         # phase DAG build + validation (cycles, deps)
src/planner/persist.ts       # write plan.json + phases/*.md
src/agent/index.ts           # AgentAdapter interface
src/agent/cursor.ts          # Cursor implementation (planning prompt)
```

## Artifact layout (per work item)

```txt
.lupe/work-items/<id>/
  plan.json
  phases/
    phase-001.md
    phase-002.md
    phase-003.md
```

`plan.json` records each phase's `id`, `deps`, `status` (initially `blocked` or
`ready`), and a path to its `phase-NNN.md` brief.

## Tasks

1. Define the `AgentAdapter` interface (a `plan(workItem, context)` method
   returning a structured phase list) and implement the Cursor adapter with a
   planning prompt derived from the work item markdown.
2. Implement plan orchestration: load the work item, invoke the agent, and
   normalize the response into typed phases.
3. Build and validate the phase DAG: detect cycles, ensure every `dep`
   references an existing phase, and compute initial `ready`/`blocked` status.
4. Persist `plan.json` and one `phase-NNN.md` brief per phase (goal, scope,
   dependencies, acceptance hints).
5. Wire the `plan` command: select target(s) (default first unplanned, `--all`,
   or explicit id/path), run under the lock, and transition each to `planned`.
6. Make planning idempotent/re-runnable: re-planning an item regenerates its
   plan deterministically and warns before overwriting.
7. Record a `decisions[]` entry noting the plan was generated.

## Acceptance criteria

- `lupe plan` plans the first unplanned item and writes `plan.json` +
  `phases/phase-NNN.md`.
- The phase graph is validated; cycles and dangling deps are rejected with clear
  errors.
- The item transitions to `planned` in `state.json` and `STATE.md` updates.
- A mock agent adapter makes planning deterministic in tests.
- `typecheck`, `lint`, and `test` all pass.

## Verification

```bash
bun run typecheck
bun run lint
bun test
```

- Unit tests: DAG validation (cycle/dangling-dep detection, ready/blocked
  computation), persistence layout, target selection (`--all` / id / path).
- Integration test: with a mock agent, `plan` produces the expected artifacts
  and state for a fixture work item.

## Dependencies

- Phase 01 (CLI, config, agent config).
- Phase 02 (work-item model).
- Phase 03 (state store, transitions, lock).
