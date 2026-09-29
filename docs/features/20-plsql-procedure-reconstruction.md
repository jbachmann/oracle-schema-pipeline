# Feature: Reconstruct explicitly selected PL/SQL procedures

- Status: Superseded — do not implement separately
- Date: 2026-09-28
- Superseded by: [Feature 21](21-explicit-program-dependency-reconstruction.md).
- Request: Extract named standalone and packaged PL/SQL procedures from Oracle,
  then recreate them through generated SQL and the existing local clone/retry flow.

> **Implementation entry point: feature 21.** This feature was not implemented
> before its scope was expanded. Do not schedule a separate feature-20 implementation
> or release its intermediate contract. Its requirements remain part of feature 21
> by reference, except where feature 21 explicitly replaces them. Keep this document
> as supporting design detail; superseded does not mean its procedure functionality
> or unchanged validation/test requirements were canceled.

## Context and Scope

Given an `objects.json` containing procedure selections and manually identified
table/view dependencies, extraction captures the selected executable definitions.
Transformation preserves them, offline validation gates SQL generation, and
destination replay creates and verifies the programs without invoking them.

Requester decisions, confirmed 2026-09-28:

- Selecting a public packaged procedure includes the entire package specification
  and body, including other routines, overloads, helpers, state, and initialization.
- Dependencies remain explicitly selected or externally provisioned. Procedure
  selection does not recursively discover additional objects to export.
- Explicit destination grants are supported. Put these in `policy.json`, because
  permissions are target policy rather than facts about source selection.
- Extend generated SQL, `db:clone`, and `db:clone-retry`; do not add arbitrary
  destination connections or deployment management.
- Advance the source/target format and require re-extraction of older artifacts.

Affected stages: extract, transform, validate, generate, and the existing
destination orchestration boundary. Source access remains read-only. Users must
list dependencies of the **whole package**, not merely the selected member.
Existing one-hop table FK expansion and recursive view expansion remain unchanged.

The first implementation supports readable, valid PL/SQL standalone procedures
and packages in ordinary application schemas, preserving exact owner/name and
program text. A packaged selection addresses a public procedure by name and selects
all its overloads. Private-only members and functions are not selection roots;
functions and private routines inside an included package are preserved.
Procedure-only selections, with empty table/view arrays, are allowed.

Excluded: standalone function extraction, triggers, sequences, synonyms, object
types, external-language call specifications, wrapped source, edition-based
deployment, ownership remapping, automatic privilege inference, application data,
and automatic execution of selected routines. Unsupported variants fail explicitly.
External objects of supported prerequisite types may still be provisioned by users.
This is a compilation/reconstruction feature, not a proof of runtime correctness.

### Oracle example and inputs

Assume APP and REPORTING already have the source privileges needed to compile:

```sql
CREATE TABLE APP.ORDERS (ID NUMBER PRIMARY KEY, STATE VARCHAR2(20));
CREATE VIEW APP.OPEN_ORDERS AS
  SELECT ID FROM APP.ORDERS WHERE STATE = 'OPEN';

CREATE PROCEDURE APP.CLOSE_ORDER(P_ID NUMBER) AS
BEGIN
  UPDATE APP.ORDERS SET STATE = 'CLOSED' WHERE ID = P_ID;
END;
/

CREATE PACKAGE REPORTING.ORDER_API AS
  PROCEDURE COUNT_OPEN(P_COUNT OUT NUMBER);
END;
/
CREATE PACKAGE BODY REPORTING.ORDER_API AS
  PROCEDURE COUNT_OPEN(P_COUNT OUT NUMBER) AS
  BEGIN
    SELECT COUNT(*) INTO P_COUNT FROM APP.OPEN_ORDERS;
  END;
END;
/
```

`objects.json`:

```json
{
  "version": 3,
  "tables": [{ "owner": "APP", "name": "ORDERS" }],
  "views": [{ "owner": "APP", "name": "OPEN_ORDERS" }],
  "procedures": [
    { "owner": "APP", "name": "CLOSE_ORDER" },
    { "owner": "REPORTING", "package": "ORDER_API", "name": "COUNT_OPEN" }
  ]
}
```

`policy.json`:

