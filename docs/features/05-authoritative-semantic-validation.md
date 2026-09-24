# Feature: Authoritative semantic validation

- Status: Implemented and verified
- Date: 2026-09-24
- Priority: High
- Request: Reject inconsistent or out-of-scope models before generating SQL.

## Context and Scope

Given a target artifact containing an unrelated view, duplicate view columns,
specialized view flags, a table/view name collision, or invalid timestamp precision,
validation reports blocking diagnostics and generation writes no SQL.

Affected stages: transform reports, validate, generate. Include shared dependency
analysis and deterministic ordering; exclude new supported Oracle object types.

Implementation was authorized by the user's goal request. The final decisions are
recorded in ADR 0003; the strict v3 document contract remains unchanged.

## Research Findings

Verified: `src/validate.ts` checks view feature strings but does not independently
reject all modeled specialized-view flags. It checks table closure, but not view
reachability from requested roots. Validation and generation separately implement
repeated-scan dependency ordering.

Review probes confirmed that unrelated views, editioning flags with empty feature
lists, duplicate view columns, table/view identity collisions, and TIMESTAMP scale
99 all pass validation and generate SQL. These are offline model probes, not live
Oracle execution results.

Repository paths refer to the implementation reviewed on 2026-09-24. The review
passed `npm test` (32 tests) and `npm run typecheck`; live integration was inspected,
not executed.

## Decisions and Boundaries

Retain strict v3 document shapes. Tightening validation intentionally rejects
previously accepted inconsistent artifacts; valid supported artifacts remain
compatible. No automatic artifact repair or dependency expansion. Feature strings
supplement modeled facts instead of overriding them. No invariant exception.

Preserve read-only extraction, offline transform/validate/generate, trusted SQL
fragment boundaries, independent generation validation, deterministic ordering,
non-overwriting artifacts, and secret exclusion. Invariant exceptions: none proposed.

## Implemented Design

Add an internal semantic analysis module returning object indexes, root-reachable
closure, ordered views, and diagnostics. Traverse view edges only from requested
view roots; preserve the existing one-hop FK rule and role precedence. Check shared
table/view identities, duplicate columns, specialized flags, explicit unsupported
collation, and datatype bounds independently of extraction annotations.

Diagnostic codes: EXTRA_VIEW, OBJECT_NAME_COLLISION,
DUPLICATE_VIEW_COLUMN, UNSUPPORTED_VIEW, UNSUPPORTED_COLLATION, UNSUPPORTED_TYPE.
Reuse existing codes where their meaning already matches. Preserve missing-edge
and cycle diagnostics. Use ordinal object-key ordering and adjacency/indegree
analysis rather than repeatedly scanning all pending nodes.

## Implementation Plan

1. Add failing regression cases to `test/pipeline.test.ts` using `test/fixtures.ts`.
2. Extract indexed analysis from `src/validate.ts`; strengthen `src/types.ts` bounds.
3. Reuse analysis ordering in `src/generate.ts` without bypassing independent validation.
4. Update README compatibility notes and add an ADR explicitly superseding ADR
   0001's view exclusion; preserve every other invariant.

## Test Plan

Cover each confirmed gap, valid boundary timestamp precision, missing roots,
cycles, diamonds, duplicate dependencies, mixed roles, and unrelated-view table
inclusions. Shuffle unordered input collections and assert stable ordering. Extend
Oracle round-trip fixtures when SQL behavior changes.

Run `npm test` and `npm run typecheck`. Run `npm run build` for module/interface
changes. Catalog or generated-SQL changes also require `npm run test:integration`
against disposable Oracle services.

## Acceptance Criteria

- [x] Each confirmed invalid model yields an object-specific blocking diagnostic.
- [x] Unreachable views cannot introduce additional accepted tables.
- [x] Supported fixtures preserve semantics and independent generation validation.
- [x] Validation and generation use one deterministic dependency analysis.
- [x] Existing pipeline invariants and stated compatibility behavior remain covered.
- [x] README and relevant architecture decisions describe the final behavior.

## Risks and Open Questions

The specialized-view rejection matrix covers editioning, typed, superview and
container-data flags independently of annotations, plus conflicting read-only and
check-option settings. Trusted SQL expressions remain opaque. No new object types
or automatic artifact repair were introduced.

## Implementation Verification

- `npm test`: passed, 39 tests, including rejection before CLI SQL-file creation.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- `npm run test:integration`: passed against the disposable Oracle source and
  destination services, including SQL replay and semantic comparison after
  re-extraction. The test also verifies SQL stability after shuffling extracted
  views and dependency edges. Initial environment failures were resolved by
  reclaiming unused Docker build cache and recreating the incomplete test volumes
  created during the disk-full attempt.
