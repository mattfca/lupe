# Phase 07 — Integration & Review

## Goal

Once all phases of a work item verify, merge them into the work item's
integration branch (`lupe/<id>`), re-verify the integrated result, and generate
the final-review package the user inspects before accepting. Support both
`per-item` (default) and `batch` review modes.

## Scope

In:

- Merge verified phase branches into the integration branch `lupe/<id>`.
- Re-run verify on the integrated branch.
- Generate the `final-review/` package.
- `lupe review` command to display the current item's review package.
- `per-item` vs `batch` review behavior.

Out:

- Opening the PR and advancing the queue (Phase 08) — `accept` consumes the
  review package produced here.

## Key modules / files

```txt
src/cli/commands/review.ts     # show current item's review package
src/integration/merge.ts       # merge phase branches -> lupe/<id>
src/integration/review.ts      # generate final-review/ artifacts
src/integration/batch.ts       # aggregate verified items for batch review
```

## Final-review package

```txt
.lupe/work-items/<id>/final-review/
  summary.md
  phase-summary.md
  diff-summary.md
  verification.md
  risks.md
  unresolved-items.md
```

## Tasks

1. Implement phase-branch integration: merge each verified `lupe/<id>/phase-NNN`
   into the integration branch `lupe/<id>` in dependency order; surface and
   report conflicts clearly.
2. Re-run verify on the integration branch to confirm the combined result still
   passes; record into the package's `verification.md`.
3. Generate the final-review artifacts: overall `summary.md`, per-phase
   `phase-summary.md`, aggregate `diff-summary.md`, `risks.md`, and
   `unresolved-items.md`.
4. Drive the transition `verified -> in_review` for `per-item` mode and update
   `current.integrationBranch` in `state.json`.
5. Implement `batch` mode: aggregate multiple `verified` items into a single
   combined review (documented as advanced/non-default).
6. Implement `lupe review` to render/locate the current item's review package.
7. Record a `decisions[]` entry when a review package is generated.

## Acceptance criteria

- Verified phases merge cleanly into `lupe/<id>`; conflicts are reported with
  actionable detail.
- The integrated branch is re-verified and the result captured.
- The `final-review/` package is generated with all expected files.
- `per-item` mode transitions the item to `in_review`; `batch` mode aggregates
  multiple items into one review.
- `lupe review` shows the current package.
- `typecheck`, `lint`, and `test` all pass.

## Verification

```bash
bun run typecheck
bun run lint
bun test
```

- Integration test (temp git repo): verified phase branches merge into
  `lupe/<id>`, re-verify passes, and the package files exist with expected
  content.
- Test conflict reporting on a deliberately conflicting pair of phases.
- Snapshot test for `summary.md` generation with a fixture.

## Dependencies

- Phase 03 (state, transitions, `current`).
- Phase 05 (phase branches/worktrees).
- Phase 06 (verify, used for re-verifying the integration branch).
