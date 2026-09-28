# ADR 0007: Extraction events and bounded catalog member reads

- Status: Accepted
- Date: 2026-09-24
- Amended: 2026-09-28 (cross-object batching)

## Context

Sequential member queries scale with every constraint and index. Operators need
progress without embedding operational telemetry in semantic artifacts. Synthetic
baselines confirm query-count sensitivity to metadata size and transport latency.

## Decision

Expose an optional typed `ExtractionProgress` callback shared by extraction and
catalog operations. The CLI enables JSON-lines stderr output with `--progress-json`.
Version 1 events describe password input, connection, extraction, object, query, publication, and
terminal CLI failure operations with one generated run ID. Timings use a monotonic
clock and query completion includes decoded row count after closing the result set.
Callbacks are best-effort: synchronous callback exceptions do not affect extraction.
There is no service, file logger, heartbeat timer, or concurrent connection use.

Query categories are explicit literals in code, never derived from SQL. Raw SQL,
binds, values, connection configuration, and error messages are excluded. Only
object references and allowlisted stable error codes enter events. In progress
mode CLI errors are also JSON with safe codes. Default stdout and artifact bytes
remain unchanged; extraction timestamps retain their existing meaning.

Batch table properties/comments, columns/comments, identities, constraints,
indexes and prerequisites across selected tables. Batch constraint columns
(including FK parent identities) and index keys/expressions/dependencies across
those tables. Batch view definitions/columns/restrictions/dependencies across the
currently discovered pending views without changing traversal order or selection.
Each query handles at most 32 exact owner/name pairs by default; values are bound,
never interpolated. Index dependencies additionally retain the selected index's
associated table identity. Prerequisite and index-dependency predicates stay
separate because their filtering and null-owner semantics differ.

Single-object and grouped reads share SQL definitions. Grouped reads join a CTE
containing only bound selection values at an explicit outer-query join slot and
project grouping identities. Catalog LONG values are selected directly, never
unioned, truncated or rewritten. Member reads retain exact-pair predicates.
Result-set paging/closure, scope visibility and strict decoding remain unchanged.

Optional `SourceCatalog` prefetch hooks preserve custom single-object catalog
implementations. Temporary row staging is cleared after each assembly batch.
Complete definitions are published only after all batch members validate and are
consumed on first access. On failure, constraint entries added by the failed batch
are rolled back; earlier complete batches remain usable. Empty optional groups
are cached, while missing required rows, duplicates and out-of-batch or incomplete
ordered members fail explicitly. Prefetch can change which invalid object fails
first; it does not turn failures into partial source documents.

Progress stays version 1 with the same categories. Multi-object query events omit
`object`; each actual execution emits its own operation events. Prefetch may precede
object events, whose timings now describe assembly and remaining on-demand work.
Use category timings and extraction elapsed time for database performance analysis.

The [current benchmark report](../benchmarks/cross-object-extraction.md) records a
fresh pre-change baseline, category counts, timing, memory and metadata parity.
The [historical report](../benchmarks/extraction.md) measures the earlier member-only
optimization. Size 1 now disables cross-object and member batching; it is not the
previous default baseline. Sizes 1–128 remain accepted internally; CLI uses 32.

## Consequences

Large object selections and member sets need fewer executes. Deep view chains
still require incremental dependency discovery. This is not a promise of lower latency on
local or production databases. Model memory still grows with selected metadata.
Events expose schema identifiers and need the same operator judgment as metadata
artifacts. A start event identifies an outstanding operation, not ongoing server
activity. Observers must remain fast and synchronous. Existing source-read-only,
one-hop FK selection, recursive view selection, offline stages, trusted SQL,
independent generation validation, and non-overwrite invariants remain in force.
There is no JSON model migration and no exception to ADR 0001's invariants.
