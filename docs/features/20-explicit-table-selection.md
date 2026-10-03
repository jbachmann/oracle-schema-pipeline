# Feature: Explicit table selection without FK expansion

- Status: Implemented and verified
- Date: 2026-10-01
- Request: Extract only explicitly listed tables, retaining foreign keys only
  between those tables and reporting excluded foreign keys.

## Context and Scope

Given an object selection, extraction must capture exactly the unique tables in
its `tables` list. An outgoing FK must never add a table. Retain an FK if and only
if its parent table is also explicitly selected; self-references qualify.

The requester approved all three recommendations on 2026-10-01:

1. Treat the table list as a strict allowlist, including for selected views.
   Reject a view that needs an unlisted local table with an actionable error.
2. Remove out-of-selection FK definitions during extraction, including from
   `source.json`, and record every omission in diagnostics and the later report.
3. Introduce a new artifact format version and require re-extraction of old
   source/target documents. Do not silently preserve old one-hop behavior.

Affected stages: extraction and its selection contract, transformation reporting,
semantic validation, and generation's independent validation gate. Dictionary
output and clone/retry consumers also observe the new artifact contract.

Recursive discovery of local dependent views remains supported. Only table
discovery changes. No legacy selection mode, automatic artifact migration, row
copying, SQL rewriting, or expansion of supported Oracle object types is included.

### Oracle example

```sql
CREATE TABLE APP.C (ID NUMBER PRIMARY KEY);
CREATE TABLE APP.B (
  ID NUMBER PRIMARY KEY,
  C_ID NUMBER REFERENCES APP.C (ID)
);
CREATE TABLE APP.A (
  ID NUMBER PRIMARY KEY,
  B_ID NUMBER REFERENCES APP.B (ID)
);
CREATE VIEW APP.V AS SELECT ID FROM APP.B;
```

Selecting A alone produces only A, without its FK to B, plus one omission
diagnostic. Selecting A and B produces exactly A and B, retains A's FK to B,
and omits/reports B's FK to C. Selecting V and A fails because B is not listed;
selecting V, A, and B succeeds. SQL never creates C in these successful cases.

## Research Findings

Verified from repository code on 2026-10-01:

- `src/extract.ts` currently calls `prefetchForeignKeys`/`foreignKeys` for selected
  tables, unions direct parents with selected tables and view base tables, and
  assigns `target`, `direct-parent`, or `view-dependency` roles.
- `src/catalog-constraints.ts` assembles complete FK definitions, including
  referenced constraint columns. Both on-demand and batched table reads perform
  these metadata reads. Stopping table expansion does not eliminate all catalog
  reads concerning an unselected parent.
- `src/transform.ts` currently removes FKs originating in non-target tables and
  records `OMIT_PARENT_FK`. It preserves source diagnostics and includes change
  diagnostics in `transformationReport`.
- `src/semantic.ts` independently authorizes direct FK parents and tables reached
  through views. Merely changing extraction would leave crafted target artifacts
  able to authorize extra tables.
- `src/validate.ts` checks referenced tables and ordered candidate keys and rejects
  parent-only FKs. `src/generate.ts` independently validates before rendering.
- `src/model.ts` accepts only document format 5. Selection version 2, policy
  version 1, and completion-manifest version 1 are separate contracts.
- `test/pipeline.test.ts`, `test/extract.test.ts`, fixtures, examples, README,
  and Oracle integration expectations explicitly encode the old closure rules.
- ADRs 0001 and 0003 authorize one-hop/table dependency expansion. ADR 0007
  preserves those rules while adding batching. ADR 0006 requires independent
  destination checks beyond exporter round-trip equality.

Design inference: filtering complete table definitions at the extraction boundary
is the smallest implementation that meets the approved artifact behavior while
preserving strict catalog decoding and existing batching. This plan does not
promise successful extraction when the catalog hides metadata needed to decode
an outgoing FK, even if that FK would ultimately be excluded.

No new Oracle or dependency behavior is assumed; these findings are established
locally. No external documentation was needed for this plan.

## Decisions and Boundaries

- Membership uses exact `(owner, name)` identity via `objectKey`; no case folding,
  name-only comparison, or identifier normalization. Duplicate selection entries
  are deduplicated using existing deterministic reference ordering.
- All extracted tables have role `target`. Table definitions, table prerequisites,
  and table prefetch requests are limited to the explicit selection.
