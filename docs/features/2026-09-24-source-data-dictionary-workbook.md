# Feature: Source Data Dictionary Workbook

- Status: Planned
- Date: 2026-09-24
- Request: Generate a structured, human-readable XLSX data dictionary from an
  extracted source document, emphasizing exact table and column comments and
  documenting modeled views separately.

## Context and Scope

The version 3 source JSON is the authoritative machine-readable extraction
artifact, but it is cumbersome for people to browse. Add an offline presentation
command that validates `source.json` and creates one formatted `.xlsx` workbook.
The workbook is a derived report; it does not replace or mutate the source
document and is not input to transformation or SQL generation.

Include metadata, tables, columns, constraints, indexes, views, view dependencies,
external prerequisites, and extraction diagnostics. Put tables and columns first,
make their comment columns prominent, and preserve present comment text exactly in
text cells. Include views in separate `Views` and `View Dependencies` worksheets,
as approved by the requester.

Exclude YAML, CSV, target-policy results, transformation diagnostics, generated
SQL, application rows, inferred descriptions, editable round-trip import, charts,
pivot tables, and live Oracle access. This plan does not add metadata absent from
the current source contract, including view and view-column comments.

Approved assumptions:

- The command is `dictionary --input source.json --output dictionary.xlsx`.
- `.xlsx` is the sole output format.
- The workbook exposes all relevant source-document facts, not only comments.
- Formatting targets Microsoft Excel while remaining usable in compatible office
  suites; exact visual parity across applications is not guaranteed.

## Research Findings

### Verified repository facts

- `src/model.ts` defines strict version 3 source documents. Tables and modeled
  columns already contain required `comment: string | null` fields. Comments are
  exact extracted facts, so no Oracle catalog or model change is needed.
- `src/extract.ts` deterministically orders object selection and assigns the
  `target`, `direct-parent`, and `view-dependency` table roles.
- Source documents also contain constraints, indexes, views, view dependencies,
  prerequisites, and diagnostics. These can be rendered without connecting to
  Oracle.
- `src/cli.ts` currently accepts only `extract`, `transform`, `validate`, and
  `generate`. It validates source JSON only in the transform branch.
- `src/files.ts` provides exclusive, partial-file-based UTF-8 writes. XLSX is
  binary, so equivalent non-overwriting binary output behavior is required.
- `package.json` has no spreadsheet dependency. ExcelJS 4.4.0 supplies TypeScript
  declarations and APIs for writing styled XLSX workbooks, frozen views, and
  filters. It is MIT licensed.
- ADR 0001's four-stage reconstruction pipeline remains intact because this is an
  offline, read-only presentation branch from `source.json`. ADR 0002 already
  establishes exact table and column comment preservation.

### Verified external facts

- Excel supports 1,048,576 rows and 16,384 columns per worksheet, 32,767
  characters per cell, and 253 line feeds per cell. A renderer must reject source
  content or row counts that cannot be represented without loss.
- Spreadsheet software can interpret formula-looking content as executable
  formulas. Source identifiers, comments, SQL expressions, and view queries are
  untrusted presentation data and must be stored as literal string cells, never as
  formula, hyperlink, rich-text, or shared-formula values.
- ExcelJS writes XLSX workbooks and distinguishes string values from formula value
  objects. The generated package still needs structural tests proving that source
  strings do not produce formula elements.

Primary sources, accessed 2026-09-24:

