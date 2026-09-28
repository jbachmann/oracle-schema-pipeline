# Feature: PL/SQL procedure and package reconstruction

- Status: Implemented and verified
- Date: 2026-09-28
- Request: Select standalone and packaged procedures by name in `objects.json`,
  recursively extract supported dependencies, and recreate them through generated
  SQL and the existing local Docker clone workflow.

## Context and Scope

The requester approved standalone and packaged procedures, recursive dependency
extraction, and the existing local Docker destination. A packaged procedure is
reconstructed with its entire package specification and body, including other
public members, private helpers, and initialization code. It is never lifted out
of its package or rewritten as a standalone procedure.

All four pipeline stages change, together with selection parsing, the dictionary,
local replay/verification, and retry compatibility. Extraction remains read-only;
transform, validate, and generate remain offline.

Recursive extraction follows recorded local dependencies on supported TABLE,
VIEW, PROCEDURE, FUNCTION, and PACKAGE objects. Standalone functions are included
as dependencies because otherwise ordinary procedure call chains cannot be
reconstructed. This does not introduce explicit function selection. Package
selection includes both specification and body dependencies. Supported table and
view variants retain their existing restrictions.

Other local dependency types, such as standalone sequences, synonyms, SQL object
types, and external libraries, use the existing provision-and-acknowledge
prerequisite mechanism; this feature does not implement their exporters. Database
links are never followed and remote edges block generation. Dynamic SQL and
runtime invoker-specific references cannot be exhaustively discovered. Recursion
means following supported catalog edges, not exporting an entire database or
promising that every runtime dependency is known.

Excluded: application rows, arbitrary destination connection/replay, schema
renaming, copying application users/roles/security policy, selective package-body
surgery, executing selected procedures during extraction or operational
verification, wrapped code, external-language call specifications, and edition
hierarchy reconstruction. Declared limitations must be visible in documentation
and diagnostics, not silently approximated.

## Research Findings

### Verified repository behavior

- `src/model.ts` uses strict selection version 2 (`tables`, `views`), document
  format 5, and policy version 1. Exact owner/name pairs avoid ambiguity for
  identifiers containing periods. Current formats reject stored-program fields.
- `src/extract.ts` and `src/catalog.ts` expand view dependencies recursively;
  explicit tables alone expand one-hop FK parents. The extraction interfaces have
  optional prefetch hooks. `src/catalog-reader.ts`, `src/catalog-queries.ts`, and
  `src/catalog-schemas.ts` provide bounded, sequential, strictly decoded ALL/DBA
  reads. ALL access never silently escalates to DBA.
- `src/semantic.ts` independently checks reachability, roles, namespaces, and view
  ordering. `src/validate.ts` gates `src/prepare.ts`; `src/generate.ts` independently
  revalidates before joining prepared operations.
- `src/prepare.ts` currently creates indexes before views. `src/index-grants.ts`
  requires function/package index dependencies to be external prerequisites.
  Both assumptions need revision when those objects are included in the model.
- `src/schema-owners.ts` currently covers table, view, and index owners only.
  `scripts/compose-destination.ts` verifies those objects, and matches an exact
  format-5 SQL preamble. Retry calls the same adapter from
  `scripts/clone-retry-input.ts` and validates the current target contract.
- `src/comments.ts` already renders bounded SQL string chunks, but its current
  32,767-byte statement limit is unsuitable for large package bodies.
- ADRs 0001–0008 preserve source read-only access, deterministic output, independent
  validation, exclusive publication, and the fixed local destination boundary.
  ADR 0001 explicitly excludes stored programs.

### Primary Oracle documentation

Accessed 2026-09-28. The requested Oracle 23 documentation URLs redirect to the
Oracle 26 pages below. Documentation supports the design, but new catalog and
replay behavior must be verified on the repository's pinned Oracle image before
shipping; no live PL/SQL probes were run while preparing this plan.