```json
{
  "version": 2,
  "createSchemas": true,
  "defaultTablespace": "USERS",
  "maxStringSize": "STANDARD",
  "externalPrerequisites": [],
  "objectGrants": [
    {
      "reference": { "owner": "APP", "name": "OPEN_ORDERS" },
      "type": "VIEW",
      "grantee": "REPORTING",
      "privileges": ["SELECT"]
    }
  ]
}
```

Expected result: the table and view are recreated first; the explicit SELECT
grant precedes compilation of the dependent package body. Exactly one standalone
procedure, one package specification, and one package body are created. All three
program objects must exist with status VALID and no compilation errors. No call
to CLOSE_ORDER or COUNT_OPEN occurs during extraction or ordinary replay.

## Research Findings

### Verified repository behavior

- `src/model.ts` currently requires source/target format 5, selection version 2,
  and policy version 1. Selection contains exact owner/name references for tables
  and views. Unknown fields fail validation.
- `src/extract.ts` has optional view capabilities on `SourceCatalog`, preserves
  selection provenance, and does not currently read program source.
- `src/catalog-reader.ts`, `src/catalog-queries.ts`, `src/catalog-schemas.ts`,
  and `src/catalog-decoding.ts` provide scoped ALL/DBA queries, bound selections,
  strict decoding, result-set cleanup, and bounded batching. Metadata must not be
  fetched with `DBMS_METADATA.GET_DDL`.
- `src/semantic.ts` orders views and checks closure; `src/validate.ts` and
  `src/prepare.ts` jointly validate semantics and renderability. `src/generate.ts`
  independently validates before joining prepared SQL. Physical SQL*Plus lines
  are limited to 2,400 UTF-8 bytes by `src/sql-preparation.ts`.
- `src/prepare.ts` currently emits tables, comments, indexes, constraints, grants,
  FKs, and views. `src/index-grants.ts` derives index-specific EXECUTE grants;
  view and FK grants also already exist. These behaviors must remain intact.
- `scripts/clone-workflow.ts` runs prerequisite SQL before all generated SQL.
  Therefore that hook cannot grant access to a selected table created later.
  Explicit policy grants must be scheduled inside generated SQL.
- `scripts/compose-destination.ts` verifies tables/views/indexes, not programs.
  It and its tests recognize an exact format-5 SQL preamble, which must change
  together with format version and the now-inaccurate no-source-DDL claim.
- External prerequisites currently require `createSchemas=false`; local clone
  requires prerequisite SQL for this mode and verifies prerequisites before replay.
  Preserve these existing rules.
- `src/dictionary.ts` produces a relational workbook. Full program listings are
  not needed in XLSX and would encounter cell limits. The authoritative source
  program artifact will be JSON.
- The working tree was clean before planning. Highest feature prefix was 19.

### Primary Oracle documentation

Accessed 2026-09-28; documentation is design evidence, not a substitute for testing
the repository's pinned Oracle image:

- [ALL_SOURCE](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_SOURCE.html):
  source is available by owner, name, object type, and numbered text rows; package
  specification and body are distinct types. DBA_SOURCE supplies DBA scope.
- [ALL_PROCEDURES](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_PROCEDURES.html)
  and [ALL_ARGUMENTS](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_ARGUMENTS.html):
  members have subprogram/overload identity. Argument position zero identifies a
  function return; no-argument procedures may have no argument rows. Recent
  IS_PROCEDURE/IS_FUNCTION columns are release-dependent and cannot be assumed
  for every source database.
