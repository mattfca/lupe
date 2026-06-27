# Phase 01 — Foundations

## Goal

Stand up the Lupe project skeleton: a Bun + TypeScript package with a working
CLI entrypoint and command router, a typed config loader (`defineConfig` /
`lupe.config.ts`), enforcement of the core directory contract (`lupe-queue/`
input vs `.lupe/` internal), and a shared logging + error-handling layer. After
this phase, `lupe --help` runs and every later command has a place to live.

## Scope

In:

- Bun project setup, TypeScript (strict), lint/format, test runner.
- CLI entrypoint with a command router and `--help`/`--version`.
- Config schema, `defineConfig`, and loading `lupe.config.ts` with defaults.
- Directory contract constants + validation helpers.
- Logging and a typed error hierarchy.

Out:

- Any real command behavior (queue, plan, run, etc.) — those are stubs that
  print "not implemented" and are filled in by later phases.

## Key modules / files

```txt
package.json
tsconfig.json
bin/lupe                      # shim -> dist/cli entry
src/cli/index.ts              # entrypoint, arg parsing, router
src/cli/commands/*.ts         # one stub per command (init, plan, run, ...)
src/config/defineConfig.ts    # type + identity helper
src/config/load.ts            # locate + load + validate lupe.config.ts
src/config/schema.ts          # config schema + defaults
src/fs/contract.ts            # INPUT_DIR=lupe-queue, INTERNAL_DIR=.lupe + checks
src/util/logger.ts            # leveled logger
src/util/errors.ts            # LupeError hierarchy + exit codes
```

## Tasks

1. Initialize the Bun project: `package.json` (bin `lupe`), `tsconfig.json`
   (strict), and scripts for `typecheck`, `test`, `lint`, `build`.
2. Add the CLI entrypoint with a minimal command router that dispatches the
   verbs from the scope: `init`, `migrate`, `new`, `plan`, `run`, `review`,
   `accept`, `reject`, `skip`, `acknowledge`. Each command is a stub.
3. Implement `--help` (per-command usage) and `--version`.
4. Implement `defineConfig` and the config schema with defaults that match the
   scope (`input: "lupe-queue"`, `agent: "cursor"`, `mode: "auto"`,
   `review: "per-item"`, `autoAccept: false`, `onItemRejected: "halt"`,
   `verify: [...]`, `maxParallelPhases: 2`, `maxRepairAttempts: 2`,
   `subagents: true`, `skills: true`). Support both the simple and advanced
   `input` forms (string or object with `dir`/`pattern`/`order`/`onDuplicatePrefix`/`onUnmatchedFile`/`immutableCompleted`).
5. Implement config loading: locate `lupe.config.ts`, load it, merge with
   defaults, and validate; produce clear errors for invalid values.
6. Implement the directory contract module: constants for `lupe-queue/` and
   `.lupe/`, plus validators that hard-error if a work item appears under
   `.lupe/` or a generated artifact appears under `lupe-queue/`.
7. Implement the logger (levels, quiet/verbose flags) and the `LupeError`
   hierarchy mapped to process exit codes.
8. Wire global flags (`--cwd`, `--verbose`, `--quiet`) through the router.

## Acceptance criteria

- `lupe --help` and `lupe --version` work; unknown commands produce a helpful
  error and non-zero exit.
- Every scope command is registered and routes to a stub.
- A valid `lupe.config.ts` loads and merges with defaults; an invalid one fails
  with a precise, actionable message.
- Directory-contract validators correctly accept valid layouts and reject
  misplaced files (work item under `.lupe/`, artifact under `lupe-queue/`).
- `typecheck`, `lint`, and `test` all pass.

## Verification

```bash
bun run typecheck
bun run lint
bun test
bun run build && ./bin/lupe --help && ./bin/lupe --version
```

- Unit tests: config defaults/merge/validation, contract validators, router
  dispatch and unknown-command handling.

## Dependencies

None — this is the first phase.
