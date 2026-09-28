# Feature: Retry a local clone from existing SQL

- Status: Implemented
- Date: 2026-09-28
- Request: Run `npm run db:clone-retry -- <artifacts-folder>` to rebuild the
  disposable local destination using an existing run's `clone.sql`.

## Context and Scope

A clone can finish extraction and generation but fail during destination setup
or replay. The requester selected reuse of the existing `clone.sql` instead of
regenerating it from the extracted source. Retry starts destination reconstruction
from a fresh reset; it does not resume partway through SQL or preserve partially
created destination objects.

Included: a positional artifacts-directory argument, offline input checks,
existing local destination protections, complete destination reconstruction,
progress, and separate immutable retry artifacts. No extraction, dictionary,
transformation, or generation stage runs. No source connection is required.
Core pipeline behavior and Oracle metadata support remain unchanged.

Example: a generated script creates `APP.T (ID NUMBER)` but the original attempt
fails during `startup` or `replay`. Given its complete artifacts, the retry resets
the fixed local destination, runs prerequisite setup, replays the saved script,
and verifies the modeled objects. It does not copy application rows.

```sh
npm run db:clone-retry -- ./artifacts/db-clone-2026-09-28-...
```

## Research Findings

Verified locally:

- `scripts/clone-workflow.ts` already separates pipeline work from destination
  reset, startup, prerequisite execution, setup verification, replay, and final
  verification. Every attempt acquires a shared per-user destination lock.
- The workflow saves `clone.sql`, `target.json`, `report.json`,
  `target.json.complete.json`, and a version-1 `run-result.json`. It preserves
  artifacts after failure. Interrupted runs may lack a result.
- `src/completion.ts` verifies target/report hashes, sizes, roles, and canonical
  absolute paths. The manifest does not cover `clone.sql`.
- `scripts/compose-destination.ts` accepts the format-5 generated preamble and
  adapts only that preamble for SQL*Plus. Setup and final verification require
  a target document, including its embedded policy.
- `scripts/clone-config.ts` currently loads source credentials, resolves source
  TNS settings, and reads selection and policy even when only destination
  settings would be needed. Prerequisite SQL is read from current local config;
  its size and hash, but not its contents, are stored in the run result.
- ADRs 0001, 0005, and 0008 require validation, non-overwriting publication,
  completion checks, local resource identity checks, and isolated orchestration.

Inference: a destination-only retry can reuse the existing destination lifecycle
with a separate input preparation path. No new Oracle or dependency behavior is
assumed; this plan relies on repository behavior rather than external research.

## Decisions and Boundaries

- Reuse the saved SQL exactly, subject only to the existing runtime preamble
  adaptation. Do not regenerate SQL, silently repair it, or fall back to extraction.
- Require `clone.sql`, `target.json`, `report.json`, and
  `target.json.complete.json`. Source, selection, dictionary, and standalone policy
  artifacts are unnecessary. The target's embedded policy controls setup checks.
- Accept an otherwise complete run regardless of its prior success/failure status
  or missing `run-result.json`; do not guess retry eligibility from a stage name.
- Use current `config/local/config.json` destination settings and optional
  prerequisite SQL. This permits correcting destination setup before retrying.
  Do not require or resolve source settings, selection, or current policy files.
  Preserve prerequisite requirements and directive checks, applying them to the
  saved target policy. Record the actual prerequisite hash for this attempt.
- Allocate a new `artifacts/db-clone-retry-<timestamp>-<suffix>/` directory.
  Never write into or remove files from the supplied artifacts directory.
- Preserve the fixed operational Compose project, local socket requirement,
  image preflight, resource identity checks, lock, reset ordering, cancellation,
  SQL*Plus failure handling, and final verification. No remote destination option.
- The command itself authorizes the same destructive local reset as `db:clone`.
  Document this clearly; no new interactive confirmation or force flag.

## Proposed Design

### Entry point and configuration

Add `scripts/clone-retry.ts` and the `db:clone-retry` npm script. Accept exactly
one positional directory, resolving relative paths from the invoking working
directory. Support `--help` without config, artifact writes, locks, or Docker.
Missing/extra arguments and unknown flags produce `CLONE_RETRY_USAGE`, usage
guidance, and exit 1. Mirror the existing signal and exit-status handling.