- [Excel specifications and limits](https://support.microsoft.com/en-us/office/excel-specifications-and-limits-1672b34d-7043-467e-8e27-269d656771c3)
- [ExcelJS package documentation](https://www.npmjs.com/package/exceljs)
- [ExcelJS repository documentation](https://github.com/exceljs/exceljs)
- [OWASP CSV/formula injection guidance](https://owasp.org/www-community/attacks/CSV_Injection)

### Inferences

- A normalized multi-sheet workbook is easier to filter than a nested YAML file
  and avoids duplicating table descriptions into every column row.
- Workbook properties must be derived from the source document or fixed constants,
  not wall-clock generation time, to preserve deterministic output.
- Excel limits are wider than current Oracle table/column comment limits, but
  view queries and stored SQL expressions may exceed them. Silent truncation,
  character removal, or formula-neutralizing prefixes would violate the source
  fidelity requirement.

## Decisions and Boundaries

- Add a fifth CLI command as an auxiliary offline report, not a new reconstruction
  pipeline stage: `dictionary --input <source.json> --output <file.xlsx>`.
- Accept source documents only. Target documents and unknown/older source versions
  fail strict parsing before any output is committed.
- Use ExcelJS 4.4.0 as a pinned production dependency and commit the resulting
  lockfile update. Review its transitive dependency audit during implementation.
- Use these worksheets in this fixed order:
  `Metadata`, `Tables`, `Columns`, `Constraints`, `Indexes`, `Views`,
  `View Dependencies`, `Prerequisites`, `Diagnostics`.
- Assign every source-derived textual value as a literal string. Do not modify
  leading `=`, `+`, `-`, `@`, tabs, apostrophes, or line breaks. Do not create any
  workbook formulas, external links, macros, or data connections.
- Preserve `null` distinctly from empty text. Render `null` as a blank cell;
  preserve a present empty string as an explicit empty string cell where the model
  permits it. Tests must inspect values, not rely only on appearance.
- Reject any cell exceeding 32,767 characters or 253 line feeds. Reject any sheet
  that would exceed 1,048,576 rows including its header. Identify the worksheet,
  object, field, observed size, and applicable limit in the error. Never truncate
  or split a single source value across cells.
- Sort every sheet independently with stable ordinal comparisons, never locale
  collation. Use owner/name, then source position or modeled array order where
  semantically significant. Composite constraint and index members use one row per
  member with a one-based member position.
- Apply restrained formatting: bold colored headers, frozen header rows, filters,
  wrapped top-aligned long-text cells, readable fixed widths, alternating row
  styling, and consistent boolean text. Do not merge data cells.
- Set workbook creator/title and created/modified timestamps deterministically
  from fixed values and `extractedAt`. Repeated runs from identical input must
  produce semantically identical workbooks; byte equality is required if ExcelJS
  permits complete ZIP metadata control, otherwise tests compare the unzipped OOXML
  parts while ignoring ZIP container timestamps.
- Write through a same-directory `.partial` file with exclusive creation, sync,
  exclusive final copy, and cleanup behavior equivalent to `writeNewFile`.
  Existing outputs are never overwritten. A failed render must not leave a valid
  final workbook.
- No format-version change and no new ADR are required. README pipeline diagrams
  should show the dictionary as an offline side branch, not redefine ADR 0001's
  four reconstruction stages.

## Proposed Design

### Workbook contract

`Metadata` contains ordered key/value rows for workbook format, source document
format, source kind, dialect, source Oracle version, extraction timestamp, target
table count, target view count, included table count, included view count,
prerequisite count, and diagnostic count.

`Tables` contains one row per included table:

- owner, table name, role, comment
- source tablespace, source compression
- unsupported features as a deterministic newline-delimited list
- column, constraint, and index counts

`Columns` contains one row per modeled column:

- table owner/name/role, position, column name, comment
- datatype owner/name, byte length, character length, length semantics, precision,
  scale
- nullable, default expression, default-on-null, virtual, invisible
- identity generation/options and collation

`Constraints` contains one row per ordered constraint member. Scalar constraints
use member position 1:

- table owner/name, constraint name, generated-name flag, kind
- member position, child/local column, parent owner/table/constraint/column
- check expression and delete rule
- backing-index owner/name
- enabled, validated, deferrable, initially deferred, and rely state

`Indexes` contains one row per ordered index key:

- table owner/name, index owner/name, type, unique, visible, status, partitioned,
  compression
- key position, column, expression, direction

`Views` contains one row per modeled view:

- owner, name, role, ordered columns as a newline-delimited string, query
- read-only, check option, bequeath, status, collation
- editioning, typed, superview, container-data
- unsupported features as a deterministic newline-delimited list

`View Dependencies` contains one row per dependency edge:

- view owner/name/role
- dependency position, dependency owner/name/type, database link

`Prerequisites` contains required-by owner/name, referenced owner/name, type, and
database link. `Diagnostics` contains severity, code, object, and message.

Headers and sheet order are a public report contract documented in README and
locked by tests. Adding, removing, or renaming columns requires an intentional
test and documentation change but does not change the JSON format version.

### Code organization

Add `src/dictionary.ts` with pure conversion and workbook-formatting helpers. The
main export accepts a validated `SourceDocument` and returns an ExcelJS workbook or
serialized buffer. Keep row construction separate from styling so ordering,
flattening, null behavior, and limits can be unit tested without opening Excel.

Extend `src/files.ts` with a binary `writeNewBuffer` helper using the existing
exclusive partial-file pattern. `src/cli.ts` parses and validates `--input`, builds
the workbook offline, serializes it, and commits it only after successful
generation. The command must not import `oracledb`.

Stable user-facing failures include:

- source schema parse errors from Zod;
- `Workbook cell limit exceeded: <sheet> <object> <field> has <n> characters; maximum 32767.`;
- `Workbook line-feed limit exceeded: ... maximum 253.`;
- `Workbook row limit exceeded: <sheet> requires <n> rows; maximum 1048576.`;
- existing output and partial-output collision errors from exclusive writes;
- wrapped serialization/I/O errors without creating a final output.

## Implementation Plan

1. Add pinned `exceljs@4.4.0` to `dependencies` in `package.json`; update
   `package-lock.json`, review install/audit output, and verify Node 22/ESM import
   and TypeScript declarations with the repository compiler settings.
2. Add binary-safe exclusive output support to `src/files.ts`, preserving the
   current `.partial`, sync, exclusive-copy, and non-overwrite guarantees.
3. Add `src/dictionary.ts` with typed sheet definitions, deterministic row
   flattening, explicit Excel-limit validation, literal-text assignment, stable
   workbook properties, sheet order, filters, frozen headers, widths, wrapping,
   and styling.
4. Extend `src/cli.ts` with `dictionary`, its help text, strict source-document
   parsing, offline workbook generation, and binary output. Keep the lazy Oracle
   driver import isolated to `extract`.
5. Add `test/dictionary.test.ts` for workbook contract, all source fields,
   comments, views and dependency edges, stable ordering, formatting, nulls,
   composite members, formula-looking strings, deterministic OOXML, and limit
   failures.
6. Extend `test/files.test.ts` for binary writes, existing destinations, partial
   collisions, failed commits, and exact bytes.
7. Add `examples/data-dictionary.xlsx`, generated from `examples/source.json`, and
   a test that regenerates and semantically compares it. Do not hand-edit the
   workbook fixture.
8. Update `README.md` with the command, workbook sheet/column contract, example,
   safety behavior, Excel limits, exclusions, and the offline side-branch diagram.
9. Run `npm run typecheck`, `npm test`, and `npm run build`. The Oracle integration
   suite is not required because extraction/catalog behavior and generated SQL do
   not change.

## Test Plan

- Parsing: accept a valid v3 source document; reject targets, v2 documents,
  malformed fields, and unknown fields before committing output.
- Tables/columns: cover target, direct-parent, and view-dependency roles; exact
  Unicode, multiline, apostrophe-containing, empty, and null comments; complete
  datatype/default/identity metadata; stable position ordering.
- Constraints/indexes: cover every discriminated constraint kind, composite key
  and FK member order, expression indexes, nullable alternatives, and state flags.
- Views: cover target/dependency roles, ordered columns, multiline query text,
  every view flag, unsupported features, local and database-link dependencies.
- Other sheets: metadata counts, prerequisites, and all diagnostic severities.
- Security: source values beginning with formula control characters remain exact
  strings after ExcelJS re-read; unzipped OOXML contains no formula, macro,
  external-link, or data-connection parts attributable to source data.
- Limits: exact boundary and one-over-boundary cases for characters, line feeds,
  and rows. Over-limit cases fail without truncation or final output.
- Presentation: fixed sheet order and headers, filters, frozen first rows, wrapped
  comment/query/expression cells, fixed widths, and no merged data cells.
- Determinism: two workbooks from identical source input have identical logical
  cell values, styles, properties, relationships, and normalized OOXML parts.
- Files: binary content survives exactly; final and partial path collisions never
  overwrite existing data.
- CLI: help lists the command; successful generation names the output; invalid
  input, over-limit input, and existing output exit nonzero; no Oracle credentials
  or driver load is required.

## Acceptance Criteria

- [ ] `npm run schema -- dictionary --input source.json --output dictionary.xlsx`
      creates a readable XLSX workbook from a valid source document without Oracle
      access.
- [ ] Workbook sheets appear in the documented fixed order and expose every field
      listed in the workbook contract.
- [ ] `Tables` and `Columns` are prominent and preserve table and column comments
      exactly, including null, Unicode, apostrophes, whitespace, and line breaks.
- [ ] `Views` and `View Dependencies` are separate sheets and preserve modeled
      view facts and dependency order.
- [ ] Headers are frozen and filterable; long text is wrapped; rows use stable,
      documented ordering.
- [ ] Formula-looking source text remains literal text and cannot create workbook
      formulas, macros, external links, or data connections.
- [ ] Unrepresentable Excel cell, line-feed, or row counts fail with stable,
      actionable errors; no source value is truncated, normalized, or split.
- [ ] Existing output files are never overwritten and failed work does not create
      a valid final workbook.
- [ ] Source/target JSON contracts remain format version 3 with no field changes.
- [ ] Existing extract, transform, validate, and generate behavior is unchanged;
      only extract can connect to Oracle.
- [ ] README, example workbook, unit tests, typecheck, and build are updated and
      pass.

## Risks and Open Questions

- ExcelJS 4.4.0 is mature but has not published a stable release recently and adds
  transitive dependencies. Implementation must review audit results and replace
  the library before merging if unacceptable vulnerabilities affect workbook
  generation.
- Excel-compatible applications may render widths, row heights, and colors
  differently. Cell values and structure are authoritative; pixel-identical
  presentation is not required.
- ZIP container timestamps may prevent byte-identical output even when workbook
  content is deterministic. Normalized OOXML equality is the minimum acceptance
  test unless the selected writer exposes full container timestamp control.

No requester decisions remain open.
