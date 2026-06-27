# Phase 05 — Run Engine

## Goal

Implement `lupe run`: the core execution loop that takes a planned work item and
runs its phases. Each phase executes in its own git branch + worktree, with
bounded parallelism, driven by the Cursor agent loop. Every attempt is recorded
as an append-only run with full artifacts, and the engine is resumable after a
crash.

## Scope

In:

- `lupe run`: acquire lock -> plan-if-needed -> schedule and execute eligible
  phases -> record artifacts.
- Per-phase git branch (`lupe/<id>/phase-NNN`) and worktree
  (`.lupe/worktrees/<id>/phase-NNN`).
- Bounded parallelism via `maxParallelPhases`, respecting the phase DAG.
- Cursor agent loop invocation per phase, with subagents/skills toggles.
- Append-only run artifacts and resumability/crash-resume.

Out:

- Verify command execution and repair loop (Phase 06) — the engine exposes hooks
  but the verify/repair logic lands next.
- Integration branch merge + review (Phase 07).

## Key modules / files

```txt
src/cli/commands/run.ts      # command wiring
src/runner/engine.ts         # orchestration loop
src/runner/scheduler.ts      # DAG-aware eligibility + bounded parallelism
src/runner/phaseRun.ts       # execute a single phase in its worktree
src/runner/artifacts.ts      # write run-NNN/* files
src/runner/resume.ts         # detect + resume in-progress runs
src/git/index.ts             # branch/worktree create + cleanup
```

## Run artifact layout

```txt
.lupe/work-items/<id>/runs/run-NNN/
  prompt.md
  output.md
  verification.md      # populated in Phase 06
  diff-summary.md
  subagents.md
```

Runs are append-only: a new attempt creates `run-(N+1)`; existing runs are never
mutated.

## Tasks

1. Implement the git adapter: create per-phase branch + worktree, capture a diff
   summary, and clean up worktrees later.
2. Implement the scheduler: from the phase DAG, select `ready` phases (deps
   verified) and run up to `maxParallelPhases` concurrently.
3. Implement single-phase execution: render the phase prompt, run the Cursor
   agent loop in the phase worktree (honoring `subagents`/`skills`), and capture
   `output.md` + `diff-summary.md` + `subagents.md`.
4. Implement run artifact writing (`run-NNN/` append-only) and per-phase status
   updates in `state.json`.
5. Implement resumability: on start, read `state.json`, re-acquire the lock, and
   resume the in-progress run/phase rather than starting over.
6. Drive the work-item transition `planned -> running` and keep `current` in
   `state.json` accurate (work item, run, integration branch).
7. Expose post-phase hooks for verify/repair (implemented in Phase 06) without
   coupling the engine to their internals.
8. Handle agent/git failures gracefully: mark the phase, preserve artifacts, and
   surface actionable errors.

## Acceptance criteria

- `lupe run` runs a planned item's phases honoring DAG order and
  `maxParallelPhases`.
- Each phase gets its own branch `lupe/<id>/phase-NNN` and worktree under
  `.lupe/worktrees/...`.
- Run artifacts are written append-only under `runs/run-NNN/`.
- Killing and restarting `lupe run` resumes the in-progress run without
  re-running completed phases.
- State (`current`, per-phase status) stays consistent throughout.
- `typecheck`, `lint`, and `test` all pass.

## Verification

```bash
bun run typecheck
bun run lint
bun test
```

- Integration test (temp git repo + mock agent): branches/worktrees created,
  artifacts written, parallelism bounded, DAG order respected.
- Resume test: simulate a crash mid-run and assert resume continues correctly.

## Dependencies

- Phase 01 (CLI, config: `maxParallelPhases`, `subagents`, `skills`).
- Phase 03 (state, lock, transitions).
- Phase 04 (plan + phase DAG, agent adapter).