Refactor destination configuration and prerequisite loading/validation into
shared helpers in `scripts/clone-config.ts`. A retry loader parses the top-level
version and destination/prerequisite fields from the existing config, accepting
known source/selection/policy keys without validating or using their values.
Reject unknown top-level keys and invalid destination settings. Permit omitted
source/selection/policy for retry; ordinary `db:clone` keeps its strict contract.
Use a dedicated destination settings type instead of coupling destination
construction to the full source-loaded configuration.

### Artifact preparation

Add `scripts/clone-retry-input.ts` to read required inputs, verify the original
completion bundle, parse the target with `targetDocumentSchema`, and apply the
existing semantic validation gate. Reject unsupported model versions and blocking
diagnostics before any reset. Decode SQL as strict UTF-8 and require the existing
`generatedReplay` preamble check. Do not execute arbitrary script paths provided
inside metadata.

Treat the input directory as stable, trusted local artifacts, as required for
existing publication. Read and retain the checked bytes; verify their target/report
hashes against the manifest so the snapshot is the bundle that was checked.
Publish independent copies of the SQL, target, and report in the new attempt using
exclusive publication. Publish a fresh target/report completion manifest with
the new canonical paths. Never reuse the old manifest with copied paths or hard
link mutable inputs. Reverify the new bundle before reset, and replay the retained
SQL whose bytes were copied. All required snapshot publication must finish before
reset. The new folder must itself be a valid input to a subsequent retry.

Add immutable `retry-input.json`, version 1, with strict fields:

- `version`: literal `1`.
- `artifacts`: ordered entries for `sql`, `target`, and `report`, each containing
  `role`, `bytes` (safe nonnegative integer), and `sha256` (64 lowercase hex digits).

This records the exact consumed artifacts without persisting arbitrary input paths,
source credentials, configuration, or prerequisite contents. It is an audit record,
not proof that an older SQL file was originally generated from the target.
Keep `run-result.json` version 1 and its existing fields unchanged; the separate
retry record identifies retry attempts without changing existing result consumers.

### Shared destination lifecycle

Refactor `scripts/clone-workflow.ts` so normal and retry workflows share attempt
allocation, lock ownership, stage execution, result publication, and destination
reconstruction. Keep input preparation explicit for each mode rather than adding
an arbitrary start-stage switch. Preserve existing normal-clone stage ordering.

Retry stages: lock, retry-input, config, preflight, reset-preflight, reset, startup,
optional prerequisite, setup-verification, replay, verification. Finish artifact
checks and snapshots before reset-preflight. Recheck lock ownership and destination
identity immediately before reset as today. Print the retry's new artifacts path
and existing success/failure summaries. All failures preserve both folders and,
after reset starts, the partial destination.

### Diagnostics and compatibility

- `CLONE_RETRY_INPUT_INVALID`: required file unreadable/missing, invalid JSON or
  UTF-8, unsupported target version, blocking target diagnostics, or unsupported
  SQL preamble. Use fixed actionable messages identifying the expected artifact
  or validation step, without raw exceptions, SQL, or configuration values.
- `OUTPUT_INCOMPLETE`: missing, invalid, path-mismatched, or hash-mismatched
  completion bundle, retaining the existing public code and safe workflow output.
- Preserve config, prerequisite, publication, lock, interruption, Docker, reset,
  startup, replay, and verification error codes and child exit codes.
- A folder containing only SQL is insufficient for existing verification. Missing
  generation output requires a new normal clone or separate offline preparation;
  retry never invents missing metadata.
- Existing current-format folders work without newly added hashes or a successful
  result. Old model versions remain explicitly rejected. Moved folders whose
  original completion manifest paths no longer match remain rejected; automatic
  relocation or manifest rewriting is outside this feature.

No source/target/policy format or generated SQL changes. No conflict with ADR 0001
or ADR 0008; no superseding ADR is needed. Clarify retry reuse and fresh attempt
publication in ADR 0008 without weakening its generation-before-reset requirement:
generation was completed by the original attempt and its supported outputs are
checked before the retry resets the destination.

## Implementation Plan

1. Extract reusable destination config and prerequisite helpers in
   `scripts/clone-config.ts`; update the destination constructor's type in
   `scripts/compose-destination.ts`. Retain ordinary clone validation.
2. Implement checked input snapshots and retry provenance in the new
   `scripts/clone-retry-input.ts`, using `src/completion.ts`, `src/files.ts`,
   `src/model.ts`, and the existing validation entry point.
