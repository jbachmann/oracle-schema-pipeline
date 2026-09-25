# Feature: Extraction observability and measured performance

- Status: Implemented — authorized by the feature goal on 2026-09-24
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

Implemented under the user's feature goal. The optional naming/workload question
received no override, so implementation uses `--progress-json` and the representative
synthetic workloads described below. No architecture invariant is changed.

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

Selected default: opt-in JSON-lines progress on stderr, preserving artifact bytes
and stdout behavior. Use a typed optional event callback in core extraction/catalog
code. Never log passwords, raw SQL/binds, connection descriptors, or TNS file contents.
No source/target JSON format change. The baseline was measured before batching was implemented.

Preserve read-only extraction, offline transform/validate/generate, trusted SQL
fragment boundaries, independent generation validation, deterministic ordering,
non-overwriting artifacts, and secret exclusion. Invariant exceptions: none proposed.

## Final Design

Event fields: version, runId, stage, event, queryCategory, object when
applicable, elapsedMs, rows, and stable error code. Separate telemetry from semantic
diagnostics. Record query counts, wall time, and peak memory in a benchmark report.

Group constraint columns and index keys/expressions by bounded selected-object
batches. Retain full LONG reads, scope visibility checks, deterministic ordering,
and explicit missing-data failures. Do not apply Promise.all indiscriminately to
one connection. Evaluate workbook streaming or broader concurrency only if measured
memory or latency warrants a separate request.

## Completed Implementation

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

- [x] Operators can distinguish active progress from failure during extraction.
- [x] Events contain no credentials or connection configuration.
- [x] Benchmarks report latency, query counts, and memory before and after batching.
- [x] Optimized extraction preserves supported metadata and rejection behavior.
- [x] Existing pipeline invariants and stated compatibility behavior remain covered.
- [x] README and relevant architecture decisions describe the final behavior.

## Results and Limits

- Versioned `--progress-json` stderr events cover password input, connection,
  extraction, table/view reads, queries, publication, and safe CLI failures.
- A shared optional `ExtractionProgress` callback has explicit query categories,
  monotonic timings, decoded row counts, allowlisted error codes, and no raw driver
  diagnostics. Observer exceptions do not change extraction.
- Batches contain at most 32 exact constraint/index owner/name pairs, with bound
  predicates, full LONG reads, paged result sets, and sequential connection use.
- Synthetic workloads vary 1–20 tables, 1–40 constraints/indexes per table, view
  depth 0–4, and 0/2 ms simulated execute latency. The default reduced query counts
  657 → 237 and 521 → 65 on the larger fixtures, preserving metadata hashes.
- [Benchmark report](../benchmarks/extraction.md) records pre-change baseline,
  isolated size 1/16/32/64 comparisons, wall time, memory, and measurement limits.
  [ADR 0007](../adr/0007-extraction-observability-and-batching.md) records decisions.
- Offline tests, strict typecheck, build, and all four live Oracle integration
  tests pass, including equality of batched and single-member extraction of all
  98 source tables and selected views under restricted ALL-scope access.

Timings are illustrative synthetic observations, not production speed guarantees.
Batch size bounds predicates, not total memory or individual LONG size. Metadata
still grows with selection size. There is no heartbeat during an outstanding
query, no snapshot consistency change, and no concurrency or workbook streaming.