- Metadata lookup of a referenced constraint is permitted; extraction of the
  referenced table definition is not. Keep strict catalog decoding, including
  `CATALOG_INCOMPLETE_METADATA`, `CATALOG_UNKNOWN_VALUE`, and
  `CATALOG_CARDINALITY`. Do not catch catalog failures and label them omissions.
- Unsupported properties on an excluded parent table cannot block extraction
  through a table-definition read, because that table is never read. Unsupported
  or incomplete metadata actually read for selected objects retains existing
  failure behavior.
- A missing local TABLE dependency of any reachable view fails extraction before
  publishing an artifact. Tell the operator which view requires which table and
  to add that exact owner/name to the selection. Never drop a view dependency or
  rewrite its SQL. Remote and unsupported dependencies retain existing rejection
  behavior; never follow a database link.
- No change to source read-only access, destination orchestration authority,
  credential handling, offline later stages, or exclusive artifact publication.

## Proposed Design

### Contract and compatibility

In `src/model.ts`, change source and target `formatVersion` from 5 to 6 and update
the schema error to require re-extraction. Narrow `table.role` to literal `target`.
Other table, column, index, constraint, view, prerequisite, and diagnostic field
shapes remain unchanged. `targetTables` remains the unique explicit selection;
`tables` must contain exactly those identities. `targetViews` remains the explicit
view roots; dependent views retain role `dependency`.

Keep selection version 2, existing legacy table-list CLI parsing, policy version 1,
progress version 1, and completion-manifest version 1 unchanged. The new selection
semantics apply to every supported selection input, not only a file literally
named `objects.json`.

Reject v5 and earlier source/target documents at every existing schema boundary,
including dictionary generation and clone retry. Do not relabel old JSON or remove
extra tables as an automatic migration. Previously generated SQL is not rewritten;
operators must re-extract and regenerate to obtain the new behavior.

### Extraction and reporting

In `src/extract.ts`:

1. Build the deduplicated explicit table list and identity set.
2. Walk selected views and recursive local view dependencies as today. On each
   local TABLE edge, require membership in the explicit table set. Do not add
   view base tables to extraction requests.
3. Remove FK-parent discovery from the extraction flow. Do not invoke the
   foreign-key discovery prefetch or lookup methods to determine table scope.
4. Prefetch/read only the explicit table list. Filter each returned table's
   constraints into a new table object, preserving all non-FKs and all FKs whose
   parent is in that same explicit set. Do not mutate catalog-owned definitions.
5. Record one `change` diagnostic with code `OMIT_UNSELECTED_FK` per excluded FK.
   Use the existing qualified-table/constraint object convention and a message
   naming the qualified parent and explaining that it is not explicitly selected.
   Preserve deterministic table/constraint order. Publish diagnostics in the v6
   source document, without retaining omitted FK definitions in another field.

Keep catalog FK lookup APIs and their unit coverage unless a separate cleanup is
needed to compile; this feature need not remove usable catalog capabilities.
Existing strict assembly and bounded member batching remain intact.

Use a coded extraction error `UNSELECTED_VIEW_TABLE` for the view/table selection
failure. Include actionable object context in normal CLI errors; add the stable
code to `src/progress.ts`'s safe error-code allowlist without exposing arbitrary
messages or catalog values in progress events. Extraction exits 1 and publishes
no source or dictionary artifact on this failure.

### Offline stages and independent enforcement

In `src/transform.ts`, remove the parent-origin FK omission policy. Preserve source
constraints and the new omission diagnostics without mutating source input;
continue storage-policy and index-grant reporting. Each omission appears once in
the transformation report. Transformation must not silently repair an authored
v6 artifact containing an out-of-selection FK.

In `src/semantic.ts`, expected tables are exactly `targetTables`. Remove FK and
view-table expansion from expected-table computation while retaining recursive
view reachability and ordering. Preserve `EXTRA_TABLE`, `MISSING_TARGET`, and
existing view dependency validation. An authored target cannot authorize an extra
table by adding a view edge or FK.

In `src/validate.ts`, replace the obsolete parent-only FK rule with an explicit
parent-membership check: `FK_OUTSIDE_SELECTION` is a blocking error whenever an
FK parent is absent from `targetTables`, including when an extra parent definition
is present. Keep `MISSING_PARENT` and ordered `MISSING_PARENT_KEY` checks for
retained relationships. An unselected modeled view base table must still trigger
`EXTRA_TABLE`; an absent one triggers `MISSING_VIEW_DEPENDENCY`.

