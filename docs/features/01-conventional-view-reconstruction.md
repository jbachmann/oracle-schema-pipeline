# Feature: Conventional View Reconstruction

- Status: Implemented
- Date: 2026-09-23
- Request: Explicitly select conventional Oracle views, recursively include their
  local table/view dependencies, and reconstruct them after all table DDL.

## Context and Scope

The pipeline currently accepts table references only. It already extracts every
non-LOB index belonging to an included table, validates supported index forms,
generates each index once, and compares indexes during the Oracle round trip.
No index implementation change is required by this feature.

Add explicit view roots to extraction. For each requested view, recursively follow
local `TABLE` and `VIEW` dependencies. Include required base-table definitions and
dependent view definitions even when they were not explicitly listed. Preserve the
existing one-hop FK behavior for explicitly selected tables. A table reached only
through a view does not expand the FK graph; its outgoing FK is omitted like a
parent-only table unless that table was also explicitly selected.

Supported scope is valid, conventional relational views. Materialized, editioning,
object, XMLType, container-data, remote, and Oracle-maintained views are excluded.
Triggers, synonyms, PL/SQL, user-defined types, sequences, and other non-table/view
dependencies are not recursively imported. Remote or unsupported dependencies
produce blocking diagnostics.

## Research Findings

### Repository

- `src/catalog.ts` already reads indexes from `DBA_INDEXES`,
  `DBA_IND_COLUMNS`, and `DBA_IND_EXPRESSIONS` for every included table.
- `src/extract.ts` discovers one-hop FK parents from explicit table roots. Its
  `SourceCatalog` abstraction is the correct seam for view discovery tests.
- `src/model.ts` has a strict `formatVersion: 1` contract containing only
  `targetTables` and `tables`. View support requires a new document version.
- `src/generate.ts` currently ends with retained FKs. Views can be added as a
  later phase without disturbing current table/index behavior.
- `docker/oracle/source-init/01-seed.sql` contains 98 tables and a small set of
  explicit indexes, but no views. `test/integration/oracle-roundtrip.test.ts`
  selects all 98 tables and compares table structures and indexes only.

### Oracle

- `DBA_VIEWS.TEXT` is a `LONG` containing full view text; `TEXT_VC` may truncate.
  `BEQUEATH` is a separate field and is not included in `TEXT`. Use `TEXT`,
  matching the existing full-`LONG` policy for defaults and check expressions.
- `DBA_VIEWS` also exposes read-only, typed/superview, container-data, bequeath,
  and collation facts needed to distinguish the supported subset.
- `DBA_DEPENDENCIES` exposes referenced owner, name, type, and database-link data
  for dependency traversal.
- A view owner needs direct privileges on referenced cross-schema objects; role
  privileges are insufficient. Generated `SELECT` grants must therefore precede
  creation of a cross-schema dependent view.
- Oracle supports view-on-view definitions, read-only/check-option restrictions,
  invoker/definer bequeath behavior, and specialized view types. These facts must
  be represented or explicitly rejected rather than silently lost.

Primary sources, accessed 2026-09-23:

