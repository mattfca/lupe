# Phase 09 — Init, Migrate & Polish

## Goal

Deliver the onboarding and finishing work that makes Lupe usable end to end:
`lupe init`, `lupe migrate`, and `lupe new` scaffolding; the `.cursor/skills/lupe-*`
skills and subagents wiring; and packaging/release plus end-user documentation.
After this phase, a new user can go from zero to a running queue.

## Scope

In:

- `lupe init`: scaffold `lupe-queue/`, `.lupe/`, `lupe.config.ts`, the first
  work item, and `.cursor/skills/lupe-*`.
- `lupe migrate`: convert an existing `SCOPE.md` into the first work item.
- `lupe new "<title>"`: create a timestamped work item from a template.
- Skills + subagents wiring used by planning/run.
- Packaging, versioning/release, and user-facing docs.

Out:

- No new core engine behavior; this phase composes existing pieces and polishes.

## Key modules / files

```txt
src/cli/commands/init.ts        # scaffold project
src/cli/commands/migrate.ts     # SCOPE.md -> first work item
src/cli/commands/new.ts         # timestamped work item from template
src/scaffold/templates.ts       # config, first-item, lupe new templates
src/scaffold/skills.ts          # write .cursor/skills/lupe-*
README.md                       # user docs
```

## Init output

```txt
lupe-queue/
  <ts>_initial_scope.md
.lupe/
  state.json
  STATE.md
lupe.config.ts
.cursor/skills/lupe-*
```

## Tasks

1. Implement `lupe init`: create `lupe-queue/` with a generated first work item,
   `.lupe/` with initial `state.json` + `STATE.md`, `lupe.config.ts` with scope
   defaults, and `.cursor/skills/lupe-*`. Make it idempotent / safe on re-run.
2. Implement `lupe migrate`: detect an existing `SCOPE.md`, convert it into
   `lupe-queue/<ts>_initial_scope.md`, and scaffold `.lupe/` + config.
3. Implement `lupe new "<title>"`: create `lupe-queue/<now>_<slug>.md` from the
   `lupe new` template (Title/Goal/Context/Acceptance Criteria/Constraints) using
   the current UTC timestamp.
4. Implement the skills scaffolding (`.cursor/skills/lupe-*`) and wire
   `subagents`/`skills` config flags through planning and run.
5. Add packaging: build output, `bin` wiring, publish metadata, and a release
   script; document install/usage.
6. Write the user-facing `README.md`: quick start (`init -> new -> plan -> run
   -> review -> accept`), config reference, and the file-system contract.
7. Add an end-to-end test covering the full onboarding-to-accept flow.

## Acceptance criteria

- `lupe init` produces the documented tree and is safe to re-run.
- `lupe migrate` converts an existing `SCOPE.md` into the first work item and
  scaffolds the rest.
- `lupe new "<title>"` creates a correctly named, templated work item.
- Skills/subagents wiring is present and toggled by config.
- The package builds and installs; `README.md` documents the full flow.
- `typecheck`, `lint`, and `test` (including the e2e flow) all pass.

## Verification

```bash
bun run typecheck
bun run lint
bun test
bun run build
```

- E2E test: from an empty dir, `init -> new -> plan -> run -> review -> accept`
  (with mock agent + fake PR provider) yields the expected `.lupe/` tree and PR
  call.
- Unit tests: template rendering, slugging, `migrate` detection/conversion, init
  idempotency.

## Dependencies

- Phase 01 (config, CLI, contract).
- Phase 02 (work-item naming/model).
- Phase 03 (state + STATE.md for init scaffolding).
- Phases 04-08 (the flow that init/migrate/new feed into).