Generation continues to revalidate independently. No SQL renderer change is
expected beyond fixtures: only retained FKs and their required REFERENCES grants
are emitted. Dictionary constraints reflect the filtered source definitions.

### Required ADR

Add ADR 0009 (verify the next available ADR number at implementation time) to
supersede ADR 0001's one-hop scope and complete-FK source-fact assumptions and
ADR 0003's automatic view-table inclusion and table-role precedence. Document the
v6 contract and intentional omissions at extraction, with their audit record.
Update ADR 0007's current selection description and link to the new decision.
All remaining architectural and security invariants stay in force.

## Implementation Plan

1. Add the superseding ADR and update `src/model.ts`'s format and table-role
   contract. Update fixture builders in `test/fixtures.ts` and
   `test/preparation-fixtures.ts` so intended internal FK endpoints are explicitly
   selected, rather than deleting useful FK coverage.
2. Implement extraction scope, immutable filtering, omission diagnostics, and the
   coded view failure in `src/extract.ts`; wire safe progress reporting through
   `src/progress.ts` and verify `src/cli.ts` error/publication behavior.
3. Update `src/transform.ts`, `src/semantic.ts`, and `src/validate.ts` together so
   extraction output succeeds and hand-authored violations fail generation.
4. Update unit and CLI coverage listed below, including all version-dependent
   consumers and batching expectations. Check `scripts/clone-retry-input.ts` and
   `scripts/clone-workflow.ts` use the new contract before destination operations.
5. Add partial-selection Oracle coverage in
   `test/integration/oracle-roundtrip.test.ts` and independent destination
   assertions in `test/integration/independent-facts.ts`. Adjust seeded fixtures
   in `test/docker/oracle/source-init/01-seed.sql` only if existing relationships
   cannot cover the cases. Preserve the explicit test Compose boundary.
6. Update README selection, view, compatibility, and diagnostic descriptions.
   Refresh `examples/source.json`, `examples/target.json`,
   `examples/target.json.report.json`, `examples/clone.sql`, and
   `examples/data-dictionary.xlsx` consistently with `examples/tables.json`.
   Generate replacements into fresh temporary paths before deliberately updating
   checked-in examples; do not weaken runtime no-overwrite behavior.
7. Update benchmark helper assertions in `test/helpers/benchmark-catalog.ts` and
   `test/scripts/benchmark-extraction.ts` if they assume FK expansion. Preserve
   historical benchmark reports as historical measurements, not new guarantees.
   Run the validation commands below and record actual results.

## Test Plan

- `test/extract.test.ts` and `test/pipeline.test.ts`: A alone; A+B in A→B→C;
  all three explicitly selected; self-FK; cycles; cross-owner/composite FKs;
  quoted identifiers and equal names in different owners; duplicate selections;
  no incoming-child discovery. Assert exact table reads, no parent discovery
  calls, omission counts, unchanged catalog objects, and no external FK in source,
  target, or SQL. Preserve local columns, checks, indexes, and other metadata.
- View tests: direct and transitive view dependencies requiring unlisted tables
  fail with the exact error code and useful message; adding the table succeeds;
  view-only selection succeeds when it has no local table dependency. Preserve
  view cycle, remote-edge, unsupported-edge, and deterministic-order coverage.
- `test/model.test.ts`, `test/validate.test.ts`, `test/pipeline.test.ts`: reject
  old versions and old roles; reject extra tables introduced by FK or view edges,
  missing explicit tables, and external FKs even with an extra parent definition.
  Direct generation must reject the same cases without prior validation.
- `test/catalog-cross-object.test.ts`, `test/catalog-batching.test.ts`, and
  `test/catalog.test.ts`: batch sizes 1 and 32 produce identical v6 semantics;
  strict decoding and rollback remain intact. Outgoing excluded FK metadata
  corruption remains an explicit catalog failure, not a silent omission.
- `test/progress-cli.test.ts`, `test/publication-cli.test.ts`, and
  `test/dictionary.test.ts`: safe error code, no publication on view-selection
  failure, report propagation without duplicate omissions, and workbook exclusion
  of omitted definitions. Retain non-overwrite and secret-exclusion checks.
