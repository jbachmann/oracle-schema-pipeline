# Feature: Clone Table and Column Comments

- Status: Implemented
- Date: 2026-09-24
- Request: Capture comments on included source tables and columns and recreate
  them on the destination during cloning.

## Context and Scope

The source fixture already assigns a comment to every seeded table and column,
but the catalog adapter, version 2 model, and generator discard them. Add native
Oracle table and column comments to the catalog-driven pipeline.

Comments are included for every modeled table, regardless of whether its role is
`target`, `direct-parent`, or `view-dependency`. A column comment follows its
owning included table. Preserve absent comments as `null` and present comments
exactly; do not trim, normalize, synthesize, translate, or apply target policy to
their text.

Schema comments are excluded. Oracle's `COMMENT` statement has no schema/user
target, and the requester explicitly approved dropping that part of the request.
View comments, view-column comments, annotations, application rows, and comments
on other object types are also excluded.

## Research Findings

### Verified repository facts

- `src/catalog.ts` builds `TableDefinition` from `DBA_TABLES` and
  `ColumnDefinition` from `DBA_TAB_COLS`; it does not query either comment view.
- `src/model.ts` defines strict version 2 source and target documents. Tables and
  columns have no comment field, so adding fields without a new version would make
  existing strict artifacts misleadingly share a contract version.
- `src/extract.ts` loads every explicit table, direct FK parent, and table reached
  through a selected view by calling the same `SourceCatalog.table` method.
  Adding comments there therefore covers all included table roles without changing
  selection behavior.
- `src/transform.ts` copies table and column facts structurally. Comments require
  no policy transformation and must pass through unchanged.
- `src/generate.ts` independently validates the target, creates all tables first,
  and currently rejects any generated physical line over 2,400 UTF-8 bytes.
- `docker/oracle/source-init/01-seed.sql` already creates table and column comments
  for all 98 seeded tables. The integration comparison currently omits comments,
  so their loss is undetected.
- ADR 0001 explicitly excludes comments. Supporting them requires a superseding
  ADR rather than silently changing the accepted scope.

### Verified Oracle facts

- `DBA_TAB_COMMENTS` exposes comments for all tables and views. Its `COMMENTS`
  value is nullable and is documented as `VARCHAR2(4000)`.
- `DBA_COL_COMMENTS` exposes comments for columns of all tables and views.
- Oracle `COMMENT ON TABLE` and `COMMENT ON COLUMN` recreate the supported values.
  An apostrophe inside a SQL text literal must be escaped; an empty comment removes
  the stored comment, so model absence must remain distinct from an invented empty
  description.
- Oracle does not support `COMMENT ON SCHEMA` or `COMMENT ON USER`.

Primary sources, accessed 2026-09-24:

