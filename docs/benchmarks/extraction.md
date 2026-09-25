# Extraction benchmark, 2026-09-24

Synthetic measurements on Node v24.11.1, macOS x64. Raw observations are in
[extraction-2026-09-24.json](extraction-2026-09-24.json). The initial baseline was
collected before batching was implemented. Its query counts and metadata hashes
match the later batch-size-1 reference runs.

Reproduce with `npm run benchmark:extraction`. Each workload/size runs in a fresh
Node process. Timing covers catalog construction and full extraction, excluding
process startup. Queries count `execute` calls, not internal driver fetch/network
round trips. Simulated latency is a timer on each execute; there is no simulated
fetch latency. RSS includes Node, driver loading, fixtures, and metadata, not just
batch allocations. `peakRssBytes` samples RSS at query boundaries;
`peakProcessRssBytes` uses the OS process high-water mark. The initial, pre-batching
baseline used one process and only sampled RSS, so its memory figures accumulate
across workloads and should not be compared as isolated peaks.

Fixtures vary table count, constraints and indexes per table, recursive view depth,
two owners (including a quoted owner), and 0/2 ms query latency. Unit and live tests
cover FK visibility, one-hop traversal, full LONGs, and rejection behavior separately.
These synthetic unique constraints are for measuring catalog reads, not replaying DDL.

## Isolated before/after observations (batch sizes 1 and 32)

| Tables | Constraints/indexes per table | View depth | Latency ms | Queries before → after | Elapsed ms before → after | Peak process RSS MiB before → after |
| ------ | ----------------------------- | ---------- | ---------- | ---------------------- | ------------------------- | ----------------------------------- |
| 1      | 1 / 1                         | 0          | 0          | 12 → 12                | 12.9 → 8.2                | 85.7 → 71.5                         |
| 20     | 8 / 8                         | 4          | 0          | 657 → 237              | 34.9 → 36.1               | 78.8 → 81.6                         |
| 20     | 8 / 8                         | 4          | 2          | 657 → 237              | 1727.4 → 620.0            | 75.9 → 79.9                         |
| 4      | 40 / 40                       | 2          | 2          | 521 → 65               | 1365.9 → 188.1            | 79.3 → 79.0                         |

All metadata hashes match after excluding `extractedAt`. Single observations are
noisy: there is no demonstrated benefit without latency, nor evidence of reduced
memory. Do not interpret these values as Oracle production speedups or capacity
limits. Repeat measurements with representative metadata and real network latency
before setting operational budgets.

## Batch-size choice

For the 40-member fixture, sizes 16/32/64 issued 77/65/53 queries, took
216.5/188.1/166.2 ms, and peaked at 79.8/79.0/78.5 MiB respectively. Choose 32 as a
conservative default: it captures most measured query savings while limiting each
predicate to 64 scalar binds. Size 64 saves another 12 queries in this fixture but
has not been established as a universal optimum. The internal constructor accepts
1–128 for measurement; there is no public CLI tuning flag. Total model memory and
individual LONG values remain unbounded by batch size, as before. Workbook
streaming and connection concurrency are outside this change.
