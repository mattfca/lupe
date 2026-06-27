# Phase 03 — State Tracking & Locking

## Goal

Make `.lupe/state.json` the canonical source of truth. Implement a typed,
atomic state store; a generated, human-readable `STATE.md` view; a single-runner
lock (`.lupe/lock`); and the work-item state machine with an enforced transition
table. After this phase, Lupe can durably record where every work item and phase
stands, and refuse concurrent runs.

## Scope

In:

- `state.json` schema (project, current, workItems, decisions) + atomic
  read/write.
- `STATE.md` generation from `state.json` (never hand-edited as truth).
- `.lupe/lock` acquire/release with PID/run metadata and stale-lock handling.
- State machine: states, legal transitions, triggers, and queue effects.

Out:

- The commands that *cause* most transitions (plan/run/accept) — they are wired
  in their own phases; here we implement and unit-test the transition function.

## Key modules / files

```txt
src/state/schema.ts        # State, WorkItemState, PhaseState types
src/state/store.ts         # load/save (atomic write + temp+rename)
src/state/render.ts        # STATE.md generator
src/state/machine.ts       # transition table + transition()
src/state/lock.ts          # acquire/release/inspect .lupe/lock
```

## State machine

States: `discovered`, `planned`, `running`, `verified`, `in_review`,
`accepted`, `rejected`, `skipped`.

| From | To | Trigger |
|------|----|---------|
| (new file) | discovered | found in `lupe-queue/` matching the pattern |
| discovered | planned | `lupe plan` produces a phase graph |
| planned | running | `lupe run` starts the first eligible phase |
| running | running | crash/resume re-enters the in-progress run |
| running | verified | all phases pass `verify` |
| running | running | failed verify -> repair (<= `maxRepairAttempts`) |
| running | rejected | repair budget exhausted, or user rejects |
| verified | in_review | final-review package generated (`review: per-item`) |
| in_review | accepted | `lupe accept` (or `autoAccept: true`) |
| in_review | rejected | `lupe reject` |
| any | skipped | `lupe skip` |

Queue effects: `accepted` -> advance; `rejected` -> halt; `skipped` -> advance.

## Tasks

1. Define the state schema types mirroring the scope's `state.json` sketch
   (`project`, `current`, `workItems[]` with `phases[]`, `decisions[]`).
2. Implement the store: load (with defaults when missing), and atomic save via
   temp-file + rename; validate on load.
3. Implement `transition(state, itemId, event)` enforcing the table above;
   illegal transitions throw a typed error.
4. Apply queue effects after transitions (advance vs halt vs advance).
5. Implement `STATE.md` rendering (Current section + Work Items list) and
   regenerate it after every state write.
6. Implement the lock: write `.lupe/lock` with PID + run id + timestamp; refuse
   to start if held and report the holder; detect/clear stale locks safely.
7. Provide a `withLock(fn)` helper so commands run inside the guard.
8. Provide a `syncDiscovered(queue, state)` helper that records newly discovered
   work items as `discovered`.

## Acceptance criteria

- `state.json` round-trips losslessly and writes are atomic (no partial files on
  crash).
- Legal transitions succeed; illegal transitions throw with a clear message.
- Queue effects match the table (accept/skip advance, reject halts).
- `STATE.md` is regenerated to match `state.json` after each write.
- The lock prevents a second `run`/`plan` and reports the holding PID/run; stale
  locks are handled.
- `typecheck`, `lint`, and `test` all pass.

## Verification

```bash
bun run typecheck
bun run lint
bun test
```

- Unit tests: transition matrix (legal + illegal), queue effects, atomic save
  (simulated crash), `STATE.md` rendering snapshot, lock acquire/conflict/stale.

## Dependencies

- Phase 01 (paths, errors, logger).
- Phase 02 (work-item model feeds `syncDiscovered`).
