# Cross-object catalog batching

- Status: Implemented
- Date: 2026-09-28

## Summary and user outcome

Batch Oracle metadata across selected tables, indexes and discovered views so
remote extraction needs substantially fewer executions without changing metadata.
A reported run used 907 queries for 74 objects. The fresh reproducible baseline
uses 889 queries for 74 tables with one constraint and one index each.

## Oracle example

```sql
CREATE TABLE APP.T0 (VALUE NUMBER, CONSTRAINT T0_PK PRIMARY KEY (VALUE));
CREATE TABLE APP.T1 (VALUE NUMBER, CONSTRAINT T1_PK PRIMARY KEY (VALUE));
CREATE VIEW APP.V0 AS SELECT VALUE FROM APP.T0;
CREATE VIEW APP.V1 AS SELECT VALUE FROM APP.T0;
```

Extracting both tables and views produces the same format-5 source definitions,
array order, transformed document and generated SQL as individual reads, except
for the extraction timestamp. Catalog executions are grouped by category.

## Scope and defaults

Only extraction changes. Include table properties/comments, columns/comments,
identities, constraints/constraint columns, indexes/keys/expressions/dependencies,
prerequisites, and view definitions/columns/restrictions/dependencies.

Keep one sequential connection, default batch size 32 and internal range 1–128.
No public tuning flag, parallel connections, fetch-size tuning, schema-wide scans,
model migration or dependency-query consolidation. Full metadata/model memory
still grows with the selection. A deep one-view-at-a-time chain remains incremental.

## Implementation and data flow

1. Share SQL definitions between on-demand reads and cross-object prefetch in
   `src/catalog-queries.ts`. Grouped reads join a bound-only selection CTE at an
   explicit outer join slot, retain every existing predicate, and add grouping
   owner/name columns. Index-dependency selection also binds each index's actual
   table owner/name. No identifiers or values are interpolated into SQL.
2. Add optional `SourceCatalog.prefetchForeignKeys`, `prefetchTables` and
   `prefetchViews` methods. Each accepts `ObjectReference[]`, returns
   `Promise<void>`, and retains the catalog receiver. Custom catalogs without
   hooks retain their existing single-object behavior.
3. Prefetch pending unvisited views without changing the sorted traversal queue.
   Cache prepared references during traversal to avoid duplicate prefetches.
   Retain cycles, remote-edge exclusion and original output order.
4. Prefetch explicit targets' constraints and their FK parent constraint columns;
   discover only direct FK parents. Prefetch the deduplicated union of targets,
   parents and view-dependent tables, preserving role precedence.
5. Prepare each bounded batch with temporary row/member staging, assemble and
   validate all its definitions, then publish complete definitions. Discard raw
   staging on success or failure, consume prepared definitions on first use, and
   roll back constraint-cache additions when that assembly batch fails. Earlier
   complete batches remain usable. Empty optional groups are cached explicitly.
6. Keep prerequisite and index-dependency reads separate because their filtering
   and null-owner semantics differ. Keep full LONG reads, result paging/closure,
   ALL/DBA scope and sequential queries.

## Contract, progress and failures

No JSON fields or format versions change. Progress remains version 1 with existing
query categories, one event pair per actual execution, and no `object` on grouped
queries. Prefetch can precede object events; object elapsed times measure assembly
and remaining on-demand work, not all associated database time.

Missing required metadata, duplicate rows, invalid grouping keys, unknown values,
incomplete ordered members and late decoding failures retain existing catalog
error codes and reject extraction. Prefetch may change the first reported invalid
object. No partial failed-batch definitions may be consumed after retry. Generation
still independently validates, output is deterministic and publication never
replaces existing files. No automatic ALL-to-DBA fallback is added.

## Verification and acceptance

- Unit parity at sizes 1 and 32, including counts 0/1/31/32/33/65/74, quoted and
  multi-owner names, duplicate names under different owners and cross-owner indexes.
- Shared FK parents, duplicate selections, role precedence and excluded grandparents;
  wide/deep view graphs, diamonds, cycles and remote edges; fallback catalogs.
- Empty optional groups, missing required rows, duplicates, out-of-batch and malformed
  rows, complete LONG values and late-page failures; closure and sequential reads;
  failed-batch rollback and retention of earlier complete batches.
- Compare source documents excluding time, transformed documents and generated SQL.
  Extend live Oracle parity to ALL and DBA using the explicit test Compose project.
- Require at least 80% fewer executions than the fresh baseline for the 74-table
  fixture, and at least 80% fewer view-category executions for 74 independent views
  sharing one base table. A single-object extraction must add no executions.
- Run `npm run typecheck`, `npm test`, `npm run build`,
  `npm run test:integration`, and `npm run benchmark:extraction`.
- Report executions by category, elapsed time, sampled/process peak memory and
  metadata hashes. Timing is observational, not a production speed guarantee.

See [the measurement report](../benchmarks/cross-object-extraction.md) and
[ADR 0007](../adr/0007-extraction-observability-and-batching.md).

## Invariant check and research

No conflict with ADR 0001. Source reads remain read-only, later stages remain
offline, and orchestration/test writes remain confined to their existing boundaries.
No new source grants are required. The precise reported 907-query run cannot be
reconciled without its progress-category breakdown.

Oracle's [SELECT reference](https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/SELECT.html)
and [LONG restrictions](https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/Data-Types.html)
were consulted on 2026-09-28. Only bound selection values participate in UNION ALL;
LONG metadata stays in the outer catalog SELECT. Live Oracle tests validate these
queries rather than relying solely on synthetic routing.

## Verification result

Typecheck, build and all 419 offline tests passed. The Docker-backed integration
suite passed seven tests, including ALL/DBA source/target/SQL parity and seeded
round-trip reconstruction; its existing opt-in remote-clone scenario was skipped.
All 24 workload/batch-size benchmark combinations completed with matching metadata
hashes. The 74-table and wide-view fixtures exceeded both 80% reduction targets.
