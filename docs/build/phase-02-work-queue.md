# Phase 02 — Work Queue & Discovery

## Goal

Implement the input side of Lupe: discover user-authored work items in
`lupe-queue/`, parse and validate their timestamp-prefixed filenames, order them
chronologically, and produce a typed work-item model (including a content hash)
that the rest of the system consumes. After this phase, Lupe can answer "what
are the pending work items, in order?"

## Scope

In:

- Scan the configured input directory.
- Parse filenames against `^[0-9]{8}T[0-9]{6}_.+\.md$`.
- Chronological (lexicographic) ordering by prefix.
- Validation: warn on unmatched files, error on duplicate prefix, enforce the
  directory contract from Phase 01.
- Work-item model: `id`, `timestamp`, `description`, `path`, `fileHash`, raw
  contents.

Out:

- Persisting work items into `state.json` (Phase 03).
- Deciding which item is "pending" based on state (Phase 03 supplies status;
  this phase only reads the filesystem).

## Key modules / files

```txt
src/queue/discover.ts     # read dir, filter, order
src/queue/filename.ts     # parse/validate YYYYMMDDThhmmss_description
src/queue/workItem.ts     # WorkItem type + factory
src/queue/hash.ts         # sha256 content hash
src/queue/validate.ts     # duplicate prefix, unmatched, contract checks
```

## Tasks

1. Implement filename parsing: extract the 14-char timestamp (`YYYYMMDDThhmmss`)
   and the kebab/snake description; expose a typed result and a validator.
2. Implement directory discovery: list `lupe-queue/`, ignore non-markdown by the
   pattern, and sort ascending by prefix (lexicographic == chronological).
3. Implement `onUnmatchedFile` handling (default `warn`) so a typo'd filename
   surfaces a visible warning rather than a silent skip.
4. Implement `onDuplicatePrefix` handling (default `error`) when two files share
   a 14-digit prefix.
5. Build the `WorkItem` model: stable `id` (full `timestamp_description`),
   parsed timestamp, description, absolute path, raw markdown, and `fileHash`.
6. Compute the sha256 `fileHash` of file contents (used later for immutability).
7. Enforce the directory contract: error if a work item is found under `.lupe/`
   or a generated artifact appears under `lupe-queue/`.
8. Expose a `loadQueue(config)` function returning the ordered `WorkItem[]` plus
   collected warnings.

## Acceptance criteria

- Files matching the pattern are discovered and returned in ascending
  chronological order.
- Unmatched files produce a warning and are excluded (configurable).
- Duplicate prefixes raise a clear error (configurable).
- Each `WorkItem` has a stable `id` and a deterministic `fileHash`.
- Contract violations are detected and reported.
- `typecheck`, `lint`, and `test` all pass.

## Verification

```bash
bun run typecheck
bun run lint
bun test
```

- Unit tests: valid/invalid filenames, ordering with mixed timestamps,
  unmatched-file warning, duplicate-prefix error, hash stability, contract
  violation detection.
- Fixture-based test: a sample `lupe-queue/` directory yields the expected
  ordered ids.

## Dependencies

- Phase 01 (config loader for `input`, directory contract constants, logger,
  errors).
