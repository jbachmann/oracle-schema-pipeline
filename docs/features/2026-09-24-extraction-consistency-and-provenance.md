# Feature: Extraction consistency and provenance

- Status: Draft request — captured from architecture review; not approved for implementation
- Date: 2026-09-24
- Priority: Medium
- Request: Make extraction provenance explicit and detect observable schema changes during capture.

## Context and Scope

Given schema DDL during extraction, detectable object changes cause an actionable
failure rather than publication of a silently mixed capture. Completed artifacts
record enough nonsecret provenance to identify the extraction interval and tool.

Affected stages: extract, model, transform pass-through, dictionary, offline readers.
Exclude snapshot guarantees, source locks/DDL, automatic retries, and source data.

This request captures the user's authorized review recommendations. Design defaults
below are proposals, not approved implementation decisions. Implementation has not
started. Resolve material open questions before promoting this request to Planned.

## Research Findings

Verified: `src/extract.ts` gathers metadata across separate reads, uses adapter
caches for some facts, and assigns extractedAt near completion. Documents record
sourceVersion but not start/end, tool version, or catalog scope. README correctly
states that extraction is not a point-in-time snapshot.

Inference: concurrent DDL can combine facts from different moments. No live DDL
race was exercised during this review.

Repository paths refer to the implementation reviewed on 2026-09-24. The review
passed `npm test` (32 tests) and `npm run typecheck`; live integration was inspected,
not executed.

## Decisions and Boundaries

Keep read-only source access and require stable source DDL operationally. Describe
change detection as best effort, never snapshot isolation. Provenance belongs to
source facts and passes unchanged through transformation. Proposed version policy:
use the next available document format version for new required fields; do not
silently synthesize missing historical provenance.

Preserve read-only extraction, offline transform/validate/generate, trusted SQL
fragment boundaries, independent generation validation, deterministic ordering,
non-overwriting artifacts, and secret exclusion. Invariant exceptions: none proposed.

## Proposed Design

Proposed extraction metadata: startedAt and completedAt (UTC ISO timestamps),
toolVersion (string), catalogScope (all or dba), and consistencyMode (an explicitly
named best-effort mode). Retain extractedAt with a documented relation to
completedAt, or remove it only through the same reviewed version change.

Probe object identity/change indicators before and after bounded discovery and
capture, including referenced keys and recursively reached views. On detected drift,
fail with SOURCE_SCHEMA_CHANGED and object context; publish no source artifact.
Validate that the selected Oracle indicators are accessible in both catalog scopes.
No connection strings, passwords, TNS paths, or environment dumps enter artifacts.
Additional charset/NLS provenance requires an explicit field allowlist before inclusion.

## Implementation Plan

1. Research Oracle change indicators, granularity, and privileges with primary docs.
2. Resolve detection limits, privilege behavior, and provenance schema/version policy.
3. Add catalog consistency probes and extraction interval handling in
   `src/catalog.ts` and `src/extract.ts`.
4. Update `src/model.ts`, transform pass-through, `src/dictionary.ts`, fixtures,
   examples, and README together.
5. Coordinate version changes with the strict-catalog-decoding request; document
   that read-only and non-snapshot invariants remain unchanged.

## Test Plan

Use a fake catalog to simulate rename/drop/recreate and metadata changes between
reads; reject without source output. Add controlled concurrent DDL in disposable
Oracle integration fixtures. Verify unchanged captures, inaccessible probe metadata,
provenance pass-through, deterministic injected timestamps, and explicit old-version
rejection or an approved migration path.

Run `npm test` and `npm run typecheck`. Run `npm run build` for module/interface
changes. Catalog or generated-SQL changes also require `npm run test:integration`
against disposable Oracle services.

## Acceptance Criteria

- [ ] Detected source drift fails before artifact publication.
- [ ] Artifacts record approved nonsecret extraction provenance.
- [ ] Both catalog scopes have documented probe requirements and failure behavior.
- [ ] Documentation never describes best-effort detection as snapshot consistency.
- [ ] Existing pipeline invariants and stated compatibility behavior remain covered.
- [ ] README and relevant architecture decisions describe the final behavior.

## Risks and Open Questions

Oracle indicators may miss changes due to timestamp granularity, visibility, or
DDL behavior; research must establish precise limitations. Approve metadata fields,
version handling, and failure policy for unavailable probes before implementation.
