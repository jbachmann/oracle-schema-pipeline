# Feature: Generation preflight diagnostics

- Status: Implemented — authorized by the feature goal on 2026-09-24
- Date: 2026-09-24
- Priority: Medium
- Request: Report predictable SQL rendering failures during validation and transformation.

## Context and Scope

Given a valid-shape model with an overlong SQL output line, transform reports and
validate identify the affected object before generate attempts publication.

Affected stages: transform reporting, validate, generate. Exclude relaxed SQL*Plus
limits, a new SQL client policy, and arbitrary expression rewriting.

The feature goal authorized implementation of the design below. No invariant or
output-policy changes were needed.

## Research Findings

Before implementation, a review probe with a default expression exceeding the physical-line
limit produced no validation errors, then generateSql threw at its final 2,400-byte
line check. validateTarget called some renderers, but not full-script renderability
checks. assertValidTarget also reparsed input through validateTarget.

Repository paths refer to the implementation reviewed on 2026-09-24. The review
passed `npm test` (32 tests) and `npm run typecheck`; live integration was inspected,
not executed.

## Decisions and Boundaries

Keep independent generation validation and the existing conservative byte limit.
No JSON document shape change. Preserve CLI exit conventions: semantic errors in
transform/validate use exit 2; unsuccessful generation uses exit 1. Previously
late rendering failures become earlier stable diagnostics.

Preserve read-only extraction, offline transform/validate/generate, trusted SQL
fragment boundaries, independent generation validation, deterministic ordering,
non-overwriting artifacts, and secret exclusion. Invariant exceptions: none proposed.

## Implemented Design

Use an internal preparation result containing ordered SQL operations,
object provenance, and diagnostics. Build it from parsed semantic analysis, then
check final rendered physical lines without opening output files. Diagnostic code:
SQL_LINE_LIMIT, with object and measured byte count; classify other predictable
renderer failures using stable existing or dedicated codes.

Separate public unknown-input parsing from internal typed analysis. Both validation
and generation independently invoke preparation at their public boundary. Prevent
recursion between validate, prepare, and generate. Do not persist internal prepared
objects or expose them as a bypass around validation.

## Implementation

1. Added the long-expression validation regression to `test/pipeline.test.ts`.
2. Reused shared analysis from the authoritative-semantic-validation request.
3. Moved rendering into `src/prepare.ts` and connected `src/validate.ts` without
   circular calls or repeated public-boundary parsing.
4. Aligned transformation reports and CLI diagnostics; updated README and ADR 0003.

## Test Plan

Test physical lines at and above the limit, UTF-8 byte counts, long defaults,
views, comments, indexes, and identifiers. Verify invalid models never open SQL
outputs and existing valid fixtures retain deterministic SQL. Exercise public
entrypoints independently and malformed JSON at each boundary.

Run `npm test` and `npm run typecheck`. Run `npm run build` for module/interface
changes. Catalog or generated-SQL changes also require `npm run test:integration`
against disposable Oracle services.

## Acceptance Criteria

- [x] Known renderability failures appear in transformation and validation reports.
- [x] Diagnostics identify objects and limits instead of only a generic final error.
- [x] Generation independently rejects invalid input before writing.
- [x] Public validation remains strict without redundant internal document cloning.
- [x] Existing pipeline invariants and stated compatibility behavior remain covered.
- [x] README and relevant architecture decisions describe the final behavior.

## Risks and Open Questions

Preparation lives in `src/prepare.ts` and depends only on renderers and semantic
analysis types. Validation invokes preparation on its parsed document; generation
uses an unknown-input assertion boundary and joins only validated operations.
Line checks run per operation without joining a full script during validation.
Output policy is unchanged; no open design questions remain.

## Verification

- `npm test`: 136 tests passed, including byte boundaries, renderer diagnostics,
  independent public entrypoints, and CLI reports/publication rejection.
- `npm run typecheck` and `npm run build`: passed.
- `npm run test:integration`: all 3 tests passed against disposable Oracle services,
  including preflight rejection on an extracted catalog model and reconstruction
  of the 98-table, 5-view fixture.
- Existing offline fixture SQL is byte-identical to the pre-change baseline.
- Changed TypeScript files pass Prettier; `git diff --check` passes.