3. Share orchestration in `scripts/clone-workflow.ts` and add the retry workflow,
   preserving normal-clone behavior and result schema.
4. Add `scripts/clone-retry.ts` and the npm script in `package.json`.
5. Add tests below. Update `README.md` with invocation, required artifacts,
   destructive reset, current config/prerequisites, no source access, fresh output,
   failure recovery, and version/path compatibility. Clarify ADR 0008.
6. Run `npm run typecheck`, `npm test`, and `npm run build`. Exercise the existing
   opt-in integration suite only when its operational-resource isolation checks
   pass; never delete an existing operational database merely to enable tests.

## Test Plan

- New `test/clone-retry-input.test.ts`: valid existing folder without retry
  provenance; missing result; missing required files; bad JSON/UTF-8; unsupported
  format/preamble; blocking validation diagnostics; mismatched manifest/hash;
  moved-folder rejection; exact SQL bytes and snapshot digests; publication
  failure before reset; unchanged originals; retrying a retry folder.
- Extend `test/clone-config.test.ts`: retry works with missing/invalid source
  credentials and unavailable TNS files; no selection/current policy file reads;
  strict destination validation; saved target policy drives prerequisites;
  changed prerequisite bytes are checked and hashed; ordinary clone stays strict.
- Extend `test/clone-workflow.test.ts`: no extract/dictionary/transform/generate
  calls or source credentials; exact saved SQL replay; shared stage ordering;
  errors before reset preserve destination; reset/startup/prerequisite/replay/
  verification failures cannot report success; shared lock contention across
  normal and retry runs; cancellation and result publication; multiple attempts
  retain all earlier artifacts.
- New `test/clone-retry-cli.test.ts`: positional paths including spaces, relative
  resolution, help, missing/extra arguments, unknown flags, and nonzero failures.
- Extend `test/integration/local-clone.test.ts` within its existing ownership
  guards: reuse one generated bundle after an injected destination replay failure,
  make source settings unusable, retry successfully, and independently verify
  destination objects and original artifact hashes. Prove a marker in the owned
  partial destination disappears after retry reset. Retain the suite's refusal
  of pre-existing operational resources and explicit test project for fixtures.

## Acceptance Criteria

- [x] The single npm invocation replays existing SQL without remote source access.
- [x] No extraction, dictionary, transformation, or generation stage runs.
- [x] Required metadata is validated and snapshotted before destination reset.
- [x] The local destination is rebuilt and independently verified with existing checks.
- [x] Current destination settings and guarded prerequisite SQL apply to the retry.
- [x] Original artifacts remain byte-identical; every attempt has fresh outputs.
- [x] Existing current-format runs work without a prior successful result.
- [x] Unsupported/incomplete input fails with actionable stable diagnostics.
- [x] Locks, identity checks, secrets isolation, interruption, and normal cloning
      retain their existing behavior.
- [x] Unit checks, typecheck, build, and appropriately isolated integration
      validation are recorded with any unavailable checks stated explicitly.

## Risks and Open Questions

Existing completion manifests do not bind SQL to the target. Checking the generated
preamble and validating the target cannot establish that arbitrary edited SQL
matches that target. This feature accepts trusted original run artifacts and does
not claim cryptographic authenticity, sandbox trusted SQL fragments, or regenerate
SQL for comparison. New snapshot hashes record consumed bytes only.

Current prerequisite SQL can differ from the original attempt; this is useful for
repairing setup, and the new result records its actual hash. Reset is destructive
and has no rollback. Schema checks retain their existing limits and do not prove
complete semantic equivalence. No unresolved requester scope decisions remain.

## Validation Record

Validated on 2026-09-28:

- `npm run typecheck` and `npm run build`: passed.
- `npm test`: 356 passed, zero failures or skips.
- `ORACLE_LOCAL_CLONE_INTEGRATION=1 node --import tsx --test --test-concurrency=1 test/integration/local-clone.test.ts`:
  passed against Oracle 23.26.3.0.0 in the guarded local Compose destination.
  No operational container or volume existed before the suite acquired ownership.
  The test injected replay failure, disabled source configuration, retried the saved
  bundle, independently checked objects and marker removal, compared original
  artifact bytes, and cleaned up its owned operational destination.
- `git diff --check`: passed.

The broader integration files were not rerun; this change's Oracle validation used
its affected local-clone suite. No model or generated SQL format changed.
