# ADR 0007: Extraction events and bounded catalog member reads

- Status: Accepted
- Date: 2026-09-24

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

Batch constraint columns (including FK parent constraint identities) and index
keys/expressions within each selected table's metadata, using at most 32 exact
owner/name pairs per query. Owner/name values are bound individually; no owner/name
cross-product query is allowed. Retain sequential full LONG reads, result-set
paging/closure, scope visibility, deterministic ordering, and strict decoding.
Validate missing, duplicate, out-of-scope, and incomplete ordered members before
publishing constraint caches. Checks/defaults/view text are not rewritten or truncated.

The [benchmark report](../benchmarks/extraction.md) records baseline measurements,
size comparisons, memory limitations, and reproducible commands. Batch size 1 is a
comparison mode; sizes 1–128 are accepted internally, while the CLI uses 32.

## Consequences

Large member sets need fewer executes. This is not a promise of lower latency on
local or production databases. Model memory still grows with selected metadata.
Events expose schema identifiers and need the same operator judgment as metadata
artifacts. A start event identifies an outstanding operation, not ongoing server
activity. Observers must remain fast and synchronous. Existing source-read-only,
one-hop FK selection, recursive view selection, offline stages, trusted SQL,
independent generation validation, and non-overwrite invariants remain in force.
There is no JSON model migration and no exception to ADR 0001's invariants.