- `test/clone-retry-input.test.ts` and clone workflow coverage: old artifacts are
  rejected before replay/reset; regenerated v6 artifacts pass existing gates.
- Oracle round-trip: exercise partial and complete selections with ALL and DBA
  catalog scope. Query destination catalogs independently for exact table and FK
  sets and retained ordered keys/grants. Verify excluded tables/FKs are absent;
  do not rely only on re-extraction equality. Retain restricted-reader failures
  where parent identity/key metadata is hidden; successful omission must not be
  confused with bypassing catalog visibility requirements.

Commands verified against `package.json` (to run during implementation):

```sh
npm run typecheck
npm run build
npm test
npm run test:integration
```

Integration requires the seeded Docker test environment described in README.
This planning task does not provision or reset any database.

## Acceptance Criteria

- [x] Successful extraction contains exactly the unique explicitly selected tables.
- [x] No FK or view path causes an unlisted table definition to be read or included.
- [x] Only FKs between selected tables survive, with exact states and column order.
- [x] Every excluded FK has one stable source diagnostic and report entry.
- [x] Missing view base-table selections fail with `UNSELECTED_VIEW_TABLE` and
      instructions to add the required identity, before artifact publication.
- [x] Transform preserves source input; validation and direct generation reject
      authored artifacts that violate explicit selection.
- [x] V5 and older documents require re-extraction; v6 roles and consumers agree.
- [x] Unit, CLI, batching parity, and independent Oracle checks cover the new rules.
- [x] Deterministic ordering, source read-only access, offline later stages,
      no-overwrite publication, and secret exclusion remain intact.
- [x] README, examples, and a superseding ADR explain the changed behavior.

## Risks and Open Questions

No unresolved scope decisions remain. Implementation, offline verification, and
live Oracle verification are complete.

Compatibility is deliberately breaking: view selections may need additional
explicit tables, and old artifact bundles cannot be reused through supported
consumers. Dictionary output no longer contains excluded FK definitions; the
omission diagnostic is the retained audit record.

Catalog assembly still reads referenced-key metadata for excluded FKs. Hidden or
malformed metadata can therefore fail extraction. Avoiding those reads would be
a separate catalog design change, outside this smallest approved implementation.

Many fixtures rely on implicit parent inclusion. Updating them must preserve
positive FK/key/grant coverage by selecting both endpoints explicitly. Existing
full-schema integration tests alone cannot demonstrate the new partial-selection
behavior, so the new independent assertions are required.


## Implementation and validation results (2026-10-01)

Implemented the format-v6 contract, explicit extraction allowlist and FK filtering,
view selection error and safe progress code, independent offline enforcement, and
the format-v6 clone SQL replay guard. Added ADR 0009 and updated README and
supersession links. Synthetic examples were re-extracted through the new extractor
into fresh temporary paths, then their target, report, SQL and workbook were
regenerated and deliberately copied into the checked-in example bundle.

Positive FK fixtures explicitly select both endpoints. New tests cover chains,
cycles, self-FKs, exact identities, immutable catalog objects, strict excluded-FK
metadata decoding, view errors, safe CLI failure without publication, authored
violations, dictionary omission audit rows, and v5 rejection including clone retry.
Independent Oracle cases cover partial/full chains and partial cross-owner
composite keys and REFERENCES grants for both ALL and DBA scope. Existing seeded
relationships suffice; no seed DDL change was needed.

Benchmark helpers already explicitly select the base tables their views require;
no helper behavior change was necessary. Updated batching test selections while
preserving historical benchmark reports and query-count assertions.

Validation:

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm test`: passed, 436 tests.
- `git diff --check`: passed.
- `ORACLE_INTEGRATION_USE_EXISTING=1 npm run test:integration`: passed, 9 tests;
  the opt-in remote-source/local-clone orchestration case was skipped. The suite
  used the explicit test Compose project, initially started by
  `npm run test:integration` after Docker became available.
  Both ALL and DBA partial-selection cases passed independent destination checks
  for exact tables and FKs, composite key order, and REFERENCES grants.
  The restricted-reader test now verifies both the early
  `UNSELECTED_VIEW_TABLE` error and strict hidden-metadata failure when the base
  table is explicitly selected. Typecheck and build passed again after this
  integration expectation update.