- [Oracle `COMMENT` statement](https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/COMMENT.html)
- [Oracle `DBA_TAB_COMMENTS`/`ALL_TAB_COMMENTS` reference](https://docs.oracle.com/en/database/oracle/oracle-database/21/refrn/ALL_TAB_COMMENTS.html)
- [Oracle `DBA_COL_COMMENTS` reference](https://docs.oracle.com/en/database/oracle/oracle-database/23/refrn/DBA_COL_COMMENTS.html)

### Inference

Because comments are source metadata, not a destination policy choice, they belong
on each table/column definition and should survive source-to-target transformation
unchanged. Emitting comment DDL immediately after all table creation makes every
referenced object available while keeping later structural phases unaffected.

## Decisions and Boundaries

- Support native comments on included tables and their modeled user-generated
  columns only.
- Ignore schema comments because Oracle has no corresponding native facility.
- Do not add view comments, annotations, or comments on indexes, constraints, or
  other schema objects.
- Introduce document `formatVersion: 3` and support version 3 exclusively. Version
  2 source and target artifacts must fail runtime parsing and require re-extraction.
  The version 2 selection object remains unchanged because comment capture is not
  a selection concern.
- Represent comment absence explicitly as `null`. Never coerce absence to an empty
  string and never emit removal statements for `null`.
- Preserve comment text exactly, including case, apostrophes, Unicode, whitespace,
  and line breaks. Do not silently truncate or normalize catalog values.
- Generate deterministic `COMMENT` statements ordered by qualified table identity
  and column position. Table comment precedes its column comments.
- Long or multiline comments must use a reviewed, Oracle-tested rendering strategy
  that preserves the exact value while keeping generated physical lines within the
  existing 2,400-byte SQL*Plus safety limit. A PL/SQL `EXECUTE IMMEDIATE` block
  assembled from bounded escaped literal chunks is the preferred design. If a
  value cannot be represented losslessly, validation blocks generation with an
  actionable diagnostic; it must never be dropped.
- Comment catalog rows that are missing, duplicated, refer to a non-modeled column,
  or cannot be decoded losslessly are extraction errors, not warnings.

## Proposed Design

### Version 3 contract

Change the common source/target `formatVersion` literal from `2` to `3`. Add these
required fields:

- `TableDefinition.comment: string | null`
- `ColumnDefinition.comment: string | null`

The fields are required even when `null`, preserving strict shape validation and
making extraction completeness reviewable. Do not create parallel v2 schemas or a
migration path. Update every repository fixture and example to v3. The object
selection schema remains version 2.

### Extraction

In `src/catalog.ts`, read one table comment from `DBA_TAB_COMMENTS` for the exact
owner/table pair and read column comments from `DBA_COL_COMMENTS` for the same
pair. Map comments by exact column name onto the already ordered user-generated
columns from `DBA_TAB_COLS`.

Require exactly one table-comment row and one column-comment row for every modeled
column; Oracle returns rows with `COMMENTS = NULL` when no comment exists. Fail
extraction on missing/duplicate rows or comment rows for unexpected modeled names,
because those conditions indicate inaccessible or inconsistent catalog metadata.
Keep these operations read-only and use bound owner/table values.

`src/extract.ts` then emits `formatVersion: 3`. No graph or role logic changes.

### Transformation and validation

`src/transform.ts` carries comment fields unchanged into the v3 target. Comments
must not create change diagnostics because they are preserved facts.

Add validation of comment renderability before generation. Stable diagnostics:

- `UNRENDERABLE_TABLE_COMMENT`
- `UNRENDERABLE_COLUMN_COMMENT`

Diagnostics identify the qualified table and, for columns, the exact column.
Validation checks the chosen SQL literal/chunk renderer, target character handling,
and the existing physical-line limit. It must not impose a smaller arbitrary text
limit than Oracle's catalog representation.

### Generation

Add a comment phase after all tables are created and before indexes and
constraints. For each non-null table comment emit the equivalent of:

```sql
COMMENT ON TABLE "APP"."ORDERS" IS 'Customer''s orders';
```

For each non-null column comment emit the equivalent of:

```sql
COMMENT ON COLUMN "APP"."ORDERS"."ORDER_ID" IS 'Stable identifier';
```

Centralize comment literal rendering in a small pure helper. Use ordinary quoted
literals when safely below the line limit. For long or multiline values, emit an
Oracle-tested PL/SQL dynamic-DDL block using bounded chunks without changing the
stored text. Quote identifiers through the existing `quoteIdentifier` and
`qualifiedName` helpers. Escape data separately from identifiers. Preserve
`SET DEFINE OFF` so ampersands remain literal.

After replay, extracting the destination must recover byte-for-byte equal comment
strings in the target database character set.

### Architecture and documentation

Add ADR 0002 that supersedes only ADR 0001's explicit comment exclusion and its
format-version statement. Retain every other invariant: catalog-driven read-only
source access, unchanged extracted facts, offline later stages, deterministic
output, independent validation, fail-closed generation, secret handling, and
non-overwriting files.

Update `README.md` to describe v3, comment coverage, exclusions, catalog views,
generation order, and the requirement to re-extract v2 artifacts.

## Implementation Plan

1. Add `docs/adr/0002-preserve-table-column-comments.md`, documenting the narrow
   supersession of ADR 0001 and the v2-to-v3 compatibility break.
2. Update `src/model.ts`: require v3 documents and nullable `comment` fields on
   tables and columns. Keep selection version 2.
3. Extend `src/catalog.ts` with typed `DBA_TAB_COMMENTS` and
   `DBA_COL_COMMENTS` queries, exact mapping, and explicit completeness errors.
4. Update `src/extract.ts` to produce v3 documents.
5. Add a pure comment DDL renderer and renderability checks, placing it in
   `src/generate.ts` or a focused `src/comments.ts` if shared by validation.
6. Extend `src/validate.ts` with stable unrenderable-comment diagnostics and make
   generation continue to revalidate independently.
7. Add the ordered comment phase in `src/generate.ts`; preserve all later index,
   constraint, grant, FK, and view ordering.
8. Update `test/fixtures.ts`, `examples/source.json`, `examples/target.json`,
   `examples/target.json.report.json`, and `examples/clone.sql` to v3 with present
   and absent comments.
9. Expand `test/catalog.test.ts` for table/column mapping, nulls, apostrophes,
   Unicode, and incomplete or inconsistent comment metadata.
10. Expand `test/pipeline.test.ts` for v2 rejection, strict required fields,
    unchanged transformation, deterministic ordering, exact escaping, null
    omission, quoted identifiers, ampersands, multiline text, Unicode, and a
    near-4,000-character comment that exercises bounded rendering.
11. Extend `test/integration/oracle-roundtrip.test.ts` to compare table and column
    comments between the first target and replayed target. Add explicit assertions
    for apostrophes, Unicode, ampersands, line breaks, and a long comment while
    retaining coverage of all existing seeded comments.
12. Update `README.md`, then run `npm run typecheck`, `npm test`, `npm run build`,
    and `npm run test:integration`.

## Test Plan

- Model: v3 accepts required nullable comment fields; v2, omitted fields, unknown
  fields, and unknown versions fail explicitly.
- Catalog: exact table/column lookup, ordered association, null comments, unusual
  characters, complete result-set handling, and missing/duplicate metadata errors.
- Transform: source comments survive unchanged for target, direct-parent, and
  view-dependency tables; no comment-related policy diagnostic is added.
- Validation: any non-lossless rendering case produces the stable object-specific
  error and blocks SQL.
- Generation: table-before-column order, deterministic table/column order,
  apostrophe and identifier escaping, `SET DEFINE OFF` behavior, null omission,
  Unicode, multiline, and maximum-size chunking without lines over 2,400 bytes.
- Compatibility: all v2 source/target documents are rejected; v2 selection input
  continues to work and extraction outputs v3.
- Integration: seed, extract, transform, validate, generate, replay, re-extract,
  and compare exact comments for all included tables and columns.

## Acceptance Criteria

- [ ] Every non-null comment on an included source table exists unchanged on the
      corresponding destination table.
- [ ] Every non-null comment on a modeled source column exists unchanged on the
      corresponding destination column.
- [ ] Tables included as direct parents or view dependencies retain their comments.
- [ ] Null comments emit no comment DDL and remain null after round trip.
- [ ] Apostrophes, Unicode, ampersands, whitespace, line breaks, and long comments
      round-trip exactly without truncation or normalization.
- [ ] Comment DDL is deterministic and emitted after table creation but before
      index and constraint phases.
- [ ] Missing, inconsistent, or unrenderable comment metadata fails explicitly;
      comments are never silently omitted.
- [ ] Source and target documents use format v3 exclusively; v2 artifacts fail
      parsing and require re-extraction.
- [ ] The version 2 object-selection input remains accepted.
- [ ] Schema, view, and non-table/column comments remain explicitly out of scope.
- [ ] Source access remains read-only; transform, validate, and generate remain
      offline; output files remain non-overwriting.
- [ ] Unit, build, typecheck, and Oracle round-trip commands pass.

## Risks and Open Questions

- The destination database character set must represent the source comment text;
  the integration suite can prove configured environments, but cross-character-set
  conversion remains an operational compatibility risk and must fail visibly.
- Dynamic DDL chunking must be validated against Oracle and SQL*Plus before it is
  accepted; malformed blocks or changed text are release blockers.
- Oracle catalog queries are not a point-in-time snapshot. Concurrent comment DDL
  can produce the same extraction-consistency risk as concurrent structural DDL.

No requester decisions remain open.
