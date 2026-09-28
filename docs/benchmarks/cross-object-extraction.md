# Cross-object extraction benchmark, 2026-09-28

Synthetic measurements on Node v24.11.1, macOS x64.

Fresh synthetic measurements compare the immediately preceding within-table
batching implementation with cross-object batching, both at batch size 32.
[Raw observations](cross-object-extraction-2026-09-28.json) include per-category
counts, sampled RSS, process peak RSS and metadata hashes. The older September 24
report predates per-index dependency reads and is not the baseline for this change.

## Results

| Workload                                                      | Queries before → after | Elapsed ms before → after | Process peak RSS MiB before → after |
| ------------------------------------------------------------- | ---------------------- | ------------------------- | ----------------------------------- |
| 74 tables, 1 constraint/index each, 2 ms latency              | 889 → 37               | 2331.6 → 174.0            | 97.3 → 82.8                         |
| 74 independent views, 1 shared table, 2 ms latency            | 309 → 25               | 815.3 → 114.0             | 78.9 → 78.6                         |
| 1 table, 1 constraint/index, no latency                       | 13 → 13                | 8.2 → 13.1                | 73.7 → 71.8                         |
| 20 tables, 8 constraints/indexes, depth-4 views, no latency   | 397 → 45               | 38.8 → 83.6               | 80.9 → 88.6                         |
| 20 tables, 8 constraints/indexes, depth-4 views, 2 ms latency | 397 → 45               | 1028.1 → 150.3            | 81.9 → 83.6                         |
| 4 tables, 40 constraints/indexes, depth-2 views, 2 ms latency | 225 → 37               | 593.1 → 120.6             | 79.7 → 81.7                         |

The 74-table case uses 95.8% fewer executions (889 → 37). View-category queries
in the wide-view case drop 95.9% (296 → 12); its total also includes the base table
and database version. All six source metadata hashes match the pre-change baseline
when excluding `extractedAt`. A one-table/one-index extraction remains 13 queries.

## Reproduction and limits

Run `npm run benchmark:extraction` for sizes 1, 16, 32 and 64; append `-- 32` to
measure only the default size. Each workload/size runs in a fresh Node process.
The runner asserts identical hashes across sizes. Size 1 now disables both
cross-object batching and member batching; it is **not** the old default baseline.
The recorded before measurements were captured before changing catalog code.

Query counts measure `execute` calls, excluding driver fetch/network round trips.
Each synthetic execute optionally waits 2 ms; fetching has no simulated latency.
The mock expands bound selections into fixture rows, which adds CPU work that
is not an Oracle query-plan measurement. RSS includes the runtime, driver, fixtures
and complete source model; batching limits query selections and temporary staging,
not total model size. These single observations are noisy and show no universal
latency or memory improvement, especially with zero transport latency.

Deep view chains must discover each next view and cannot collapse into a single
batch. Shared/wide pending sets can batch. No parallel queries or pooling are used.
Live ALL/DBA tests separately check real SQL execution and full artifact parity.
Actual remote speed depends on catalog plans, privileges, metadata and latency;
these are not production speed guarantees or a reproduction of the user's 907-query
run. No credentials, raw SQL values, or remote identifiers are recorded here.

## Correctness checks

All 24 workload/size combinations completed with matching source hashes. The
419-test offline suite, typecheck and build passed. Seven live Oracle integration
tests passed, including ALL/DBA source, transformed-document and generated-SQL
parity; the existing opt-in remote-clone scenario was skipped.
