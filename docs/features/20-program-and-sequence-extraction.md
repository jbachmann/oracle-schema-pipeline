# Feature: Extract and clone selected PL/SQL programs and sequences

- Status: Implemented and verified
- Date: 2026-09-29
- Request: Select packages, standalone procedures, standalone functions, and sequences in objects.json and recreate them through clone.sql.
- Approval: Requester accepted the recommendations below on 2026-09-29.

## Context and Scope

Given explicitly named source objects, extraction captures package specifications
and existing bodies, standalone procedures/functions, and sequence definitions.
Program DDL comes from DBMS_METADATA and is preserved through the offline stages
into clone.sql. Sequences use catalog metadata and a dedicated SQL renderer.
The existing local clone workflow applies the generated script to its fixed
disposable destination; this feature does not introduce a remote deployment tool.

All four pipeline stages are affected, together with selection parsing, schema
provisioning, progress, retry compatibility, and destination verification.

Approved boundaries:

- Programs and sequences are explicitly selected. Their dependencies do not expand
  extraction. Existing one-hop table FK and recursive table/view dependency rules
  remain in place. Unselected dependencies are external prerequisites.
- Selecting a package includes its specification and its body when one exists.
- Preserve owner names and program text; do not remap schemas or rewrite PL/SQL.
- Preserve supported sequence configuration, but reset ascending sequences to
  their minimum and descending sequences to their maximum. Neither current
  position nor a historical custom START WITH value is preserved.
- Fail cloning if any selected program remains invalid after final compilation.
  Compilation success is not a claim about runtime behavior.
- Existing table/view selection files remain accepted. Older source/target
  artifacts require re-extraction after the document format change.

Excluded: application rows, triggers, type definitions, synonyms, jobs, automatic
grant/security-policy export, source compilation or execution, recursive program
dependency export, SQL parsing, and full runtime/environment reproduction.

## Research Findings

### Verified repository facts

- `src/model.ts` uses selection version 2, document format 5, and policy version 1.
  Selection currently accepts only tables/views and requires at least one of them.
- `src/extract.ts` separates Oracle access behind SourceCatalog; all later stages
  are offline. `src/catalog-reader.ts`, `src/catalog-queries.ts`, and
  `src/catalog-schemas.ts` provide scoped ALL/DBA reads and strict decoding.
- `src/semantic.ts` limits view dependencies to tables/views. Its namespace,
  reachability, and ordering checks currently know only those definitions.
- `src/validate.ts` requires external prerequisite acknowledgement;
  `src/index-grants.ts` currently treats even selected function/package candidates
  as external. These checks must recognize newly included definitions.
- `src/prepare.ts` creates tables before indexes and views. Programs needed by
  table expressions, function-based indexes, or views require revised ordering.
- `src/sql-preparation.ts` rejects physical SQL lines over 2,400 UTF-8 bytes.
  This limit applies to captured program DDL without rewrapping it.
- `src/schema-owners.ts` and `scripts/compose-destination.ts` enumerate existing
  object kinds. The latter also recognizes an exact format-5 SQL preamble saying
  no source DDL was replayed. Retry consumes this same boundary.
- ADR 0001 explicitly forbids DBMS_METADATA.GET_DDL and excludes programs and
  standalone sequences. A narrowly superseding ADR is required.
- Working tree was clean at discovery. Highest existing feature number was 19.

### Primary documentation

References accessed 2026-09-29; documented behavior still needs verification on the
repository's pinned Oracle image during implementation.

