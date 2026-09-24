# Feature: Extraction observability and measured performance

- Status: Draft request — captured from architecture review; not approved for implementation
- Date: 2026-09-24
- Priority: Medium
- Request: Make extraction progress and bottlenecks observable, then reduce measured round trips.

## Context and Scope

Given a large metadata selection, an operator can observe progress, timings, row
counts, and failures without exposing credentials. Representative benchmarks guide
query batching while extraction produces equivalent complete metadata.

Affected stages: extract and CLI; shared stage events may cover offline commands.
Exclude telemetry services, mandatory logging infrastructure, unbounded concurrency,
and changing the one-hop selection contract.

This request captures the user's authorized review recommendations. Design defaults
below are proposals, not approved implementation decisions. Implementation has not
started. Resolve material open questions before promoting this request to Planned.

## Research Findings

Verified: queryRows in `src/catalog.ts` centrally executes and fetches queries but
records no timings or row counts. Extraction performs sequential per-object reads,
constraint-column lookups, and two reads per index. CLI primarily reports completion.
Inference: round trips are a plausible bottleneck; no latency or memory benchmark
was collected, so no speedup percentage is claimed.

Repository paths refer to the implementation reviewed on 2026-09-24. The review
passed `npm test` (32 tests) and `npm run typecheck`; live integration was inspected,
not executed.

## Decisions and Boundaries

Proposed default: opt-in JSON-lines progress on stderr, preserving artifact bytes
and stdout behavior. Use a typed optional event callback in core extraction/catalog
code. Never log passwords, raw SQL/binds, connection descriptors, or TNS file contents.
No source/target JSON format change. Batch only after measuring a baseline.

Preserve read-only extraction, offline transform/validate/generate, trusted SQL
fragment boundaries, independent generation validation, deterministic ordering,
non-overwriting artifacts, and secret exclusion. Invariant exceptions: none proposed.

## Proposed Design

Proposed event fields: version, runId, stage, event, queryCategory, object when
applicable, elapsedMs, rows, and stable error code. Separate telemetry from semantic
diagnostics. Record query counts, wall time, and peak memory in a benchmark report.

Group constraint columns and index keys/expressions by bounded selected-object
batches. Retain full LONG reads, scope visibility checks, deterministic ordering,
and explicit missing-data failures. Do not apply Promise.all indiscriminately to
one connection. Evaluate workbook streaming or broader concurrency only if measured
memory or latency warrants a separate request.

## Implementation Plan

1. Define event interface and CLI opt-in in `src/cli.ts`.
2. Instrument queryRows and extraction traversal in `src/catalog.ts` and `src/extract.ts`.
3. Add benchmark fixtures varying objects, constraints, indexes, graph depth, and latency.
4. Measure baseline, implement bounded batching, and compare results.
5. Document event fields, privacy guarantees, measurements, and operational use.

## Test Plan

Test event ordering, success/failure timing, stable query categories, secret
redaction, disabled logging, and unchanged artifacts. Test batched multi-owner and
quoted names, missing members, partial result batches, LONG completeness, and scope
isolation. Use Oracle integration for catalog query changes.

Run `npm test` and `npm run typecheck`. Run `npm run build` for module/interface
changes. Catalog or generated-SQL changes also require `npm run test:integration`
against disposable Oracle services.

## Acceptance Criteria

- [ ] Operators can distinguish active progress from failure during extraction.
- [ ] Events contain no credentials or connection configuration.
- [ ] Benchmarks report latency, query counts, and memory before and after batching.
- [ ] Optimized extraction preserves supported metadata and rejection behavior.
- [ ] Existing pipeline invariants and stated compatibility behavior remain covered.
- [ ] README and relevant architecture decisions describe the final behavior.

## Risks and Open Questions

Confirm event CLI naming and benchmark workload/latency targets before freezing
interfaces. Batch-size and memory limits should follow measurements, not an assumed
universal speed target.