- [Oracle `ALL_VIEWS`/`DBA_VIEWS` reference](https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/ALL_VIEWS.html)
- [Oracle `DBA_DEPENDENCIES` reference](https://docs.oracle.com/en/database/oracle/oracle-database/23/refrn/DBA_DEPENDENCIES.html)
- [Oracle `CREATE VIEW` reference](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/CREATE-VIEW.html)
- [Oracle `ALL_OBJECTS` status and edition metadata](https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/ALL_OBJECTS_AE.html)

## Decisions and Boundaries

- Input views are explicit roots; dependencies are automatic.
- Dependency traversal is transitive for local views and terminates at local
  tables. Deduplicate by exact `[owner, name, type]` identity.
- Remote dependencies and local dependency types other than `TABLE` or `VIEW`
  block generation. Do not accept them through `externalPrerequisites` for this
  feature because the requested boundary is fail-closed.
- Generate all tables, indexes, local constraints, grants, and FKs before views.
  Then topologically order views by view-on-view dependencies. Emit required
  cross-schema `SELECT` grants immediately before the first dependent view that
  needs them. Cycles block generation; do not use `CREATE FORCE VIEW` to mask them.
- Preserve conventional view query text as trusted Oracle SQL. The existing warning
  that model expressions are executable input must be expanded to view text.
- Existing index extraction and generation remain unchanged. Add regression
  assertions proving view work does not duplicate or reorder indexes.
- Create ADR 0002 because ADR 0001 explicitly excludes views and defines selection
  as table-focused and one-hop. ADR 0002 should extend, not replace, read-only
  extraction, offline stages, deterministic output, and fail-closed generation.

## Proposed Design

### Input and compatibility

Replace the table-array input with a versioned selection object:

```json
{
  "version": 2,
  "tables": [{ "owner": "APP", "name": "ORDERS" }],
  "views": [{ "owner": "REPORTING", "name": "OPEN_ORDERS" }]
}
```

Require at least one combined table/view root. Use the versioned selection object through `--objects`; the former table-array input and `--tables` option are removed.

Use `formatVersion: 2` source and target schemas exclusively. Earlier artifacts must be re-extracted.

V2 adds:

- `targetViews: ObjectReference[]`: explicit view roots.
- `views: ViewDefinition[]`: explicit and recursively discovered views.
- Table role `view-dependency`, with `target` taking precedence when a table is
  both explicitly selected and reached through a view.
- `ViewDefinition`: `reference`, `role` (`target` or `dependency`), ordered column
  names, full `query`, `readOnly`, `bequeath`, object `status`, relevant collation/
  edition facts, typed/superview/container flags, `dependencies`, and
  `unsupportedFeatures`.
- A dependency record containing exact reference, `TABLE | VIEW` type, and
  referenced database-link name when present.

Before finalizing the schema, add a focused Oracle fixture to verify exactly how
`DBA_VIEWS.TEXT` represents `WITH CHECK OPTION`, explicit column aliases, and
trailing syntax. If a clause is not present in `TEXT`, model it explicitly from
the relevant dictionary view. Never infer it by parsing arbitrary SQL.

### Extraction

Extend `SourceCatalog` and `OracleCatalog` with object classification,
`view(reference)`, and `viewDependencies(reference)`. Query `DBA_VIEWS.TEXT`
directly and join `DBA_OBJECTS` for validity/edition metadata. Reject missing,
inaccessible, specialized, invalid, or Oracle-maintained roots explicitly.

In `extractSource`, use a deterministic queue and visited set for requested views.
For each dependency:

1. Reject a non-null database link.
2. Enqueue a local `VIEW` dependency.
3. Add a local `TABLE` to the table-definition set.
4. Record any other type as a blocking prerequisite diagnostic.

After closure, apply current FK discovery only to explicitly selected table roots.
Fetch table definitions once for the union of explicit tables, their direct FK
parents, and view-required tables. Sort serialized objects and dependencies by
stable object identity.

### Transformation and validation

Carry view definitions through transformation unchanged except for explicit
policy diagnostics. Remove outgoing FKs from view-dependency tables unless they
are explicit table targets.

Validation must detect missing/extra dependencies, duplicate object identities,
unsupported view metadata, invalid status, remote/non-table dependencies,
dependency cycles, unsafe query absence, and role mismatches. Confirm every view's
local table/view dependency exists in the target model. Confirm deterministic
topological ordering using qualified identity as the tie-breaker.

Use stable diagnostic codes, including `MISSING_VIEW_DEPENDENCY`,
`REMOTE_VIEW_DEPENDENCY`, `UNSUPPORTED_VIEW_DEPENDENCY`, `UNSUPPORTED_VIEW`,
`INVALID_VIEW`, and `VIEW_DEPENDENCY_CYCLE`.

### Generation

Add a final phase after retained foreign keys:

1. Topologically sort views.
2. Emit deduplicated `GRANT SELECT ON <object> TO <view-owner>` statements for
   cross-schema table/view dependencies after the referenced object exists.
3. Emit qualified `CREATE VIEW` statements with an explicit ordered column list,
   supported bequeath/read-only/check-option clauses, and preserved query text.
4. Keep the SQL*Plus line-length gate. Long view queries that exceed the existing
   conservative line policy must fail with a specific diagnostic until a reviewed
   multiline rendering policy is implemented.

Do not use `OR REPLACE`, `FORCE`, or source DDL replay.

## Implementation Plan

1. Add ADR 0002 and update `README.md` scope, examples, credentials, dependency
   behavior, trusted SQL warning, generation order, and supported subset.
2. Add version 2 selection, document, and view schemas in `src/model.ts`.
3. Extend `src/catalog.ts` with full view text, metadata, and dependency queries;
   add mocked `LONG`, specialized-view, remote, and non-table cases to
   `test/catalog.test.ts`.
4. Implement deterministic recursive dependency closure in `src/extract.ts` and
   expand `test/fixtures.ts` and `test/pipeline.test.ts` for chains, diamonds,
   deduplication, mixed explicit roots, and cycles.
5. Update `src/transform.ts` for view-dependency table roles and reports.
6. Update `src/validate.ts` with view semantics, closure checks, stable diagnostics,
   and deterministic topological sorting. Prefer a shared pure graph helper used by
   validation and generation.
7. Update `src/generate.ts` with cross-schema `SELECT` grants and the final view
   phase. Preserve current table/index/FK ordering.
8. Update `src/cli.ts`, examples, and CLI tests for `--objects`,
   mixed roots, and non-overwriting output.
9. Expand `docker/oracle/source-init/01-seed.sql` substantially: add conventional
   views in multiple schemas, view-on-view chains, a diamond dependency graph,
   joins, expressions/aliases, same-schema and cross-schema dependencies,
   `BEQUEATH`, read-only/check-option behavior, quoted identifiers, and long query
   text. Add required direct source grants. Keep unsupported cases in isolated
   tests so the successful seed remains replayable.
10. Extend `test/integration/oracle-roundtrip.test.ts` to request explicit view
    roots, prove recursive dependency inclusion, compare normalized source and
    destination view definitions/columns/metadata/dependency edges, query selected
    destination views, verify every reconstructed object is `VALID`, and assert
    the more complex seed's exact table/view/index counts. Retain index equality
    and add ordering assertions that every view follows all table/index/FK DDL.
11. Run `npm run typecheck`, `npm test`, `npm run build`, and
    `npm run test:integration`.

## Test Plan

- Unit: selection parsing, version rejection, graph closure, deterministic order,
  duplicate roots, mixed roles, view-on-view chains/diamonds, and cycles.
- Catalog: full `LONG` text, separate `BEQUEATH`, ordered aliases, validity,
  supported flags, remote links, and unsupported dependency types.
- Validation: missing nodes, invalid/specialized views, remote/non-table edges,
  cycles, role mismatches, and repeated stable diagnostics.
- Generation: final-phase ordering, cross-schema grants, grant deduplication,
  quoting, trusted query preservation, read-only/check-option behavior, and no
  regression in existing index creation.
- Integration: enhanced multi-schema seed and extract-transform-validate-generate-
  replay comparison for tables, indexes, FKs, views, dependencies, validity, and
  executable view queries.

## Acceptance Criteria

- [ ] An explicit conventional view is reconstructed with equivalent query,
      columns, supported attributes, and exact identifier spelling.
- [ ] Local transitive view and table dependencies are included exactly once.
- [ ] Remote and non-table/view dependencies block SQL with stable diagnostics.
- [ ] Views are emitted only after all table, index, constraint, grant, and FK DDL.
- [ ] View-on-view ordering is deterministic; cycles block generation.
- [ ] Required cross-schema `SELECT` grants precede dependent view creation.
- [ ] Table-only version 2 selections continue to work.
- [ ] Existing index extraction, validation, ordering, and round-trip equality do
      not change.
- [ ] Expanded seed data exercises realistic multi-schema view graphs.
- [ ] Integration tests compare reconstructed views and successfully query them.
- [ ] Unsupported view forms never produce approximate SQL.
- [ ] Source access remains read-only; all later stages remain offline.

## Risks and Open Questions

- Oracle dictionary representation of check-option syntax and explicit view
  aliases needs the planned live fixture before the final v2 field set is frozen.
- Existing SQL*Plus line limits may reject legitimate long view definitions. This
  plan deliberately fails closed rather than introducing unreviewed wrapping.
- `DBA_DEPENDENCIES` accuracy depends on valid compiled source views. Invalid views
  are therefore rejected instead of traversed heuristically.
- Cross-schema view creation depends on direct grants and destination execution
  privileges; integration coverage must prove both.