- [Packages](https://docs.oracle.com/en/database/oracle/oracle-database/26/lnpls/what-is-package.html)
  and [package bodies](https://docs.oracle.com/en/database/oracle/oracle-database/26/lnpls/package-body.html):
  specifications declare public members; bodies implement members and may contain
  private state and initialization. Whole-package reconstruction preserves these
  relationships.
- [ALL_SOURCE](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_SOURCE.html):
  source is available by OWNER, NAME, TYPE, LINE, and TEXT; PACKAGE and PACKAGE BODY
  are separate units. Source visibility must be checked explicitly.
- [ALL_PROCEDURES](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_PROCEDURES.html):
  top-level object and member names, overloads, and AUTHID are available. Do not
  depend on recently added IS_PROCEDURE/IS_FUNCTION columns without verifying
  source-version support; resolve member kinds from supported metadata/source.
- [ALL_DEPENDENCIES](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_DEPENDENCIES.html)
  and [dependency management](https://docs.oracle.com/en/database/oracle/oracle-database/26/adfns/schema-object-dependency.html):
  catalog edges identify referenced objects and links; dynamic SQL creates no
  dependency edges. Package-body discovery must be explicit when a package is
  referenced, even if the caller's catalog edge names only the specification.
- [Compiler settings](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_PLSQL_OBJECT_SETTINGS.html)
  and [conditional compilation](https://docs.oracle.com/en/database/oracle/oracle-database/26/lnpls/conditional-compilation1.html):
  compilation settings are stored per unit, and conditional source branches can
  depend on flags or database version.
- [AUTHID](https://docs.oracle.com/en/database/oracle/oracle-database/26/lnpls/invokers-rights-and-definers-rights-authid-property.html):
  compile-time and runtime privilege/name-resolution behavior differ. Dependency
  edges alone do not identify which DML grants are necessary.
- [DBMS_SQL](https://docs.oracle.com/en/database/oracle/oracle-database/26/arpls/DBMS_SQL.html):
  PARSE supports CLOB statements; DDL executes during parse. It can transport a
  large CREATE statement without treating source lines as SQL*Plus commands.
- [ALL_ERRORS](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_ERRORS.html):
  compilation errors and warnings have object, line, position, and message-number
  metadata. Successful SQL client exit alone is insufficient evidence of validity.

### Design conclusions

The following are engineering choices, not additional requester preferences:
use whole packages, a versioned source-text model, bounded dependency traversal,
an operation graph instead of a final append-only PL/SQL phase, and mandatory
destination compilation checks. Unsupported local dependencies remain explicit
prerequisites. Initial support rejects dependency cycles that require temporary
invalid objects; normal self-recursion and package-private recursion are allowed.

## Decisions and Boundaries

1. Preserve exact identities, source lines, AUTHID, and supported compilation
   settings. Never use DBMS_METADATA.GET_DDL or reformat procedure bodies.
2. Package member selection names a public procedure; all its overloads and the
   entire containing package are included. Selecting several members deduplicates
   the package. Private members are not independently selectable. Selecting a
   whole package is also supported.
3. PL/SQL roots recursively include supported dependencies. Tables reached this
   way do not expand outgoing FKs; transform removes those FKs with the existing
   report mechanism. Explicit table roots retain their existing one-hop rule.
4. Existing table/view-only selections retain their selection behavior. A
   dependency also reached from a PL/SQL root may be supplied internally instead
   of externally. Adding an unrelated PL/SQL root must not silently expand every
   legacy table/view root's external prerequisites.
5. Oracle-maintained dependencies are platform requirements, not export roots.
   Determine this from catalog facts, not a hard-coded owner-name shortcut.
   Explicit Oracle-maintained roots are rejected. Missing classification metadata
   is an error, never permission to omit a dependency.
6. Invalid, inaccessible, missing, malformed, or unsupported selected units cannot
   produce a successful clone. A discoverable supported dependency cannot be
   silently demoted to an external prerequisite just because its source is hidden.
7. Use ordinary CREATE for initial units. Do not replace or skip an existing
   destination program. Existing-user reuse remains governed by feature 18.
8. No automatic execution of business entry points to validate deployment.
   Creating a function-based index can itself evaluate a function; inherited SQL
   execution risks remain part of the trusted destination replay boundary.

## Oracle Example and Expected Selection

```sql
CREATE TABLE APP.ORDERS (ID NUMBER PRIMARY KEY, STATUS VARCHAR2(20));

CREATE FUNCTION APP.ORDER_EXISTS(p_id NUMBER) RETURN NUMBER AS
  n NUMBER;
BEGIN
  SELECT COUNT(*) INTO n FROM APP.ORDERS WHERE ID = p_id;
  RETURN n;
END;
/

CREATE PACKAGE APP.ORDER_API AS
  PROCEDURE PROCESS_ORDER(p_id NUMBER);
END;
/
CREATE PACKAGE BODY APP.ORDER_API AS
  PROCEDURE PROCESS_ORDER(p_id NUMBER) IS
  BEGIN
    IF APP.ORDER_EXISTS(p_id) > 0 THEN
      UPDATE APP.ORDERS SET STATUS = 'PROCESSED' WHERE ID = p_id;
    END IF;
  END;
END;
/

CREATE PROCEDURE APP.PROCESS_ONE(p_id NUMBER) AS
BEGIN
  APP.ORDER_API.PROCESS_ORDER(p_id);
END;
/
```

Proposed `objects.json` (selection v3):

```json
{
  "version": 3,
  "procedures": [
    { "owner": "APP", "name": "PROCESS_ONE" },
    { "owner": "APP", "package": "ORDER_API", "name": "PROCESS_ORDER" }
  ],
  "packages": []
}
```

`tables`, `views`, `procedures`, and `packages` default to empty arrays; at least
one root is required. A package reference in `packages` is `{owner, name}`.
The optional `package` field is separate from `name`; dotted strings are never
split. This input includes ORDERS, ORDER_EXISTS, ORDER_API specification/body, and
PROCESS_ONE exactly once. Rows are not copied. Generated SQL creates all units in
dependency order and checks their validity. A destination-only integration test
inserts a disposable order, calls PROCESS_ONE, verifies STATUS, and rolls back.

## Proposed Design

### Contracts and compatibility

In `src/model.ts`, accept strict v2 selection unchanged and strict v3 selection
with the fields above. Normalize v2 to empty procedure/package roots internally;
unknown versions and v2 documents containing new fields fail. Preserve the
selection's versioned semantics when persisting clone inputs.

Source and target documents move to format 6. Older artifacts must be
re-extracted, not relabeled or automatically upgraded. Required additions:

| Field              | Shape and meaning                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `selectionVersion` | `2` or `3`; records which selection semantics apply                                                |
| `targetProcedures` | Deduplicated, sorted exact procedure selections, including optional `package`                      |
| `targetPackages`   | Deduplicated, sorted explicit whole-package references                                             |
| `programs`         | Array of the program definitions below; empty for old-style extractions                            |
| `table.role`       | Add `program-dependency`; precedence is target, direct-parent, view-dependency, program-dependency |

Reachability through an explicit view root gives `view-dependency` precedence;
a table reached only through a program and its dependent views is a
`program-dependency`. Existing view roles remain target/dependency.

Each program has `reference: {owner,name}`, `kind: 'procedure' | 'function' |
'package'`, `role: 'target' | 'dependency'`, `authid: 'DEFINER' | 'CURRENT_USER'`,
`editionable: boolean`, `sourceOwnerEditionsEnabled: boolean`,
`oracleMaintained: boolean`, `unsupportedFeatures: string[]`, and
`units: ProgramUnit[]`. Independently reject Oracle-maintained programs and
editions-enabled owners even if unsupportedFeatures has been cleared.
Target role includes a package selected via any member. Standalone functions
always have dependency role. Shared SQL namespace checks include programs,
tables, and views; PACKAGE BODY is part of its package, not a conflicting object.

A `ProgramUnit` contains:

- `type`: PROCEDURE, FUNCTION, PACKAGE, or PACKAGE BODY; exactly one matching
  unit for standalone objects, one specification and at most one body for packages.
- `status`: VALID or INVALID, recorded exactly and validated independently.
- `sourceLines`: ordered `{line: positive integer, text: string}` entries, starting
  at 1 with no duplicates/gaps; concatenate exact TEXT without adding separators.
  Oracle null TEXT for a genuinely empty line is represented as an empty string;
  an absent row or wholly empty unit is not valid source.
- `dependencies`: exact `{reference, type, databaseLink, oracleMaintained}` edges;
  `type` remains a nonempty catalog string so unsupported facts are retained,
  `databaseLink` is string/null, and `oracleMaintained` is a required boolean.
- `settings`: `plsqlOptimizeLevel` (0–3), `plsqlCodeType` (INTERPRETED/NATIVE),
  `plsqlDebug` (boolean), `plsqlWarnings` (string), `nlsLengthSemantics`
  (BYTE/CHAR), `plsqlCcflags` (string/null), and `plscopeSettings` (string).
  Validate values before constructing ALTER SESSION statements; never interpolate
  settings as arbitrary SQL. Unknown required settings fail decoding.

For packages add `publicProcedures: {name: identifier, overload: string|null}[]`
and `bodyRequired: boolean`. Determine public procedure identity and body necessity
from verified catalog evidence plus narrowly scoped declaration inspection, not
an assumed one-row-per-package query. Functions/cursors can also require a body.
A specification-only dependency is accepted only when the absence of a required
body is established; ambiguous or invisible body metadata fails closed.

Keep the existing table/view/index dependency fields and prerequisites. Program
unit edges supply program reachability. Existing table prerequisites and index/
view edges supply onward traversal for tables/views reached from program roots.
Do not delete source prerequisite facts when the dependency becomes internal;
downstream validation resolves each edge against included definitions first.
Type conflicts and ambiguous resolutions fail rather than choosing by name alone.

Policy v1 remains accepted. Introduce strict policy v2 with existing fields plus
`plsqlObjectGrants`, default `[]`. Each entry is `{reference, grantee, privileges}`:
reference is an exact TABLE/VIEW dependency, grantee an included program owner,
and privileges a nonempty deduplicated array of SELECT, INSERT, UPDATE, DELETE,
or REFERENCES. Object type is resolved against definitions/prerequisites; extra
unrelated grants fail validation. V1 cannot contain this new field.

These explicit grants handle cross-owner table/view access without guessing DML
privileges from dependency edges. A cross-owner program-to-table/view edge requires
at least one policy entry and produces `PLSQL_PRIVILEGE_REVIEW`; the operator must
specify sufficient privileges. Compilation is the final check, not a claim that
the chosen set is minimal. Automatically derive exact EXECUTE grants for direct
cross-owner application-program-to-program edges, with change reports.
Oracle-maintained edges do not generate grants; required platform access remains
a destination setup requirement. No role, system,
PUBLIC, or grant-option privileges are generated. Other external-object grants
remain part of prerequisite SQL. Existing policies work for same-owner examples.

Completion manifest version 1 and clone configuration version 1 remain unchanged.
Retry accepts current format-6 targets and their exact new preamble; old bundles
fail before destination reset with a fresh-extraction instruction. It never
rewrites previously saved SQL into a newer format.

### Catalog extraction and recursive closure

Add `src/catalog-programs.ts` (new) and optional `SourceCatalog` methods for program
reads/member resolution and bounded prefetch. Unsupported custom adapters still
work with table/view-only selections; program requests receive an explicit error.
Extend catalog view mappings, query definitions, and row decoders for SOURCE,
PROCEDURES, PLSQL_OBJECT_SETTINGS, and relevant OBJECTS/USERS metadata. Use bound
owner/name/type predicates and complete paged reads. Verify ALL visibility for
both package units; do not fall back to DBA or execute a source compilation.

Use one work queue keyed by exact owner/name/object type, stable ordinal ordering,
and a visited set. Resolve member roots to packages before traversal. Every
included package schedules its body when present/required. Read both units'
dependencies, including private-helper references. Suppress duplicate work across
explicit roots, FK parents, view closure, and program closure, while preserving
all inclusion reasons for role calculation.

Process table prerequisites and function-based index dependencies when their
table is reached from a program; process TABLE/VIEW/PROGRAM edges of reached views.
Do not turn table FK edges into unbounded expansion. If a table/view was already
read through a legacy root and is later reached from a program, expand its
program-context dependencies without rereading or losing the new inclusion reason.

Preserve batch size 32, sequential connection usage, cache rollback, and result-set
closure. Add explicit progress categories `program`, `program-source`,
`program-members`, `program-settings`, `program-dependencies`; retain event v1 and
its existing envelope. Update consumers/tests to accept these additive categories.
Do not put source text, settings, binds, or driver messages in telemetry.

### Source preservation and supported variants

Add a focused lexer in `src/plsql.ts` (new), shared by validation and rendering.
Handle quoted identifiers, ordinary/national/alternative string literals, and
comments. Validate the declaration kind/name against catalog identity, detect
wrapped/external-language units and conditional compilation tokens, and locate
only the declaration identifier span. Qualify that span for destination CREATE;
preserve all other source bytes. Do not search-and-replace identifiers throughout
the body. No general PL/SQL expression parser or security sandbox is promised.

Reject conditional-compilation directives/inquiry tokens outside literals and
comments in this initial implementation (`UNSUPPORTED_PLSQL_CONDITIONAL`), even
if current flags appear compatible: replay on another release could activate
dependencies absent from the source graph. Preserve recorded settings for review;
apply supported settings per unit before compilation, then restore the baseline
for subsequent operations. Reject specialized semantics/settings that cannot be
reproduced rather than silently using session defaults. Preserve editionability
only in an ordinary non-editions-enabled owner; reject editions-enabled source
owners until edition hierarchy support exists.

Source code is trusted metadata and may itself contain sensitive application
literals. Connection credentials must never be injected into it or any artifact;
do not claim automatic detection/redaction of secrets embedded in source code.
Keep private publication permissions and exclude source snippets from errors/logs.

### Transformation, validation, and SQL ordering

Keep source programs unchanged in transform. Report automatically included
dependencies, whole-package expansion, dependency-only FK omissions, generated
grants, and the runtime-dependency limitation. Always emit a once-per-document
`PLSQL_RUNTIME_DEPENDENCIES` warning for documents with programs; lexical scanning
is not a proof that runtime dependencies are complete.

Add `src/program-semantics.ts` and `src/program-grants.ts` (new). Recompute closure
from roots and captured edges, reject missing or unreachable units, validate
package-member requests, and check type/role/namespace consistency. Extend
`src/semantic.ts`, `src/validate.ts`, and `src/index-grants.ts` so an included
function/package can satisfy an existing dependency without external setup.
Reject an externalPrerequisites entry that also names an included definition with
`INTERNAL_PREREQUISITE_CONFLICT`; otherwise preflight would incorrectly demand
that definition before replay. External acknowledgement never authorizes
overwriting an included object.

Preparation needs an operation graph, not a fixed final PL/SQL phase. Nodes include
table creation, indexes, constraints, views, program units, and grants. Retain
existing dependencies (table before its indexes, backing index before PK/UK,
parent key/grants before FK) and add these edges:

- A program unit follows its referenced tables/views, standalone programs, package
  specifications, and required grants. A package body follows its specification.
- For compilation, a reference to a package normally needs its specification;
  including the package still requires reconstructing its body for runtime use.
- Function-based indexes follow all required executable function/package bodies
  and their transitive executable dependencies, as well as index-owner grants.
- Views that use included functions/packages follow those definitions and grants;
  keep existing table/view grants and deduplicate shared grants.

Use ordinal tie-breaking for ready operations. Standalone self-recursion does not
create an ordering edge; package-private recursion stays within one body. Cycles
between separate compilation operations, including mixed view/program/table-DDL
cycles, fail with `PLSQL_DEPENDENCY_CYCLE`. Do not generate FORCE views, stubs,
temporary invalid programs, or global error suppression to break them. Circular
runtime calls between package bodies may work where the specification compilation
graph is acyclic; include a fixture proving this distinction.

Add `src/plsql-ddl.ts` (new). Render complete CREATE DDL as bounded string chunks
appended to a temporary CLOB, then call DBMS_SQL.PARSE and close its cursor. DDL
requires no DBMS_SQL.EXECUTE call. Free temporary LOBs and close cursors on every
exception, then rethrow. A package over 32 KB and a source line over 2,400 bytes
must work without truncation or alteration; generated physical lines still obey
the existing 2,400-byte preflight limit. Reuse/refactor string encoding from
`src/comments.ts` without changing its existing output contract. Encode source
newlines inside the CLOB so slash lines, ampersands, and SQL*Plus-looking source
text cannot become client commands.

After each unit, assert the exact expected object exists and is VALID with no
ERROR entries in the catalog; warnings alone are reported without failing unless
the preserved compiler settings promote them to errors. Fail on compilation
errors even if the client reports successful creation. Source bodies are never
called as part of these assertions. Recheck all included units after replay.

### Local orchestration, dictionary, and diagnostics

Update `src/schema-owners.ts` for program-only owners. Share the generated preamble
definition with replay validation so format 6 is explicit and the former claim
that no source DDL was replayed is replaced by an accurate catalog/source-text
description. Keep operational ECHO OFF and safe error-code extraction. Adapt only
the known preamble, never scan/replace program text in the orchestration layer.

Extend `scripts/compose-destination.ts` final verification for PROCEDURE, FUNCTION,
PACKAGE, PACKAGE BODY, compilation errors, and generated direct grants. Map
generated object-index failure markers to safe owner/name/unit information;
include line/position/message number where available, never raw compiler TEXT
or source. Use those checks for both clone and retry. Preserve all existing
preflight, locking, destination identity, reset, and immutable-result behavior.

In `src/dictionary.ts`, add program/root counts, a Programs sheet (identity, kind,
role, AUTHID, unit presence/status), and Program Dependencies (including unit type,
referenced identity/type/link/platform classification). Do not put entire source
bodies into worksheet cells. JSON remains the complete source artifact.

Stable diagnostic behavior:

| Code                                                                                | Meaning / stage                                                                                                                |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `CATALOG_CARDINALITY`, `CATALOG_UNKNOWN_VALUE`, `CATALOG_INCOMPLETE_METADATA`       | Existing extraction failures; missing source/settings/body or inconsistent ordered metadata includes safe object/field context |
| `PLSQL_MEMBER_NOT_FOUND`                                                            | Requested public procedure missing or member kind cannot be established; extraction rejects                                    |
| `INVALID_PLSQL`                                                                     | Source unit status invalid; validation/generation reject                                                                       |
| `UNSUPPORTED_PLSQL`, `UNSUPPORTED_PLSQL_CONDITIONAL`                                | Wrapped, external, editioned, conditional, or other unsupported source semantics                                               |
| `PLSQL_SOURCE_MISMATCH`                                                             | Declaration kind/name inconsistent with identity, or unsafe/unrecognized declaration envelope                                  |
| `MISSING_PLSQL_DEPENDENCY`, `EXTRA_PROGRAM`, `DUPLICATE_PROGRAM`                    | Independent closure/uniqueness violations                                                                                      |
| `PLSQL_DEPENDENCY_CYCLE`                                                            | Compilation operation cycle; list involved exact identities deterministically                                                  |
| `PLSQL_REQUIRED_GRANT`                                                              | Cross-owner table/view edge lacks an explicit policy grant entry                                                               |
| `PLSQL_PRIVILEGE_REVIEW`, `PLSQL_RUNTIME_DEPENDENCIES`                              | Warnings about grant sufficiency and runtime dependency limits                                                                 |
| `PLSQL_PACKAGE_INCLUDED`, `PLSQL_DEPENDENCY_INCLUDED`, `PLSQL_REQUIRED_GRANT_ADDED` | Transformation changes describing inclusion and grants                                                                         |
| `REMOTE_PREREQUISITE`, `UNACKNOWLEDGED_PREREQUISITE`                                | Existing external/remote failure policy retained                                                                               |
| `PLSQL_COMPILE_FAILED`                                                              | Safe replay marker mapped to existing failed clone result, with unit identity and numeric compiler context                     |

Retain existing `OBJECT_NAME_COLLISION`, `ROLE_MISMATCH`, `MISSING_TARGET`,
`SQL_LINE_LIMIT`, artifact-publication, and clone stage failure conventions.
Never overwrite artifacts, return success with invalid units, publish a partial
source document after extraction failure, or log raw program text.

## Implementation Plan

1. Add a new ADR (next unused number; currently 0009) superseding ADR 0001's stored
   program exclusion, documenting selection v3/format 6 and bounded program
   dependency expansion. Amend ADR 0003's TABLE/VIEW-only dependency restriction
   for internally resolved program dependencies and ADR 0007's category list.
   Preserve ADR 0008's exact destination boundary and all other invariants.
2. Establish Oracle fixtures/probes in `test/docker/oracle/source-init/01-seed.sql`
   and new `test/integration/plsql-roundtrip.test.ts`: ordered source reconstruction,
   package members/overloads, body-required evidence, source visibility, settings,
   CLOB PARSE, source-header forms, and compilation status. Use only the explicit
   `oracle-schema-pipeline-test` Compose project. Resolve pinned-image mismatches
   before committing to metadata decoding; do not silently raise version support.
3. Implement contract/version parsing in `src/model.ts`, update `test/fixtures.ts`,
   `test/preparation-fixtures.ts`, and JSON fixtures. Add lexer and focused
   `test/plsql.test.ts` (new). Update custom catalog adapters with optional methods.
4. Implement catalog queries/readers and bounded prefetch, then program-aware
   extraction closure in `src/extract.ts`. Extend `src/progress.ts` and progress
   consumers. Add new `test/catalog-programs.test.ts` and extend extraction,
   batching, decoding, and progress tests.
5. Implement independent semantics, grant policy/derivation, source-preserving
   transformation, and operation ordering in the modules above. Extend existing
   table/view/index checks rather than bypassing them. Add new
   `test/program-semantics.test.ts` and extend `test/validate.test.ts`,
   `test/prepare.test.ts`, `test/pipeline.test.ts`, and cross-owner index coverage.
6. Implement bounded CLOB DDL rendering and compilation assertions. Extend
   `src/sql-preparation.ts` only as needed to retain per-operation provenance and
   aggregated diagnostics. Add `test/plsql-ddl.test.ts` (new).
7. Integrate schema owners, shared preamble, clone/retry verification, safe failure
   mapping, policy loading, CLI usage, and dictionary output. Update
   `scripts/clone-config.ts`, `scripts/clone-workflow.ts`,
   `scripts/clone-retry-input.ts`, `scripts/compose-destination.ts`, and their tests.
8. Extend independent catalog/behavior verification in
   `test/integration/independent-facts.ts`, source snapshots in
   `test/scripts/verify-clone-source.ts`, and local clone/retry integration coverage.
   Update `README.md`, `docs/source-preservation-verification.md`, add
   `examples/objects.json`, and regenerate affected example artifacts into fresh
   paths before replacing tracked examples through reviewed repository edits.
9. Run `npm run typecheck`, `npm test`, `npm run build`, and
   `npm run test:integration`; inspect formatting and `git diff --check`. Existing
   package scripts cover the new root-level and integration test filenames.
   Record actual results and supported Oracle versions in this document.

## Test Plan

- Selection v2 compatibility; v3 standalone/member/package and mixed roots;
  program-only input; empty/unknown/misspelled fields; duplicate selections;
  periods, quotes, spaces, mixed case, and same names across owners; overloads;
  nonexistent/private/function-as-procedure member selection.
- Exact multi-page source reads, CR/LF, comments, national/alternative literals,
  Unicode, terminal newlines, null empty lines, missing/duplicate line numbers,
  duplicate units, missing bodies/settings, unknown enum flags, and failed cursor
  cleanup. Verify a header name inside a string/comment is never rewritten.
- Restricted ALL reader can read all required source/dependencies, or fails
  explicitly; DBA reader succeeds with appropriate visibility. No implicit scope
  escalation. Verify extracted package body dependencies, not just caller edges.
- Deep/wide/diamond graphs, shared roots, table first discovered in legacy context
  then reached through PL/SQL, self-recursion, acyclic package-body mutual calls,
  rejected standalone/mixed compilation cycles, internal/external index functions,
  and absent/ambiguous/remote/Oracle-maintained dependencies.
- Existing table/view-only scope and FK omission remain unchanged. Program closure
  gets no extra FK grandparents. Target roles take precedence. Offline tampering
  cannot add unreachable objects, omit referenced units, or bypass package checks.
- Unsupported wrapped/external/editioned/conditional variants fail with stable
  codes, including directive-like text inside literals/comments as negative cases.
- Same-owner and cross-owner calls, SELECT versus UPDATE grants, missing and
  insufficient grants, v1/v2 policy parsing, unrelated/overbroad grant rejection,
  and no role/system privilege fallback. Include both AUTHID values and document
  that invoker runtime privileges are outside compile-time verification.
- Round-trip a package larger than 32 KB, source lines over 2,400 bytes, slash-only
  lines inside literals/comments, and SQL*Plus-looking text. Independent catalog
  source comparison permits only the specified header qualification change and
  observed Oracle envelope normalization; literals/body content remain exact.
- Verify source settings and destination settings independently, program-only
  schema creation, spec-before-body ordering, functions before dependent views/
  indexes, final validity/error counts, and no implicit replacement of an existing
  program. A compile failure must fail clone even when SQL*Plus exits zero.
- Destination-only invocation of a harmless fixture confirms output/OUT parameters,
  a dependency function, package-private helper/state, and rolled-back table DML.
  Source snapshots include SOURCE and PLSQL_OBJECT_SETTINGS and remain unchanged.
- Publication collision/manifest failure, deterministic repeated generation,
  safe diagnostics/progress, dictionary metadata, successful retry, and rejection
  of old/incompatible bundles before any destructive destination operation.

## Acceptance Criteria

- [x] Named standalone procedures and public packaged procedures are selectable
      through `objects.json`; package expansion is explicit in the report.
- [x] The example above extracts all supported dependencies without listing them
      individually and creates valid destination objects once each.
- [x] Recursive extraction terminates, preserves existing FK boundaries, and
      reports unsupported/external and runtime dependency limitations explicitly.
- [x] Source/program metadata is preserved; no source writes, source procedure
      calls, DBMS_METADATA extraction, body rewriting, or credential logging occurs.
- [x] Missing/invalid/unsupported metadata blocks SQL with the specified diagnostics;
      generation revalidates authored targets independently of extraction annotations.
- [x] Generated SQL preserves large source text, compiles in deterministic order,
      and fails on collisions, insufficient grants, or compilation errors.
- [x] Local clone and retry verify every expected program unit and direct generated
      grant while preserving existing destination guardrails and artifact guarantees.
- [x] Legacy selection/policy inputs retain documented behavior; old model/retry
      artifacts fail clearly and require fresh extraction.
- [x] Unit, integration, independent source/destination, and source-preservation
      checks pass; README, examples, and required ADR changes are complete.

## Risks and Open Questions

No outstanding requester decisions. The implementation checks below resolved
metadata visibility, source-header handling, compiler settings, and large CLOB
replay on the pinned image. Stored-program extraction requires explicit DBA scope
on that image; ALL fails clearly when owner edition metadata is unavailable.

Recursive package expansion can include substantially more code and metadata than
one member suggests. Dynamic SQL, external prerequisites, runtime invoker context,
application data, and deliberately omitted dependency-table FKs mean a valid clone
is not a guarantee of production-equivalent behavior. Cross-owner DML privileges
require explicit policy entries; recorded dependencies do not identify a minimal
grant set. Initial conditional-compilation and cycle exclusions limit portability
but avoid silently changing program behavior. Source capture is not a transactionally
consistent schema snapshot; existing concurrent-DDL limitations remain.

## Implementation and verification record (2026-09-28)

Implemented selection v3, policy v2, document format 6, recursive program-context
extraction, independent validation, mixed operation ordering, source-preserving
CLOB rendering, dictionary metadata, and clone/retry verification. ADR 0009 records
the changed invariant; ADRs 0003 and 0007 document the related extensions. README,
CLI help, source-preservation guidance, and regenerated examples describe the final
behavior. Older documents and retry bundles require fresh extraction.

Verified against the repository's pinned Oracle image, reporting Oracle AI Database
26ai Free Release 23.26.3.0.0. This does not claim compatibility with other Oracle
releases. The following implementation details were established through tests:

- DBA scope supplies the required owner edition metadata. ALL_USERS lacks
  EDITIONS_ENABLED; ALL program requests fail with CATALOG_INCOMPLETE_METADATA
  without querying DBA views implicitly. Existing table/view ALL behavior remains.
- Specification-only packages can have null catalog AUTHID. Their preserved
  declaration supplies this evidence; standalone units still require catalog data.
  Public procedures and overloads are distinguished from private members/functions.
- Oracle-maintained classification uses exact referenced objects, including public
  synonyms. It is not inferred from owner names. Table-origin and index-origin
  prerequisites remain distinct even when both reference the same function.
- The program-context queue reuses legacy table/view caches, expands previously
  read objects without rereading them, and preserves unrelated legacy scope and FK
  boundaries. Program prefetch stages at most 32 objects using sequential reads,
  publishes only complete batches, and closes paged result sets.
- Constraints precede dependent views/programs because later table alterations can
  invalidate compiled views. Function-based indexes wait for the transitive
  executable closure, including package bodies and onward table/view dependencies.
- Large package source (over 40 KB), long source lines (over 2,400 bytes), Unicode,
  SQL*Plus-looking literals, overloads, compiler settings, and editionability
  round-trip. Repeated failed CREATE attempts restore settings and do not accumulate
  temporary LOBs or cursors. Compiler warnings are nonfatal numeric markers;
  compiler errors expose only safe unit identity and numeric context.
- Destination-only invocation verifies dependency functions, OUT parameters,
  private helpers/state, and rolled-back DML. Source snapshots include source text
  and compiler settings and remain unchanged. Cross-owner explicit grants are
  tested with sufficient and insufficient privileges, including AUTHID CURRENT_USER.
- Deep, wide and diamond graphs, late program-context discovery, standalone cycles,
  package-body mutual calls, malformed metadata, authored target tampering,
  collisions, failed cache batches, and runtime-limit warnings have regression tests.

Validation results:

- `npm run typecheck` and `npm run build`: passed.
- `npm test`: 455 passed, 0 failed.
- `npm run test:integration`: 10 passed, 0 failed; the one opt-in local clone test
  was skipped by its environment gate in this run.
- `ORACLE_LOCAL_CLONE_INTEGRATION=1 node --import tsx --test --test-name-pattern='remote source to disposable local clone' test/integration/local-clone.test.ts`:
  1 passed. This separately verifies actual local replay, replacement, retry,
  program validity and invocation, source preservation, and intentional failures.
  It refuses pre-existing operational resources and cleans its own destination.
- `node --import tsx --test test/integration/plsql-roundtrip.test.ts`: 3 passed,
  0 failed, after the last validation refinements.
- Formatting of changed text artifacts and `git diff --check`: passed.

Legacy reconstruction, restricted readers and ALL/DBA batching passed alongside
the PL/SQL integration cases. Synthetic example artifacts were generated into fresh
paths before replacing tracked fixtures; existing source metadata was preserved.
The documented runtime, dynamic SQL, cross-owner privilege review, unsupported
source variants, and compilation-cycle limits remain intentional scope boundaries.
