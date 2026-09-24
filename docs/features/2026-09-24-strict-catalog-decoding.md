# Feature: Strict catalog decoding and faithful view metadata

- Status: Draft request — captured from architecture review; not approved for implementation
- Date: 2026-09-24
- Priority: High
- Request: Preserve catalog facts faithfully and reject ambiguous or unknown metadata.

## Context and Scope

Given catalog rows with unexpected flags, duplicate identities, or incomplete
members, extraction fails explicitly instead of coercing them into plausible facts.
For a view created WITH READ ONLY, its structured metadata accurately records the
restriction and replay emits it once.

Affected stages: extract, model, dictionary, validate, generate. Exclude new view
families and arbitrary SQL parsing.

This request captures the user's authorized review recommendations. Design defaults
below are proposals, not approved implementation decisions. Implementation has not
started. Resolve material open questions before promoting this request to Planned.

## Research Findings

Verified: `src/catalog.ts` normalizes multiple string flags using equality tests;
unknown values can become false. Row interfaces do not validate runtime results,
and view queries use `any`. The view query selects READ_ONLY but returns
readOnly=false and checkOption=NONE. Query text may still preserve restrictions;
the review did not establish universal replay loss.

Oracle documents READ_ONLY as Y/N metadata. Primary source, accessed 2026-09-24:
[ALL_VIEWS](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_VIEWS.html).

Repository paths refer to the implementation reviewed on 2026-09-24. The review
passed `npm test` (32 tests) and `npm run typecheck`; live integration was inspected,
not executed.

## Decisions and Boundaries

Keep source access read-only and scope selection explicit. No fallback from ALL_*
to DBA_*. Unknown or incomplete metadata must fail with object and field context.
Contract compatibility for restrictions remains an explicit open decision below;
do not silently change the meaning of existing v3 fields.

Preserve read-only extraction, offline transform/validate/generate, trusted SQL
fragment boundaries, independent generation validation, deterministic ordering,
non-overwriting artifacts, and secret exclusion. Invariant exceptions: none proposed.

## Proposed Design

Separate query transport, runtime row decoders, and domain assembly. Use explicit
allowed enum mappings, cardinality checks, identity uniqueness, and contiguous
ordered-member checks. Remove view-row `any` usage. Proposed extraction codes:
CATALOG_UNKNOWN_VALUE, CATALOG_CARDINALITY, CATALOG_INCOMPLETE_METADATA.

Establish whether retained view text owns restriction syntax or whether a verified
catalog representation can safely separate it. Populate readOnly from catalog
facts; obtain check-option facts from verified metadata rather than parsing SQL.
Generation must avoid double-emitting restrictions. Dictionary output must agree
with catalog facts. A semantic contract change requires a version bump, explicit
old-artifact handling, and coordinated updates to both source and target schemas.

## Implementation Plan

1. Add catalog decoder failure fixtures in `test/catalog.test.ts`.
2. Probe read-only/check-option catalog representation on supported Oracle versions.
3. Resolve restriction ownership and compatibility before changing `src/model.ts`.
4. Refactor `src/catalog.ts`, then align `src/validate.ts`, `src/generate.ts`, and
   `src/dictionary.ts` with the resolved representation.
5. Update README and the view ADR from the semantic-validation request.

## Test Plan

Test unexpected/null flags, duplicate identity/expression rows, incomplete ordered
members, missing comments, and result-set cleanup on failure. Independently query
Oracle restriction metadata for ordinary, read-only, and check-option views; verify
replay semantics and workbook facts, not only exporter-to-exporter equality.

Run `npm test` and `npm run typecheck`. Run `npm run build` for module/interface
changes. Catalog or generated-SQL changes also require `npm run test:integration`
against disposable Oracle services.

## Acceptance Criteria

- [ ] Unknown catalog flags cannot silently become supported states.
- [ ] Ambiguous and incomplete metadata fails with stable object/field context.
- [ ] View restrictions survive extraction, presentation, and replay exactly once.
- [ ] Compatibility behavior is documented and regression-tested.
- [ ] Existing pipeline invariants and stated compatibility behavior remain covered.
- [ ] README and relevant architecture decisions describe the final behavior.

## Risks and Open Questions

Restriction ownership and artifact-version handling require research and approval
before this request becomes implementation-ready. Supported source-version coverage
must be stated explicitly; the cited reference alone does not prove older behavior.