- [DBMS_METADATA](https://docs.oracle.com/en/database/oracle/oracle-database/26/arpls/DBMS_METADATA.html):
  GET_DDL returns CLOB data. PACKAGE_SPEC and PACKAGE_BODY permit separate reads;
  PACKAGE normally includes both. SQLTERMINATOR controls emitted terminators.
  Cross-owner metadata access requires the API's privileges, independently of
  ordinary object grants; SYS and SELECT_CATALOG_ROLE are privileged callers.
- [ALL_SEQUENCES](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_SEQUENCES.html):
  exposes bounds, increment, cache and behavior flags. LAST_NUMBER can reflect
  cached allocation rather than the last value used; it is not clone position.
- [CREATE SEQUENCE](https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/CREATE-SEQUENCE.html):
  omitted START WITH defaults to the minimum for ascending sequences and maximum
  for descending sequences. Sequence numbers can exceed JavaScript safe integers.
- [Procedure compilation errors](https://docs.oracle.com/en/error-help/db/sp2-00827/):
  creation can leave a stored procedure with compilation errors.
  [ALTER PROCEDURE](https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/ALTER-PROCEDURE.html)
  supports explicit recompilation, requiring owner authority or ALTER ANY PROCEDURE.
- [node-oracledb 6.10 LOB handling](https://node-oracledb.readthedocs.io/en/v6.10.0/user_guide/lob_data.html):
  per-query CLOB-to-string fetching avoids a small VARCHAR2 conversion and global
  driver setting changes.

Design inference: emitting all programs at the end is insufficient when a selected
function is required by an index or view. Explicit operation dependencies and a
final selected-object compilation/validity check are needed.

## Decisions and Boundaries

Keep source access read-only. Metadata session transform settings are permitted,
but never call source NEXTVAL, compile source objects, or invoke selected programs.
No source credentials appear in destination subprocesses or generated artifacts.

Retain the trusted SQL-fragment boundary: program DDL is trusted executable input,
not sandboxed or statically proven safe. Preserve it without redaction or rewriting;
operators must not select programs containing embedded credentials for publication.
Diagnostics/progress must not echo program text or arbitrary driver messages.

Do not silently omit an inaccessible body. Confirm package/body existence with
complete metadata visibility, then require every expected DDL read to succeed.
If visibility cannot establish completeness, fail with an actionable metadata error.
Do not elevate privileges or fall back from DBMS_METADATA to source-text assembly.

External prerequisite acknowledgement is not provisioning. Keep the existing
policy and prerequisiteSql workflow, including its createSchemas=false requirement
when external prerequisites are declared. Remote dependencies remain rejected.
Standard Oracle-maintained dependencies are recorded as such and do not cause
recursive extraction; platform availability/privileges remain destination concerns.

## Proposed Design

### Selection and document contract

Extend strict selection version 2 additively with optional `packages`, `procedures`,
`functions`, and `sequences`, each defaulting to an empty array of exact
`{owner, name}` references. Preserve tables/views defaults. Require at least one
reference across all six arrays. Deduplicate within each kind and reject shared
namespace collisions across kinds. Older binaries reject the new keys explicitly.

```json
{
  "version": 2,
  "tables": [],
  "views": [],
  "packages": [{ "owner": "APP", "name": "COUNTER_API" }],
  "procedures": [{ "owner": "APP", "name": "PING" }],
  "functions": [{ "owner": "APP", "name": "ONE" }],
  "sequences": [{ "owner": "APP", "name": "COUNTER_SEQ" }]
}
```

Move source/target documents to format 6. Existing fields retain their meaning;
add required arrays `targetPackages`, `targetProcedures`, `targetFunctions`,
`targetSequences`, `programs`, and `sequences`. Policy and completion-manifest
versions remain unchanged. Reject older artifacts with re-extraction guidance,
including retry inputs; never relabel or synthesize missing metadata.

Program records:

| Field | Contract |
| --- | --- |
| reference | Exact owner/name |
| kind | PACKAGE, PROCEDURE, or FUNCTION |
| units | One specification and optional body for PACKAGE; exactly one unit otherwise |
| unsupportedFeatures | String array; nonempty entries block generation |

Each unit has `type` (PACKAGE_SPEC, PACKAGE_BODY, PROCEDURE, FUNCTION), nonempty
`ddl`, `status` (VALID or INVALID), and `dependencies`. Each dependency retains
`reference`, `type`, `databaseLink`, and an authoritative `oracleMaintained`
boolean. This distinguishes platform references from external application objects.
Require unit/type agreement and unique units; a body cannot exist without a spec.
An INVALID source unit is retained as a fact, with a warning; destination validity
is decisive after replay. No attempt is made to repair its DDL.

Sequence records have `reference`; decimal integer strings `minValue`, `maxValue`,
`incrementBy`, `cacheSize`; booleans `cycle`, `order`, `scale`, `extend`, `sharded`,
`session`, `keep`; and `unsupportedFeatures`. Keep all integers exact using SQL
text conversion and BigInt validation, never an intermediate JavaScript Number.
Do not capture LAST_NUMBER as a restart value. Identity-owned sequences remain
handled through identities; explicit selection of one fails clearly. Reject
Oracle-maintained or application-common sequence variants rather than flattening
their semantics. Render the listed flags where supported by the pinned target;
inconsistent or unverified combinations fail explicitly, never default silently.

### Extraction and transformation

Add optional `program(reference, kind)` and `sequence(reference)` SourceCatalog
methods; require them only when selected. Add focused `src/catalog-programs.ts`
and `src/catalog-sequences.ts` readers (new files). Read object identity, status,
body existence, dependencies, and sequence properties through the selected catalog
scope. Bind names/owners and allowlist object types.

Use separate GET_DDL calls for each program unit, with deliberate transform
settings including SQLTERMINATOR=true; reset/restore session transform settings
on completion or error. Preserve returned DDL exactly, including Oracle-generated
terminators. Fetch complete CLOB strings with per-query conversion and close all
resources. Do not truncate through DBMS_LOB.SUBSTR or VARCHAR2 casts. Distinguish
missing objects, wrong types, permission failures, and incomplete results safely.

Keep execution sequential on the connection. New metadata reads participate in
progress using literal categories for program metadata, program DDL, program
dependencies, and sequences. Add safe error-code allowlisting. Batching is optional
for these new kinds; existing table/view batching must remain unchanged.

Transformation copies program DDL unchanged and reports `SEQUENCE_POSITION_RESET`
for each selected sequence. A shared typed resolver recognizes dependencies
satisfied by included objects. Retain dependency facts in the source; downstream
checks, not destructive filtering, decide whether an external prerequisite is needed.

### Validation, dependencies, and SQL ordering

Validate selected definitions, duplicates, shared namespace collisions, unit shape,
dependency identity/type consistency, supported flags, integer ranges, nonzero
increment, cache constraints, and SQL line limits independently of extraction.
Unknown fields/versions remain strict errors. Validation cannot prove the semantics
of arbitrary DDL or discover dependencies concealed in dynamic SQL.

Use included-object resolution in both prerequisite validation and index grant
derivation. A selected sequence satisfies a table default prerequisite; a selected
function/package satisfies an index prerequisite without external acknowledgement.
Extend view dependency handling to accept explicitly selected functions/packages:
do not mistakenly pass these references to table extraction. Unselected program
dependencies become external prerequisites; existing TABLE/VIEW closure is retained.

Build deterministic operation ordering, with ordinal identity/type tie-breaks:

1. Provision all included owners, including program-only and sequence-only owners.
2. Create sequences before table defaults/program consumers; emit required direct
   sequence SELECT grants for known cross-owner table-default dependencies.
3. Order table creation, view creation, and program units by modeled prerequisites.
   Package specifications precede bodies. Create referenced objects and necessary
   existing index/view grants before their consumers. Preserve the existing
   constraint/FK rules and order independent operations deterministically.
4. Defer indexes until their required programs are present and valid. Pure program
   dependency cycles may create temporarily invalid units and then compile them;
   reject unschedulable cycles involving table expressions/views/indexes with
   `UNSUPPORTED_CREATION_CYCLE`, rather than generating a predictably broken script.
5. Compile remaining invalid selected units after creation, then require all selected
   specs, bodies, procedures, and functions to exist and be VALID before completion.

Program dependency rows do not reveal whether table access needs SELECT, INSERT,
UPDATE, or DELETE. Do not infer broad table grants or copy source privileges.
Report required cross-owner program access for operator setup using the existing
prerequisite SQL workflow; preserve existing narrowly derived index/view grants.
Fixtures must demonstrate provisioned direct privileges and actionable failure when
they are missing. No automatic execution of application programs is introduced.

The final compilation phase emits SQL into clone.sql; it does not connect from
generation. Use exact qualified selected-unit ALTER commands and a bounded retry
loop (at most the number of units plus one passes, stop on no progress). Do not
recompile whole schemas or unrelated objects. Handle only expected compilation
failures during retries; other SQL errors remain fatal. Final status checks raise
an error for any absent/invalid selected unit. Verify the actual Oracle compilation
error codes on the pinned image before implementing the narrow exception handler.
Ensure a SQL*Plus compilation warning cannot masquerade as successful completion.

Preserve raw DDL as emitted operations, without splitting on semicolons, adding
duplicate slashes, rewriting owner names, or reflowing lines. Update the preamble
to truthfully identify format 6 and metadata-derived program DDL, and update the
exact replay/retry preamble check in the same change.

### Stable failures and ancillary consumers

Reuse `MISSING_TARGET`, `OBJECT_NAME_COLLISION`, `UNACKNOWLEDGED_PREREQUISITE`,
`REMOTE_PREREQUISITE`, `SQL_LINE_LIMIT`, and strict catalog error codes where they
fit. Add `PROGRAM_METADATA_UNAVAILABLE` (missing/inaccessible DDL, with object and
unit context), `INVALID_PROGRAM_UNITS`, `INVALID_SEQUENCE`,
`UNSUPPORTED_SEQUENCE_FEATURE`, and `UNSUPPORTED_CREATION_CYCLE`. Use a stable
`OSP_PROGRAM_INVALID` final SQL error marker with safe object identity context.
No partial successful source document or successful clone result on these failures.

Extend destination verification to PACKAGE, PACKAGE BODY, PROCEDURE, FUNCTION,
and SEQUENCE, with exact expected body presence. Keep existing local-destination
identity, lock, reset, publication, and retry protections. Failure preserves the
partial destination and immutable artifacts under current workflow semantics.

Update CLI object counts/help and workbook metadata counts. Keep the workbook's
existing table/view scope explicit; do not dump potentially oversized program DDL
into spreadsheet cells. Program/sequence-only extraction and dictionary generation
must work with empty table/view sheets.

## Oracle Example

```sql
CREATE SEQUENCE APP.COUNTER_SEQ MINVALUE 1 MAXVALUE 999999
  START WITH 500 INCREMENT BY 1 NOCACHE NOCYCLE;
CREATE PACKAGE APP.COUNTER_API AS FUNCTION NEXT_ID RETURN NUMBER; END;
/
CREATE PACKAGE BODY APP.COUNTER_API AS
  FUNCTION NEXT_ID RETURN NUMBER IS
  BEGIN RETURN APP.COUNTER_SEQ.NEXTVAL; END;
END;
/
CREATE PROCEDURE APP.PING AS BEGIN NULL; END;
/
CREATE FUNCTION APP.ONE RETURN NUMBER AS BEGIN RETURN 1; END;
/
```

For the selection above, source/target contain four definitions and four program
units. clone.sql creates the sequence with reset start 1, includes the four
GET_DDL results unchanged, and verifies compilation. Destination-only probes assert
APP.ONE returns 1 and APP.COUNTER_API.NEXT_ID first returns 1. No source NEXTVAL
call is needed. The reset appears in the transformation report.

## Implementation Plan

1. Add the next ADR under `docs/adr/` superseding only ADR 0001's program/sequence
   exclusion and GET_DDL prohibition, plus its obsolete format statement. Document
   trusted DDL, explicit scope, reset behavior, and destination compilation.
2. Extend `src/model.ts`, fixtures, selection parsing tests, and version diagnostics.
   Add pure sequence validation/rendering and typed dependency resolution helpers.
3. Implement new catalog readers, updating `src/catalog.ts`,
   `src/catalog-reader.ts`, `src/catalog-queries.ts`, `src/catalog-schemas.ts`,
   `src/catalog-decoding.ts`, `src/extract.ts`, and `src/progress.ts` as needed.
   Prove full CLOB reads, privilege behavior, and package-body completeness first.
4. Update `src/transform.ts`, `src/semantic.ts`, `src/validate.ts`,
   `src/index-grants.ts`, and `src/catalog-views.ts` for included prerequisites,
   namespace checks, unchanged closure rules, and sequence reset reporting.
5. Implement operation ordering and selected-unit compilation SQL in focused new
   helpers integrated through `src/prepare.ts`, `src/ddl.ts`, and
   `src/sql-preparation.ts`. Extend `src/schema-owners.ts`.
6. Update `scripts/compose-destination.ts`, `scripts/clone-retry-input.ts`,
   `scripts/clone-workflow.ts`, `src/cli.ts`, and `src/dictionary.ts` for format 6,
   verification, preamble, counts, and new-kind-only workflows.
7. Add independent Oracle integration fixtures and tests; update README selection,
   privilege, compatibility, reset, prerequisite, and supported-feature guidance.
   Regenerate affected `examples/` artifacts using the new contract into fresh
   paths before deliberately replacing tracked examples through normal edits.

## Test Plan

- Extend `test/model.test.ts`, `test/extract.test.ts`, `test/catalog.test.ts`,
  `test/pipeline.test.ts`, `test/validate.test.ts`, and `test/prepare.test.ts`.
  Add focused program/sequence tests for every new contract/diagnostic.
- Cover each kind alone, mixed selections, legacy selections, empty selections,
  exact quoted names, duplicates, wrong types, missing objects, missing bodies,
  legitimate spec-only packages, permissions, null/duplicate metadata, unknown flags,
  partial CLOB failures, and resource cleanup. Include DDL well over 32 KB.
- Assert unchanged program text through source/target/SQL, semicolons inside strings,
  comments, blank lines, slash-like text, Unicode, terminators, line-limit boundaries,
  and no raw DDL/credentials in errors or progress. Preserve deterministic output
  under shuffled selection/catalog results, excluding extraction timestamps.
- Cover ascending/descending sequences, nonunit increments, large exact bounds,
  custom historical starts, cache/cycle/order/session/scale/shard/keep behavior,
  invalid combinations, identity backing sequences, and unsupported common objects.
- Exercise sequence-backed defaults, selected function-based index dependencies,
  selected functions in views, package spec/body ordering, program cycles, mixed
  unsupported cycles, external prerequisites, platform dependencies, cross-owner
  permissions, and invalid source programs that remain invalid at destination.
- Extend `test/compose-destination.test.ts`, `test/clone-workflow.test.ts`,
  `test/clone-retry-input.test.ts`, `test/clone-retry-cli.test.ts`,
  `test/progress.test.ts`, `test/progress-cli.test.ts`, and `test/dictionary.test.ts`.
  Preserve no-overwrite/completion coverage in `test/publication-cli.test.ts`.
- Add `test/integration/programs-and-sequences.test.ts` (new), with explicit
  `oracle-schema-pipeline-test` Compose resources and independent catalog assertions.
  Extend `test/integration/local-clone.test.ts` for success/failure/retry and all
  new object kinds. Seed through `test/docker/oracle/source-init/01-seed.sql` or
  isolated fixture setup following existing integration patterns.
- Test owner extraction, authorized cross-owner extraction, and restricted-reader
  rejection without broadening existing least-privilege table/view fixture accounts.
  Compare program source/status directly and execute harmless destination-only
  probes. Compare sequence configuration independently; never require source and
  destination position equality. Verify source preservation without advancing it.
- Run `npm run typecheck`, `npm run build`, `npm test`, and
  `npm run test:integration`. The latter uses the pinned Docker Oracle image and
  existing integration prerequisites. Run `npm run schema -- --help` to verify
  help; run offline transform/validate/generate against fresh temporary paths.

## Acceptance Criteria

- [x] All four new kinds can be named in objects.json, including selections with no tables/views.
- [x] Every selected package spec/body and standalone program comes from DBMS_METADATA and reaches clone.sql unchanged.
- [x] Selected sequences preserve supported options and restart at the approved bound without source mutation.
- [x] External dependencies are reported; selected definitions satisfy matching prerequisites without recursive export.
- [x] SQL ordering supports selected sequence defaults, program-dependent indexes/views, and supported program cycles.
- [x] Clone success requires every selected program unit to exist and be VALID after compilation.
- [x] Program-only owners are provisioned and destination verification/retry recognizes every new kind.
- [x] Strict format 6 rejects older artifacts with re-extraction guidance; old selection files still work.
- [x] Source access stays read-only; offline stages remain offline; no-overwrite and deterministic generation invariants hold.
- [x] Independent Oracle tests cover DDL completeness, privileges, behavior, reset semantics, and failure paths.
- [x] README and the superseding ADR accurately describe boundaries and remaining limitations.

## Risks and Open Questions

No outstanding requester decisions. DBMS_METADATA transforms/terminators, body
visibility, compilation exception codes, and supported sequence combinations were
verified on the pinned image. Undocumented/inconsistent variants fail closed.

Static catalog dependencies cannot reveal arbitrary dynamic SQL or infer exact DML
privileges. Compilation does not exercise invoker-rights behavior, package
initialization, runtime access, or environment-specific code. DDL portability across
source Oracle releases is bounded by the destination; no PL/SQL rewrite is promised.
Source metadata is not a point-in-time snapshot, so concurrent source changes may
cause extraction to fail or require re-extraction. The existing SQL line limit may
reject otherwise valid long source lines; this feature does not relax it.


## Implementation Evidence

- Added ADR 0009 and strict format 6. Selection version 2 remains additive.
- Program reads use per-query full CLOB conversion and reset metadata transforms.
  Cross-owner program/sequence reads require DBA scope with complete metadata
  privileges; ALL scope supports owner reads without guessing body visibility.
- Pinned-image probes verified ORA-24344 during compilation and ORA-02511 for
  NOSHARD. The compilation loop handles only ORA-24344; ordinary sequence SQL
  omits NOSHARD and sharded variants are explicitly rejected.
- Creation ordering operates on individual program units. Package specifications
  can precede dependent views while bodies follow their own prerequisites. Catalog
  prerequisite origin distinguishes table expressions from deferred index needs.
  Constraint changes can invalidate earlier objects, so compilation is revisited
  in dependency order after constraints.
- Package-body cycles work through separate specifications. Mutually recursive
  standalone functions that Oracle cannot compile without temporary stubs remain
  invalid and fail the final gate. No source rewriting or stub generation occurs.
- Integration tests verify large Unicode CLOBs, spec-only packages, owner/authorized
  cross-owner extraction, restricted readers, explicit direct grants, sequence
  options and reset, index/view dependencies, program cycles and invalid programs.
  The opt-in local clone suite includes every new kind, program-only owners,
  failure preservation and retry of the immutable artifact bundle.

- Oracle omits some virtual-column function relationships from ALL_DEPENDENCIES.
  Such opaque-expression relationships need explicit, independently known
  prerequisite facts in the reviewable document. Tests demonstrate replay failure
  without the fact and correct ordering/narrow EXECUTE grants with it supplied.
  Automatic extraction does not parse SQL or invent these missing facts.

Verification completed on 2026-09-29:

- `npm run typecheck` and `npm run build`: passed.
- `npm test`: 457 passed, no failures or skips.
- `npm run test:integration`: 8 passed; the opt-in local-clone test was skipped in
  that invocation and passed separately with `ORACLE_LOCAL_CLONE_INTEGRATION=1`.
- Final focused Oracle program/sequence tests, including boundary sequences and
  explicit virtual-expression prerequisites: passed.
- CLI help and offline transform/validate/generate/dictionary using fresh paths:
  passed. Tracked synthetic examples were regenerated with format 6.