- [CREATE PACKAGE BODY](https://docs.oracle.com/en/database/oracle/oracle-database/26/lnpls/CREATE-PACKAGE-BODY-statement.html):
  the body is a stored compilation unit, not a separately deployable member.
- [ALL_DEPENDENCIES](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_DEPENDENCIES.html)
  records program dependencies and database-link references.
  [Database Development Guide](https://docs.oracle.com/en/database/oracle/oracle-database/26/adfns/database-development-guide.pdf)
  explains that dynamic SQL does not establish those dependencies.
- [Stored-program privileges](https://docs.oracle.com/en/database/oracle/oracle-database/26/adfns/coding-subprograms-and-packages.html):
  compilation requires necessary object privileges directly; role membership alone
  is insufficient. Cross-schema creation requires appropriate executor authority.
- [ALL_PLSQL_OBJECT_SETTINGS](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_PLSQL_OBJECT_SETTINGS.html)
  exposes per-unit compiler settings, including conditional flags and length
  semantics. These can differ between a package specification and body.
- [DBMS_SQL.PARSE](https://docs.oracle.com/en/database/oracle/oracle-database/26/arpls/DBMS_SQL.html)
  accepts CLOB statements larger than 32 KiB; parsing DDL executes it. This permits
  bounded SQL*Plus transport without inserting line breaks into program text.

Design inference: complete compilation units can be transported as trusted source
fragments with catalog identity and settings, while retaining offline stages.
A small declaration-header lexer is needed to bind source to modeled identity;
a general PL/SQL parser or member-slicing engine is neither required nor proposed.
Pinned-image probes must establish the precise catalog header and newline behavior.

## Decisions and Boundaries

### Selection and compatibility

- Add strict selection version 3: `tables`, `views`, and `procedures` default to
  empty arrays; their combined length must be positive. Each procedure entry is
  a strict union of `{owner, name}` and `{owner, package, name}` using the existing
  identifier validator. No dotted-name parsing, case folding, or wildcards.
- Continue accepting strict version-2 table/view selections, normalized internally
  to empty procedures. Version 2 must reject a `procedures` field. Deduplicate
  exact selections and sort by ordinal tuples, distinguishing standalone/member
  selection. Repeated members from the same package yield one spec/body pair.
- Introduce strict policy version 2 with `objectGrants`; retain version-1 input
  compatibility with no explicit grants. Normalize accepted policy input to v2
  inside v6 targets. Version-1 inputs reject the new field rather than ignoring it.
- Source/target `formatVersion` becomes 6. Older documents and saved retry bundles
  fail with re-extraction guidance before destination reset. No relabeling or
  automatic artifact migration. Completion manifest and clone configuration
  versions need not change; their payload contracts remain the same.

### Dependency boundary

Record dependencies of every included compilation unit, including unselected
members of a package. Satisfy local TABLE/VIEW edges through the existing included
relational slice; otherwise report the exact missing dependency and tell the user
to add it to `objects.json`. Procedure selection never adds a table/view itself.
Existing relational expansion can already have included a needed object.

Local PROCEDURE/PACKAGE edges resolve to explicitly selected units or exact
`externalPrerequisites` entries. Other supported external types, such as FUNCTION,
SEQUENCE, SYNONYM, and TYPE, require explicit acknowledgment and provisioning.
Do not silently treat a synonym as its base object. Reject database-link edges,
unknown dependency types, and contradictory type identities. Preserve self edges
as facts but exclude legitimate self-recursion and body-to-own-spec edges from
cycle detection. User-defined missing objects are never exempted by name alone.

Record Oracle-maintained dependencies separately as catalog facts and treat them
as destination platform prerequisites, using verified owner metadata rather than
a blanket SYS/PUBLIC name exemption. They do not trigger extraction or redundant
external provisioning requests. Their availability/privileges remain subject to
destination compilation. Failure to read required classification metadata fails
closed; do not interpret absence as platform ownership.

Dynamic SQL and invoker-specific runtime privileges remain the user's
responsibility. Do not run application code to discover dependencies. Catalog
visibility cannot prove the absence of all hidden/runtime dependencies; document
this limit rather than claiming complete dependency analysis.

### Explicit grants

`policy.objectGrants` defaults to `[]`. Each strict entry has:

| Field | Contract |
| --- | --- |
| `reference` | Exact `{owner, name}` of the granted object |
| `type` | TABLE, VIEW, PROCEDURE, PACKAGE, FUNCTION, SEQUENCE, or TYPE |
| `grantee` | Exact schema name; must be an included object owner |
| `privileges` | Nonempty enum array; allowed combinations below |

Allowed pairs: TABLE/VIEW with SELECT, INSERT, UPDATE, DELETE; SEQUENCE with
SELECT; PROCEDURE/PACKAGE/FUNCTION/TYPE with EXECUTE. No roles, PUBLIC grants,
system privileges, column-specific grants, grant options, or synonym targets.
Grant to the resolved base object when code uses a synonym. REFERENCES grants
continue to use existing FK behavior.

The object must exist in the model or be an acknowledged external prerequisite.
Reject wrong object types, missing objects/grantees, and self-grants. Deduplicate
and deterministically sort repeated privilege tuples, including overlap with
existing synthesized grants. Do not provision unrelated schemas just because
they occur as grantees. Report each effective explicit grant as
`EXPLICIT_OBJECT_GRANT` with exact privilege/object/grantee.

Do not infer DML privileges from dependency edges. Offline validation checks the
declared grant's shape and applicability, not its sufficiency for arbitrary code.
Destination compilation is the authoritative check for missing direct privileges.
Existing prerequisite SQL may also supply privileges on external objects; it is
not parsed or treated as proof. Replay must already have grant/creation authority.

## Proposed Design

### Version-6 program contract

Keep existing relational fields. Add these required arrays to source and target:

- `targetProcedures`: canonical procedure selections from version-3 input.
- `programUnits`: compilation units; no implicit defaults when reading v6 JSON.

Each strict program-unit object contains:

| Field | Meaning |
| --- | --- |
| `reference` | Exact owner/name of standalone procedure or containing package |
| `type` | PROCEDURE, PACKAGE, or PACKAGE BODY |
| `sourceLines` | Nonempty ordered `{line, text}` array; positive contiguous line numbers from 1; exact text, without trimming or inserted newlines |
| `status` | Catalog VALID or INVALID; INVALID blocks generation |
| `editionable` | Catalog boolean; preserve declaration attribute |
| `editionName` | Nullable catalog edition identity; non-null edition-based objects are unsupported initially |
| `authid` | DEFINER or CURRENT_USER on procedure/specification; null on body, which inherits the specification |
| `members` | Public subprogram metadata for PACKAGE only; empty otherwise |
| `dependencies` | Exact reference, type, nullable databaseLink, and `oracleMaintained` boolean for each edge |
| `compilerSettings` | Per-unit settings specified below |
| `unsupportedFeatures` | Explicit observed unsupported facts; nonempty blocks generation |

Member records contain `name`, positive `subprogramId`, nullable `overload`, and
`kind: 'procedure' | 'function'`. Match package selections against procedure
members; function-only and private-only names fail. Do not reconstruct signatures
from argument metadata: exact source owns signatures and defaults. Use complete
scoped PROCEDURES plus ARGUMENTS reads to classify return-bearing members without
requiring recent dictionary columns. Verify zero-argument procedures explicitly.

`compilerSettings` contains `plsqlOptimizeLevel` (integer 0..3), `plsqlCodeType`
(INTERPRETED/NATIVE), `plsqlDebug` (boolean), `plsqlWarnings` (string),
`nlsLengthSemantics` (BYTE/CHAR), `plsqlCcflags` (nullable string), and
`plscopeSettings` (string). Also capture `plsqlImplicitConversionBool` as nullable
boolean, with null meaning the column is unavailable on that source release.
Determine optional column availability with a read-only dictionary capability
query, never by defaulting a failed query to empty data.

Preserve conditional flags, length semantics, optimization, debug, and available
implicit-conversion semantics during compilation. Normalize target code type to
INTERPRETED, warnings to ENABLE:ALL, and PL/Scope to IDENTIFIERS:NONE; report these
intentional setting changes as `PROGRAM_COMPILER_POLICY`. Source facts stay intact.
For unavailable implicit-conversion metadata, use the documented legacy-disabled
behavior only after a pinned-image/source-version probe verifies it; otherwise
block that source version with `UNSUPPORTED_PROGRAM_SETTINGS`. Never silently
guess a semantics-affecting setting. Reject unrecognized setting values.

The target retains the source settings; rendering applies the fixed target
compiler policy. Do not add copied connection credentials or raw catalog errors.
Program source is trusted application content and must not be echoed into progress
or error logs. Operators must not select credential-bearing source for export;
automatic detection/redaction of embedded application secrets is not promised.

### Extraction and source fidelity

Add optional `SourceCatalog.programUnits(selections)` capability so table/view-only
custom catalogs keep working. A nonempty procedure selection requires the capability
before extraction proceeds. Implement it in new `src/catalog-programs.ts`, wired
through `src/catalog.ts` and the shared reader.

Use ALL/DBA OBJECTS, SOURCE, PROCEDURES, ARGUMENTS, DEPENDENCIES, and
PLSQL_OBJECT_SETTINGS with bound exact identities and object types. Require exactly
one selected standalone unit, or one specification and one body per selected
package. Missing body/source/member visibility is an error, not an empty package.
Validate rows before assembly, preserve blank lines (nullable catalog TEXT maps
only to empty text), and detect duplicate/gapped line and member identities.
Read source rows in pages and batch distinct unit reads with existing bounded
reader mechanisms. No per-line execute calls, source recompilation, or procedure
invocations. Retain spec/body separation in cache and query keys.

Cross-check object ID, LAST_DDL_TIME, status/type, and compiler metadata before and
after reading a unit to detect obvious concurrent DDL; this is not a consistent
database snapshot. Keep these read guards internal, not persisted model fields.
Capture complete source, including comments, literals, conditional directives,
AUTHID, and initialization. Parse only enough lexical structure to verify the
declaration's kind/name and qualify its top-level identity for output. Handle
quoted identifiers and comments; reject ambiguous headers, wrapped units, and
external call specifications. Do not perform global text replacement.

### Semantic analysis and ordering

Add `src/programs.ts` for program identity, root/member coverage, dependency
resolution, namespace collisions, unsupported-feature checks, and deterministic
compilation ordering. Extend `src/semantic.ts`/`src/validate.ts` to consume it once.
Use `(owner, name, type)` keys: PACKAGE and PACKAGE BODY intentionally share a name;
tables, views, standalone procedures, and package specifications may not collide.
Every included unit must be authorized by a root; every package must have one
matching spec/body pair. Revalidate all of this for hand-authored target documents.

Retain existing relational phases. Then topologically order specifications and
standalone procedures by their local program dependencies, followed by package
bodies. Dependencies on a package resolve to its specification for compilation;
all included bodies must still be valid by completion. Sort ties ordinally by
owner/name/type. Support self-recursion and mutually calling package bodies when
their specification graph is acyclic. Reject remaining compilation cycles with
`PROGRAM_DEPENDENCY_CYCLE`; do not generate stubs or retry invalid compilation.

Explicit grants on tables/views/external prerequisites run after relational
creation and before the first program unit. EXECUTE grants on selected units run
after the referenced procedure/specification exists and before dependent units.
Do not require package bodies before granting EXECUTE on a package specification.
Add program owners to `src/schema-owners.ts` for creation and setup checks.

The current relational pipeline cannot create a table/index/view that first needs
a newly selected package. Detect such backward dependencies before rendering and
report `UNSUPPORTED_PROGRAM_ORDER`. Do not misclassify a selected package as an
external prerequisite to bypass this. Supporting arbitrary mixed relational/program
cycles is a separate feature; independently provisioned external packages retain
the current supported path. Existing unsupported program-dependent views remain
unsupported. External prerequisites must not also claim a selected program identity.

### SQL transport, compilation, and verification

Add `src/program-ddl.ts`. Construct CREATE PROCEDURE/PACKAGE/PACKAGE BODY from the
validated top-level declaration and exact remaining source. Fully qualify the
declared owner/name, preserve editionability, and use CREATE without OR REPLACE
or IF NOT EXISTS so conflicting destination program objects fail visibly.

Transport the complete statement in bounded escaped string chunks into a temporary
CLOB, then call DBMS_SQL.PARSE once. Never execute that DDL a second time through
DBMS_SQL.EXECUTE. Encode source newlines as concatenated character values so slash
lines or SQL*Plus-looking text inside comments/literals cannot become client
commands. Chunk by Unicode characters while respecting escaped UTF-8 byte limits;
preserve literal/comment whitespace and support units larger than 32 KiB.
Close cursors and free temporary LOBs on success and failure. Do not create a
persistent helper procedure. Apply and restore per-unit session compiler settings,
including exception paths, so one unit does not inherit another's conditional flags.
The existing 2,400-byte physical-line preflight applies to every wrapper line.

After creation, generated SQL checks exact identity/type in ALL_OBJECTS and
compilation errors in ALL_ERRORS, raising an application error for missing/invalid
units or errors. Check all units again before the completion prompt, since later
DDL can invalidate earlier units. Compilation warnings alone are not failure.
Do not rely solely on SQL*Plus exit behavior or SHOW ERRORS. Use safe object/type
and error-code diagnostics, not source-bearing compiler message text.

Extend destination verification with equivalent DBA_OBJECTS/DBA_ERRORS checks,
selected public procedure existence, and explicit direct-grant checks. Inferred
grant deduplication must not suppress verification. No business procedure is called
in operational verification; behavior probes belong only in disposable tests.

Change the generated preamble to a truthful versioned description, for example
`-- Generated from oracle-schema-pipeline format 6. Catalog definitions and selected PL/SQL source.`
Update exact replay recognition, retry validation, and fixtures together.
`db:clone-retry` reuses checked generated bytes as today; it does not regenerate,
reconnect to source, or reinterpret current policy in place of the saved target.

### Diagnostics and failure behavior

| Code | Failure/action |
| --- | --- |
| Existing CATALOG_* codes | Missing/inaccessible source, duplicate/gapped rows, unknown catalog values; abort extraction, publish no source |
| `PROCEDURE_SELECTION_NOT_FOUND` | Standalone or public procedure name cannot be resolved; correct selection/visibility |
| `INVALID_PROGRAM` | Source unit INVALID; fix source before extraction/replay |
| `UNSUPPORTED_PROGRAM` | Wrapped, external-language, edition-based, or otherwise unsupported program |
| `UNSUPPORTED_PROGRAM_SETTINGS` | Compiler behavior cannot be faithfully represented |
| `PROGRAM_SOURCE_IDENTITY` | Source declaration disagrees with modeled identity/type |
| `PROGRAM_SELECTION_MISMATCH` | Missing/extra unit, missing spec/body, or invalid member root |
| `MISSING_PROGRAM_DEPENDENCY` | Required local table/view absent; list the object explicitly |
| Existing UNACKNOWLEDGED_PREREQUISITE / REMOTE_PREREQUISITE | Missing external acknowledgment or unsupported remote edge |
| `UNSUPPORTED_PROGRAM_DEPENDENCY` | Unsupported/ambiguous dependency type |
| `PROGRAM_DEPENDENCY_CYCLE` / `UNSUPPORTED_PROGRAM_ORDER` | Unsupported compilation graph/order |
| `INVALID_OBJECT_GRANT` | Unsupported privilege/type, unresolved object/grantee, or self-grant |
| Existing OBJECT_NAME_COLLISION / SQL_LINE_LIMIT | Namespace conflict or unrenderable physical SQL |
| `PROGRAM_COMPILATION_FAILED` | Generated destination assertion marker for invalid/missing unit or compile errors |

Use `EXPLICIT_OBJECT_GRANT`, `PROGRAM_COMPILER_POLICY`, and
`INCLUDE_WHOLE_PACKAGE` change entries for reviewable grant/settings/package scope.
The latter lists selecting member names and the containing package, without source.
Allowlist new extraction error codes/categories in `src/progress.ts`; keep event
version 1 and document the additive literals. No raw source, binds, or driver
messages enter progress. Validation/transform semantic failures retain exit 2;
generation failure retains exit 1. Clone retains its existing replay/verification
stage error codes, with safe program context where available.

### Architecture and artifact guarantees

Add a new ADR under `docs/adr/` using the next available number at implementation
time. Explicitly supersede ADR 0001's stored-program exclusion, format statement,
and any blanket interpretation that no stored source is replayed. Authorize exact
program source as trusted catalog fragments with bounded header handling; continue
to prohibit DBMS_METADATA-based schema DDL extraction.

All other invariants remain: unchanged source facts, offline later stages, explicit
selection, reported changes, independent generation validation, deterministic
ordering, secret exclusion, and non-overwriting atomic artifact publication.
ADR 0008 still limits operational destination writes to the fixed local Compose
destination. No new source or remote destination write authority is introduced.
Do not invoke package initialization during creation/verification. Existing trusted
SQL is not a sandbox, and compilation is not a runtime behavior guarantee.

## Implementation Plan

1. Run bounded catalog/replay probes on the **test** Compose project using its
   existing helpers. Verify source headers/newlines, no-argument and overloaded
   members, ALL visibility of package bodies, compiler-settings availability,
   CLOB DDL, compilation-error signaling, and quoted-owner name resolution. Record
   results; if a design assumption fails, revise the plan rather than approximating.
2. Add the ADR and contracts in `src/model.ts`; update fixtures and example
   artifacts to v6. Implement explicit v2-selection/v1-policy input compatibility
   at CLI/config boundaries in `src/cli.ts` and `scripts/clone-config.ts`.
3. Implement `src/catalog-programs.ts` (new), scoped query definitions/decoders,
   optional catalog capability, extraction assembly, dependency classification,
   progress literals, and bounded reads in the existing catalog modules.
4. Implement `src/programs.ts` (new), integrate root/namespace/dependency/order
   checks into semantic analysis and validation, and preserve source immutability
   in `src/transform.ts`. Add whole-package and compiler-policy report entries.
5. Add `src/object-grants.ts` (new) for typed grant validation, ordering, rendering,
   and deduplication with `src/index-grants.ts` and existing view/FK grants.
   Update schema owner discovery and explicit grant reporting.
6. Add `src/program-ddl.ts` (new), then integrate its prepared operations and
   validity assertions into `src/prepare.ts`. Preserve `src/sql-preparation.ts`,
   `src/validate.ts`, and `src/generate.ts` validation direction and publication gates.
7. Extend `scripts/compose-destination.ts` verification/replay, retry compatibility
   errors in `scripts/clone-retry-input.ts`, and safe workflow error context in
   `scripts/clone-workflow.ts`. Fail old bundles before reset.
8. Update README selection/policy/examples, source access requirements, feature
   limits, grant timing, compilation guarantees, and re-extraction instructions.
   Add `examples/objects.json`; update existing v6 example artifacts consistently.
   Update `src/dictionary.ts` Overview with selected procedure/program-unit counts
   and state that program definitions live in JSON; keep relational worksheets
   and their escaping/size rules unchanged.
9. Complete unit/CLI/integration coverage below. Mark this feature implemented
   only after pinned-image results establish catalog fidelity and destination behavior.

## Test Plan

Use existing node:test conventions and add focused `test/programs.test.ts`,
`test/catalog-programs.test.ts`, `test/program-ddl.test.ts`,
`test/object-grants.test.ts`, and `test/integration/programs.test.ts`.
These are proposed new files; other paths below already exist.

- `test/model.test.ts`, `test/clone-config.test.ts`: version-3 selection and v2
  policy, old selection/policy acceptance, strict old-version new-field rejection,
  unknown fields, empty selection, procedure-only selection, exact quoted names,
  malformed grants, and mandatory v6 fields.
- `test/extract.test.ts`, catalog tests, `test/helpers/catalog-connection.ts`:
  standalone plus packages, duplicate package selections, overloads, no-argument
  members, function/private-name rejection, missing body, restricted visibility,
  ALL/DBA scope, paged source, duplicate/gapped/null rows, unknown flags, and cleanup
  after decoder failures. Assert no source DDL/procedure execution and no expansion
  of procedure dependencies. Test batch sizes 1/default for identical semantic data.
- `test/validate.test.ts`, `test/prepare.test.ts`, `test/pipeline.test.ts`:
  source immutability, deterministic ordering, missing/extra units, invalid status,
  source/header mismatch, namespace collisions, external prerequisites, platform
  dependencies, cycles versus legal self-recursion/body calls, backward dependencies,
  grant timing/deduplication, and independent generation revalidation of forged input.
- Renderer tests: quoted/Unicode names, comments, apostrophes, alternative quotes,
  blank lines, slash-only lines inside multiline literals, SQL*Plus-looking text,
  2,400-byte boundaries, source lines longer than that limit, and units over 32 KiB.
  Assert reconstructed source text remains exact apart from the qualified header.
  Verify settings restoration and cursor/LOB cleanup on failures in Oracle tests.
- `test/progress.test.ts`, `test/progress-cli.test.ts`,
  `test/publication-cli.test.ts`: safe event categories/errors, no source leakage,
  no output on extraction/preflight failure, non-overwrite behavior, and v6 bundles.
- `test/compose-destination.test.ts`, `test/clone-workflow.test.ts`,
  `test/clone-retry-input.test.ts`, `test/clone-retry-cli.test.ts`: new preamble,
  saved v6 replay without source, rejection of v5 before reset, program-owner setup,
  missing/invalid spec/body detection, and exact explicit-grant verification.
- Extend `test/docker/oracle/source-init/01-seed.sql` and relevant cleanup helpers
  under `test/scripts/` only for the explicit seeded test project. Add readable
  standalone/package fixtures, private helper and extra public function, overloads,
  conditional flags, initialization side effects, cross-schema table/view DML,
  inter-program EXECUTE, and one externally provisioned sequence/function.
- Grant the restricted fixture reader only read visibility needed for selected
  program metadata; prove extraction does not inherit administrative privileges or
  invoke the programs. A reader with hidden package-body metadata must fail.
- `test/integration/independent-facts.ts`,
  `test/integration/oracle-roundtrip.test.ts`, new program integration tests:
  retain exporter equality but independently query source/destination SOURCE,
  PROCEDURES, OBJECTS, ERRORS, settings, and TAB_PRIVS against seed expectations.
  Check a program-only schema, definer/invoker AUTHID preservation, all package
  members, and no initialization execution during ordinary replay.
- On disposable destination only, call seeded standalone and packaged procedures
  as suitable non-SYS callers, check returned values and DML, and roll back test
  changes. Prove initialization occurs on invocation rather than deployment.
  Remove a required explicit grant to show compilation fails; add an unrelated
  role grant to show it does not substitute for a direct privilege. Test warnings
  versus errors, tampered source, wrong settings, and existing-object collisions.
- `test/integration/local-clone.test.ts`: end-to-end local clone/retry containing
  procedures, package verification failure, and unchanged source facts. Never
  use or adopt legacy/root-project Docker resources.
- `test/dictionary.test.ts`: v6 and procedure-only inputs generate a valid workbook
  with accurate Overview counts and no full source-cell truncation.

Validation commands verified against `package.json` (run during implementation):

```sh
npm run typecheck
npm test
npm run build
npm run schema -- --help
npm run test:integration
```

Run integration tests against the provisioned seeded test Compose environment;
do not run operational `db:clone` as a planning or test shortcut. This planning
change itself requires document/path review, not a database reset or test-suite run.

## Acceptance Criteria

- [ ] The example selects and recreates one standalone procedure and a complete
  package; selecting multiple members emits the package only once.
- [ ] No table/view/program is automatically added because a procedure references
  it; existing table/view expansion remains unchanged.
- [ ] Exact source semantics, names, AUTHID, package state/initialization, overloads,
  and supported compiler settings survive round-trip; changes are reported.
- [ ] Policy grants run at the necessary creation boundaries and are checked as
  direct destination privileges; unrelated source grants are not copied.
- [ ] Missing/invalid programs, inaccessible metadata, unsupported variants,
  unresolved dependencies, and unsupported ordering fail with stable diagnostics.
- [ ] Procedure-only schemas work; program bodies larger than 32 KiB and long
  physical source lines are transported without truncation or semantic rewriting.
- [ ] Generated SQL and local clone cannot report success with a missing/invalid
  selected program, package specification, package body, or explicit grant.
- [ ] No selected routine or package initialization is invoked by extraction,
  generation, replay verification, or retry.
- [ ] Version-2 selections and version-1 policies remain usable; old source/target
  artifacts and retry bundles require re-extraction and fail before destination reset.
- [ ] Source reads stay read-only, offline stages stay offline, source artifacts
  remain unchanged, generation independently validates, and outputs never overwrite.
- [ ] Unit/CLI tests and independent Oracle catalog/behavior tests pass, including
  restricted visibility and failure cases. README, examples, and ADR are updated.

## Risks and Open Questions

No requester scope decisions remain open. Technical verification gates remain:

- ALL catalog source/body visibility and release-dependent metadata need pinned
  source-version probes; do not promise support for untested Oracle releases.
- Header qualification and CLOB transport require lexical and byte-accurate tests;
  they must not become general source rewriting or change literal contents.
- Compiler settings and conditional code referencing database-version constants
  can change behavior across releases even when user flags are preserved. The
  destination remains Oracle 23; compilation and fixture behavior are bounded
  evidence, not cross-version application equivalence.
- Package-wide inclusion can introduce substantial source and additional
  dependencies. Scope expansion is explicit and reported but may require users
  to adjust selections/prerequisites before generation can succeed.
- Dynamic SQL, invoker rights, runtime environment, and application data can still
  cause failures after successful compilation. Users supply those dependencies.
- Program-dependent relational objects, edition-based deployment, wrapped units,
  and unsupported cycles fail closed instead of receiving incomplete support.
- Destination DDL commits and failed replay can leave partial state, as today.
  Retry retains the existing disposable reset behavior, not transactional rollback.
