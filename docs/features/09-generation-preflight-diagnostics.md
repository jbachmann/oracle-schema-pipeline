# Feature: Generation preflight diagnostics

- Status: Draft request — captured from architecture review; not approved for implementation
- Date: 2026-09-24
- Priority: Medium
- Request: Report predictable SQL rendering failures during validation and transformation.

## Context and Scope

Given a valid-shape model with an overlong SQL output line, transform reports and
validate identify the affected object before generate attempts publication.

Affected stages: transform reporting, validate, generate. Exclude relaxed SQL*Plus
limits, a new SQL client policy, and arbitrary expression rewriting.

This request captures the user's authorized review recommendations. Design defaults
below are proposals, not approved implementation decisions. Implementation has not
started. Resolve material open questions before promoting this request to Planned.

## Research Findings

Verified: a review probe with a default expression exceeding the physical-line
limit produced no validation errors, then generateSql threw at its final 2,400-byte
line check. validateTarget calls some renderers, but not full-script renderability
checks. assertValidTarget also reparses input through validateTarget.

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

## Proposed Design

Introduce an internal preparation result containing ordered SQL operations,
object provenance, and diagnostics. Build it from parsed semantic analysis, then
check final rendered physical lines without opening output files. Proposed code:
SQL_LINE_LIMIT, with object and measured byte count; classify other predictable
renderer failures using stable existing or dedicated codes.

Separate public unknown-input parsing from internal typed analysis. Both validation
and generation independently invoke preparation at their public boundary. Prevent
recursion between validate, prepare, and generate. Do not persist internal prepared
objects or expose them as a bypass around validation.

## Implementation Plan

1. Add the long-expression validation regression to `test/pipeline.test.ts`.
2. Build on shared analysis from the authoritative-semantic-validation request.
3. Extract preparation/rendering helpers from `src/generate.ts` and connect
   `src/validate.ts` without circular calls.
4. Align transformation reports and CLI diagnostics; update README.

## Test Plan

Test physical lines at and above the limit, UTF-8 byte counts, long defaults,
views, comments, indexes, and identifiers. Verify invalid models never open SQL
outputs and existing valid fixtures retain deterministic SQL. Exercise public
entrypoints independently and malformed JSON at each boundary.

Run `npm test` and `npm run typecheck`. Run `npm run build` for module/interface
changes. Catalog or generated-SQL changes also require `npm run test:integration`
against disposable Oracle services.

## Acceptance Criteria

- [ ] Known renderability failures appear in transformation and validation reports.
- [ ] Diagnostics identify objects and limits instead of only a generic final error.
- [ ] Generation independently rejects invalid input before writing.
- [ ] Public validation remains strict without redundant internal document cloning.
- [ ] Existing pipeline invariants and stated compatibility behavior remain covered.
- [ ] README and relevant architecture decisions describe the final behavior.

## Risks and Open Questions

Shared preparation must not create circular dependencies or force unnecessary
full-script retention for future streaming. Keep output policy unchanged in this request.
