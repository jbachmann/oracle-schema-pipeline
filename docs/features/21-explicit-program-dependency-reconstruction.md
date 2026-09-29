# Feature: Reconstruct explicitly selected PL/SQL and supporting objects

- Status: Implemented
- Date: 2026-09-28
- Request: Extract selected procedures, functions, whole packages, sequences, and
  local private synonyms and automatically produce their DDL in `clone.sql`.
- Supersedes as an implementation work item:
  [Feature 20](20-plsql-procedure-reconstruction.md), whose unchanged requirements
  are incorporated by reference.

## Context and Scope

Given explicit selections in `objects.json`, reconstruct supported PL/SQL and
its selected supporting objects through the existing extract, transform, validate,
and generate stages, then apply and verify them through local clone/retry.
Users continue to identify dependencies; selecting a procedure or function does
not recursively export its surrounding schema.

This is the single implementation entry point for the combined scope. Feature 20
was never implemented and must not be implemented as a separate work item or
intermediate release. Implement its unchanged requirements as part of feature 21.
This document takes precedence wherever it replaces feature-20 decisions.

This document is not a standalone restatement of every implementation detail.
The following feature-20 sections remain required supporting specifications:

| Inherited requirements | Supporting specification |
| --- | --- |
| Standalone/packaged procedure behavior, explicit selection, and base example | [Context and Scope](20-plsql-procedure-reconstruction.md#context-and-scope) |
| Base policy grant contract, compatibility, and dependency boundaries, as amended below | [Decisions and Boundaries](20-plsql-procedure-reconstruction.md#decisions-and-boundaries) |
| Program fields, compiler settings, source fidelity, and read-only catalog extraction | [Proposed Design](20-plsql-procedure-reconstruction.md#proposed-design) |
| Bounded CLOB transport, header validation, cleanup, compilation assertions, safe diagnostics, and artifact guarantees | [Proposed Design](20-plsql-procedure-reconstruction.md#proposed-design) |
| Base modules, unit/CLI/Oracle coverage, and acceptance criteria, as amended below | [Implementation Plan](20-plsql-procedure-reconstruction.md#implementation-plan), [Test Plan](20-plsql-procedure-reconstruction.md#test-plan), and [Acceptance Criteria](20-plsql-procedure-reconstruction.md#acceptance-criteria) |

Completing only the additions in feature 21 without the inherited procedure
functionality and checks does not complete this feature. Mark feature 21 implemented
only when the combined requirements pass; leave feature 20 marked superseded.

Requester decisions confirmed 2026-09-28:

1. Include ordinary PL/SQL functions and direct whole-package selection.
2. Restart sequences. This means MINVALUE for ascending sequences and MAXVALUE
   for descending sequences, with optional per-sequence policy overrides as
   described in the offered restart option. Do not continue from LAST_NUMBER.
3. Include explicitly selected local private synonyms.
4. Keep schema-level types manually provisioned for now.
5. Keep trigger extraction separate.
6. Keep infrastructure and application data manually provisioned.

Previously approved decisions remain: explicit dependency selection, grants in
`policy.json`, generated SQL plus local clone/retry only, and mandatory
re-extraction of old source/target artifacts.

Included function forms are ordinary standalone and public packaged PL/SQL
functions, preserving DETERMINISTIC and RESULT_CACHE declarations. Selecting a
packaged member includes its whole package, not just the member. A package may
also be selected directly, including one that exposes only types/constants and
has no body. An existing body is always included, never intentionally omitted.

Included sequences are conventional local global sequences, ascending or
descending, with cache/no-cache, cycle/no-cycle, and order/no-order attributes.
Keep the Application Continuity KEEP/NOKEEP owner setting when supported and
verified; KEEP SEQUENCE grants remain outside the explicit privilege allowlist.
Private synonym chains are supported only when every selected link can be
resolved through selected objects or acknowledged local external prerequisites.

Excluded: specialized pipelined/table functions, SQL macros, aggregate
implementations, parallel-enabled specialized routines, external-language call
specifications, wrapped code, edition-based deployment, scalable/sharded/session
sequences, public or remote synonym extraction, user-defined type extraction,
triggers, database links, infrastructure resources, credentials, and application
rows. A manually provisioned type does not expand supported table column types.
Packages containing unsupported program forms fail as complete units; do not
silently prune members to make a package acceptable.

### Changes to feature 20

| Feature-20 decision | Replacement |
| --- | --- |
| Only procedure selection roots | Add function, package, sequence, and synonym roots |
| Standalone functions/sequences/synonyms must be external | Selected supported definitions satisfy dependencies internally |
| Every selected package requires spec and body | Direct selection supports an authoritatively body-less package; member selection still needs its implementation |
| Every program follows all relational phases | Use a deterministic operation graph for supported mixed dependencies |
| Backward relational-to-program edges always fail | Accept acyclic supported edges; reject real creation cycles |
| Explicit grants run after all relational creation | Run each grant after its object exists and before its dependent creation operations |
| No package initialization during any replay | No deliberate routine invocation; destination DDL can implicitly evaluate functions and initialize packages |
| Procedure-only v6 contract | One combined v6 contract defined by both plans, with this document taking precedence |

### Oracle example

```sql
CREATE SEQUENCE APP.ORDER_SEQ
  START WITH 500 MINVALUE 1 MAXVALUE 999999 INCREMENT BY 1
  CACHE 20 NOCYCLE NOORDER;

CREATE FUNCTION APP.NORMALIZE_CODE(P_CODE VARCHAR2)
RETURN VARCHAR2 DETERMINISTIC AS
BEGIN
  RETURN UPPER(TRIM(P_CODE));
END;
/

CREATE PACKAGE APP.ORDER_CONSTANTS AS
  OPEN_STATE CONSTANT VARCHAR2(10) := 'OPEN';
END;
/

CREATE SYNONYM APP.NEXT_ORDER_ID FOR APP.ORDER_SEQ;

CREATE FUNCTION APP.NEW_ORDER_ID RETURN NUMBER AS
BEGIN
  RETURN APP.NEXT_ORDER_ID.NEXTVAL;
END;
/
```

Selection, alongside any manually identified tables/views/procedures:

```json
{
  "version": 3,
  "tables": [],
  "views": [],
  "procedures": [],
  "functions": [
    { "owner": "APP", "name": "NORMALIZE_CODE" },
    { "owner": "APP", "name": "NEW_ORDER_ID" }
  ],
  "packages": [{ "owner": "APP", "name": "ORDER_CONSTANTS" }],
  "sequences": [{ "owner": "APP", "name": "ORDER_SEQ" }],
  "synonyms": [{ "owner": "APP", "name": "NEXT_ORDER_ID" }]
}
```

Expected sequence DDL starts at 1, not the original 500 and not its captured
LAST_NUMBER. The target/report explain the deliberate reset. Package SQL contains
only the specification for ORDER_CONSTANTS. Both functions compile; the synonym
retains its exact target. Source extraction and operational verification never
call NEW_ORDER_ID or evaluate source/destination NEXTVAL to inspect sequence state.

## Research Findings

### Verified repository facts

- Current implementation is format 5, selection version 2, policy version 1;
  feature 20 exists only as a plan. Its new modules do not yet exist.
- `src/catalog-queries.ts` collects table and index prerequisites together.
  Scheduling needs separate table dependencies so an index requiring a function
  does not incorrectly imply that the table requires that function first.
- `src/index-grants.ts` currently accepts only acknowledged external FUNCTION or
  PACKAGE dependencies for function-based indexes. Internal selected definitions
  must become valid providers without an external-prerequisite acknowledgment.
- `src/extract.ts` presently treats every non-VIEW view edge as a table to collect.
  This must be restricted to TABLE edges before adding function/package/synonym
  support; otherwise it would query function identities as tables.
- `src/semantic.ts` follows only TABLE/VIEW edges for view closure, rejects other
  view dependency kinds, and orders only views. `src/prepare.ts` has fixed phases.
- `src/identity.ts` already handles decimal integer strings using BigInt because
  Oracle sequence values can exceed JavaScript safe integers. Identity backing
  sequences are reconstructed through the column clause, not as named sequences.
- `scripts/compose-destination.ts` has object validity and grant checks that can
  be extended without adding a new destination connection mechanism.
- The highest feature prefix before this addition was 20. No implementation files
  are changed by this planning task.

### Primary documentation, accessed 2026-09-28

- [ALL_SEQUENCES](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_SEQUENCES.html)
  defines numeric parameters and sequence flags; LAST_NUMBER is persisted state,
  not necessarily the next generated value when caching is used.
- [CREATE SEQUENCE](https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/CREATE-SEQUENCE.html)
  defines start bounds, increments, cache, cycle, ordering, KEEP, and sequence
  variants. NEXTVAL advances a sequence independently of transaction rollback.
- [ALL_SYNONYMS](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_SYNONYMS.html)
  supplies exact alias/target identities and DB_LINK. Its TABLE_OWNER/TABLE_NAME
  fields can refer to non-table objects. Visibility of another owner's synonym
  does not necessarily prove access to the ultimate target.
- [CREATE SYNONYM](https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/CREATE-SYNONYM.html)
  permits creation before the target exists. Synonyms do not confer privileges,
  cannot target individual package members, and may be editionable.
- [CREATE FUNCTION](https://docs.oracle.com/en/database/oracle/oracle-database/26/lnpls/CREATE-FUNCTION-statement.html)
  distinguishes ordinary PL/SQL functions and specialized forms. Program source
  owns the signature and clauses; do not reconstruct those from argument rows.
- [CREATE INDEX](https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/CREATE-INDEX.html)
  requires user functions in function-based indexes to be declared DETERMINISTIC
  and requires index-owner EXECUTE access. Source authors remain responsible for
  whether the function actually is deterministic.
- [CREATE TABLE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/CREATE-TABLE.html)
  documents sequence defaults and their existence/privilege requirements. Verify
  equivalent behavior on the pinned destination rather than assuming portability.

Inference: internal providers require operation-level ordering, not simply another
fixed phase after views. Public/private alias resolution and package-body absence
need explicit metadata validation. Dictionary documentation alone does not prove
visibility, exact dependency edges, or first-value behavior on every Oracle release.
All feature-20 pinned-image verification gates continue to apply.

## Decisions and Boundaries

### Selection and compatibility

Use the combined planned selection version 3 and source/target format 6; no
intermediate v6 documents are released. Existing version-2 table/view selections
remain accepted. Unknown fields/versions fail. Require re-extraction of format-5
and older documents and reject their retry bundles before destination reset.

Version-3 selection has seven arrays, each defaulting to empty on input:
`tables`, `views`, `procedures`, `functions`, `packages`, `sequences`, `synonyms`.
At least one entry across the seven must exist. Function references use the same
strict union as procedures: `{owner, name}` or `{owner, package, name}`.
Packages/sequences/synonyms use exact `{owner, name}`. Do not accept dotted strings,
wildcards, overload selectors, aliases in place of actual routine identities, or
case folding. Deduplicate exact entries and sort ordinally.

Procedure and function member roots must match their respective public member
kinds; all matching overloads are preserved. Direct package roots include all
supported members, types, variables, constants, and existing body contents. Mixed
roots identifying the same package result in one specification and at most one body.
Sequences-only, synonyms-only with external targets, functions-only, and directly
selected body-less packages are valid selection shapes.

Do not recursively export a function/package/sequence/synonym merely because an
included object references it. Existing one-hop FK and recursive table/view closure
remain, following only relational edges. Explicitly selected synonym chains must
end in an included object or an acknowledged local external provider. A missing
target does not silently become an additional root. Types and unselected supported
objects can remain external prerequisites under the existing policy/setup rules.

### Sequence restart policy

Extend planned policy version 2 with `sequenceStarts`, default `[]`, containing
strict `{reference: {owner, name}, startWith: decimalIntegerString}` entries.
Each reference must identify an explicitly selected conventional sequence. Reject
duplicate overrides, unselected identities, and out-of-range/non-integer values.
Version-1 policies normalize to empty grants and overrides; they reject new fields.

Without an override, start at minValue when incrementBy > 0, or maxValue when
incrementBy < 0. This is a fresh sequence, not recovery of the original START WITH
and not continuation of source allocation. Preserve supported increment, bounds,
cache, cycle, order, and owner KEEP settings. Emit `SEQUENCE_RESTART` for every
sequence, stating direction-bound versus policy override and the chosen start.
Never consume source NEXTVAL/CURRVAL, alter source state, or use MAX(table column)
to infer a start. Do not copy application rows to justify sequence values.

Keep exact captured LAST_NUMBER only as source provenance. It can change during
ordinary source activity; do not demand equality across extraction reads or claim
an atomic snapshot. Resetting a sequence in a clone with separately supplied data
can cause collisions; users choosing such setup must specify suitable overrides.

### Package-body absence and unsupported resources

Absence of visible PACKAGE BODY rows is not sufficient evidence that no body
exists. Record body presence independently through object catalog metadata. If
reading as the owning schema or with the selected DBA scope gives authoritative
absence, a directly selected specification-only package can be represented.
Otherwise, fail with actionable visibility guidance rather than inventing absence.
Do not automatically escalate scope or reconnect as another account.

If catalog metadata says a body exists but its source is inaccessible, extraction
fails. Member selection of an ordinary implemented routine requires the body.
Direct packages lacking bodies but declaring ordinary subprogram implementations
that require a body are rejected as incomplete. Include fixtures for legal
constants/type-only specs and cursor/declaration cases needing a body; ambiguous
specification semantics fail closed rather than passing as body-less packages.

Types, triggers, public synonyms, and infrastructure do not become newly supported
merely because a package references them. Existing database-link rejection remains.
Known unresolved dependencies get actionable diagnostics; dynamic SQL, alias names
omitted by catalog edges, session context, and runtime resources still need user
review. Copying a package constant/type declaration does not require schema-level
CREATE TYPE support unless it refers to a separate schema type.

## Proposed Design

### Combined format-6 changes

Keep feature-20 `targetProcedures` and `programUnits`. Add required arrays to both
source and target: `targetFunctions`, `targetPackages`, `targetSequences`,
`targetSynonyms`, `sequences`, and `synonyms`. No missing-field defaults in persisted
v6 documents. Function roots use the function selection union; the other new root
arrays use ObjectReference. Every definition must have valid selection provenance.

Program changes:

- Add FUNCTION to `programUnits.type`, using the same exact source, settings,
  AUTHID, unsupported-feature, and declaration-identity rules as procedures.
- Add `packageBodyPresent: boolean | null`: required boolean on PACKAGE,
  null on other unit types. Its value must agree with included body units and
  selected root requirements. No synthesized empty body.
- Add `routineProperties: object | null` to units, required on PROCEDURE/FUNCTION
  and null on PACKAGE/BODY. Include the same properties on public member records:
  `deterministic`, `resultCache`, `pipelined`, `parallelEnabled`, `aggregate`
  booleans and `sqlMacro: 'NONE' | 'SCALAR' | 'TABLE'`. Capture relevant catalog
  facts; unsupported true flags/macros block generation. Unknown/unavailable
  release-specific metadata follows feature-20 capability checks, never guesses.
  Retain member kind/overload/subprogramId. Exact source preserves clauses.
- Inspect other unsupported specialized language/sharding/edition constructs
  through catalog facts and the bounded lexical checks from feature 20. Unknown
  forms fail; there is no best-effort source pruning.

Each `sequences` definition is strict:

| Field | Contract |
| --- | --- |
| `reference` | Exact owner/name |
| `minValue`, `maxValue`, `incrementBy`, `cacheSize`, `lastNumber` | Canonical decimal integer strings; no floating-point transport |
| `cycle`, `order`, `scale`, `extend`, `sharded`, `session`, `keep` | Strict decoded booleans |
| `sharing` | Catalog NONE, METADATA LINK, or DATA LINK; only NONE supported |
| `identityBacking` | Boolean established through identity catalog association; true rejects explicit sequence extraction |
| `unsupportedFeatures` | Array of blocking facts |

Do not add a target-only start field to the unchanged sequence definition; derive
the start from target policy and source parameters during validation/preparation.
Unknown enabled sequence features must block rather than disappear. Oracle-managed
or identity-owned sequences are not accepted as conventional standalone roots.

Each `synonyms` definition contains `reference`, exact immediate `target`
ObjectReference, nullable `databaseLink`, `targetType` (catalog string),
`editionable` (boolean), nullable `editionName`, `sharing` (catalog string), and
`unsupportedFeatures`. Only local private, non-edition-deployed, non-shared aliases
are supported. `targetType` is obtained from scoped object metadata, never inferred
from TABLE_NAME. Fail if target identity/type is invisible or ambiguous. For local
chains, targetType can be SYNONYM; store immediate links without flattening them.
Do not reinterpret ambiguous public-synonym fallback as a private local target.

Selected chain links are individually required in `targetSynonyms`; externally
provisioned chain links require explicit acknowledgments. Read resolution metadata
for an external chain only to validate its local ultimate target and detect loops;
do not export or create that chain. Extend the prerequisite fact for a SYNONYM with
required `synonymResolution`: ordered `{reference, target, databaseLink}` links
plus terminal `{reference, type}`. Other prerequisite types have null resolution.
Capture this during extraction, preserve it, validate offline, and check exact
external synonym mappings during destination setup. A mere VALID synonym status
does not prove the correct target exists. Remote/public resolution steps remain
unsupported for selected private-chain reconstruction in this initial scope.

Add `dependencies` to table definitions, separate from index dependencies. These
contain actual TABLE-origin compilation edges, using the reference/type/link shape
already used by views/indexes. Keep provenance distinguishing TABLE, INDEX, VIEW,
and program unit type in analysis. Existing document prerequisites are still
recorded source facts, but validation can discharge them against selected providers
instead of requiring an external acknowledgment for every entry.

### Catalog extraction

Extend shared ALL/DBA catalog mappings for sequences and synonyms and implement
new `src/catalog-sequences.ts` and `src/catalog-synonyms.ts`. Reuse exact bound
selection, bounded batches, strict decoders, paging, and result-set cleanup.
Read named objects without using DBMS_METADATA or executing their source.

Transport sequence NUMBER fields as strings at the database/driver boundary, not
by stringifying JavaScript numbers. A query-local explicit decimal TO_CHAR format
wide enough for supported values, with fixed numeric characters, is suitable;
verify no exponent, padding, decimal point, or overflow marker is admitted. Use
BigInt only in memory for arithmetic. Persist JSON strings. Share validation
helpers with `src/identity.ts` where useful without changing identity semantics.

Split table-origin dependencies from the table/index prerequisite union in
`src/catalog-queries.ts`. Preserve exact index dependencies. Extend program queries
for function roots and direct packages; coalesce their reads with procedure roots.
Read selected synonym metadata before using synonym edges to resolve dependencies.
Add optional SourceCatalog capabilities for sequences/synonyms; old table/view-only
adapters work when those selections are empty. Check required capabilities early.

Fix view traversal to follow only TABLE and VIEW edges. When Oracle reports a
SYNONYM edge, resolve through captured selected/acknowledged metadata, never treating
the synonym as a table. Relational closure may continue along a resolved TABLE/VIEW
edge under existing view rules; it never expands FUNCTION/PACKAGE/SEQUENCE roots.
If Oracle records only a base object edge, do not claim to discover every alias
spelled in source. Explicit user synonym selection remains necessary.

### Offline validation and dependency scheduling

Add a shared provider/resolution index covering tables, views, program specs/units,
sequences, synonyms, and exact external prerequisites. Include all new object
owners in `src/schema-owners.ts`, including sequence-only and synonym-only owners.
Extend namespace collision checks across tables/views/procedures/functions/package
specifications/sequences/private synonyms. Package spec/body sharing remains legal.

Sequence validation checks canonical integer syntax, Oracle size/range limits,
nonzero increment, min < max, abs(increment) < max-min, legal cache size/cycle range,
and a chosen start inside bounds. Use exact arithmetic, not Number conversions.
Capture exhausted source LAST_NUMBER even if outside creation bounds; the restart
policy does not reuse it. Reject unsupported feature flags and identity association.

Synonym analysis resolves all chains with visited sets, validates exact endpoint
type, blocks cycles/dangling/unacknowledged endpoints, and never authorizes an
unselected exported object. Resolve grants to actual objects, not synonyms.
The existing explicit grant allowlist remains, including SELECT on sequences and
EXECUTE on functions/packages. Grants referencing selected providers no longer need
external acknowledgments. Preserve existing inferred index/FK/view grants.
Do not infer arbitrary DML grants or create schemas for unrelated grantees.

Replace rigid phase ordering for mixed slices with new `src/operation-order.ts`,
consumed by semantic analysis and `src/prepare.ts`. Represent creation dependencies
as a graph of schema, sequence, synonym, table, view, index, constraint, program,
and grant operations. Retain source provenance and one independently checked
preparation result; do not introduce an alternate path around validation.

Required edges:

- Owners precede their objects. Sequence creation precedes dependent defaults or
  programs. Table creation precedes its comments/indexes/constraints; candidate
  keys and REFERENCES grants precede dependent FKs as today.
- Function/package providers precede dependent views, expressions, and indexes.
  A call-capable operation such as function-based index creation requires the
  package body as well as specification when it uses a packaged function.
- Program compilation requires referenced tables/views, types or other supplied
  providers, and direct grants. Compilation references to packages require the
  specification; package bodies require their own specification. Legal recursive
  self references do not add self cycles. Mutually calling bodies can compile
  against already-created specifications.
- Emit selected private synonyms after schemas but before consumer operations.
  Because Oracle permits dangling creation, alias creation itself need not depend
  on terminal object creation. Consumers depend on the alias and the terminal
  provider; final checks require the whole chain to resolve. This avoids artificial
  cycles for self-recursive functions referenced through a synonym.
- A grant depends on object creation (package specification for EXECUTE) and
  grantee schema existence. Every dependent operation needing that declared grant
  follows it. For explicitly supplied grants whose consumer cannot be established
  from catalog edges, emit as early as their object/grantee permits.

Use ordinal identity ordering with stable existing phase priority as a tie-break
among ready operations. Keep existing relational-only order wherever dependencies
allow. Report actual creation cycles with involved identities/operation types;
do not solve cycles with FORCE, temporary stubs, disabled constraints, or repeated
compilation. For example, a function needing a table that has a virtual column
requiring that function may remain unsupported even when valid in the source.

Extend view validation for supported selected/external scalar FUNCTION/PACKAGE
dependencies and resolved synonyms while retaining all existing conventional-view
restrictions. A sequence edge does not legalize a SQL construct Oracle prohibits
inside a view. Dependency support is not permission to broaden unrelated SQL forms.

### Rendering, reports, and destination checks

- Reuse feature-20 bounded CLOB program rendering for functions/package specs and
  bodies. Render CREATE without OR REPLACE/IF NOT EXISTS. Verify DETERMINISTIC and
  RESULT_CACHE metadata matches supported declarations; do not infer semantic
  determinism from the keyword.
- Add `src/sequences.ts` and `src/synonyms.ts` for pure validation/rendering helpers.
  Emit explicit supported CREATE SEQUENCE clauses with the chosen restart value.
  Emit qualified private CREATE SYNONYM with preserved editionability and target.
  Never create an identity backing sequence separately or rewrite alias uses.
- Report `INCLUDE_WHOLE_PACKAGE`, `EXPLICIT_OBJECT_GRANT`, and compiler-policy
  changes as in feature 20. Add SEQUENCE_RESTART; direct package roots get a scope
  entry even if no procedure/function root selected them. Source facts stay intact.
- Final generated assertions and `scripts/compose-destination.ts` verify FUNCTION,
  PACKAGE, and expected PACKAGE BODY status/errors, root member kinds, sequence
  parameters, synonym mappings and resolved target existence, and explicit grants.
  Body-less packages do not spuriously require a body. Do not use only object
  counts or synonym VALID status as fidelity evidence.
- Do not use destination NEXTVAL/CURRVAL in operational verification. After cache
  allocation or DDL-dependent evaluation, LAST_NUMBER is not a reliable equality
  check for initial start; check generated start offline and exercise first-value
  behavior only in isolated sequence test fixtures.
- Maintain the new v6 preamble/retry contract from feature 20. Retry preserves
  chosen sequence starts from saved target policy and SQL, with no source reads
  or regeneration; recreating the disposable destination resets sequences again.
- Extraction remains catalog-only. Replay/verification do not deliberately call
  business routines, but destination DDL involving function expressions can
  implicitly invoke code or initialize a package. Do not promise zero application
  execution during all DDL. Trusted stored code is not sandboxed. Test ordinary
  program-only deployment separately from expression-dependent DDL.

### Stable diagnostics

Retain feature-20 codes and add:

| Code | Meaning |
| --- | --- |
| `FUNCTION_SELECTION_NOT_FOUND` | Missing/inaccessible standalone or public function root |
| `PACKAGE_SELECTION_NOT_FOUND` | Missing/inaccessible direct package root |
| `PACKAGE_BODY_VISIBILITY` | Cannot distinguish absent body from hidden metadata |
| `UNSUPPORTED_FUNCTION` | Specialized or unsupported function form |
| `UNSUPPORTED_SEQUENCE` | Unsupported flags, sharing, managed/identity sequence |
| `INVALID_SEQUENCE` | Invalid exact numeric parameters or bounds/cache combinations |
| `INVALID_SEQUENCE_START` | Invalid/duplicate/unselected override or out-of-range start |
| `UNSUPPORTED_SYNONYM` | Public, remote, edition-deployed, shared, or ambiguous target form |
| `SYNONYM_DEPENDENCY_CYCLE` | Selected/external resolution chain loops |
| `MISSING_SYNONYM_TARGET` | Target absent from selected/acknowledged providers |
| `OBJECT_SELECTION_MISMATCH` | Root/definition coverage mismatch for new object kinds |
| `OBJECT_DEPENDENCY_CYCLE` | Unschedulable mixed creation operations |

Use existing CATALOG_* codes for malformed/duplicate/incomplete rows, and existing
UNACKNOWLEDGED_PREREQUISITE/REMOTE_PREREQUISITE for external failures.
OBJECT_DEPENDENCY_CYCLE replaces feature 20's
PROGRAM_DEPENDENCY_CYCLE and UNSUPPORTED_PROGRAM_ORDER for unschedulable creation
graphs; an acyclic relational-to-program edge is no longer itself an error.
Preserve safe progress error allowlisting and additive query-category literals. Diagnostics must
not include raw program text, connection secrets, or unrestricted Oracle messages.
Semantic validation exit codes and non-overwriting publication remain unchanged.

### ADR and external-prerequisite rules

The ADR required by feature 20 must also explicitly supersede ADR 0001's standalone
sequence and synonym exclusions and cover ordinary functions/direct packages.
Amend the affected ADR 0003 table/view dependency-kind and ordering rules while
preserving relational closure, semantic checks, and independent generation gates.
Document the bounded mixed-operation graph and deliberate sequence restart policy.
Use the next available ADR number when implementing; do not create conflicting ADRs
for an unreleased intermediate feature-20 design.

Do not expand ADR 0008's destination boundary. Types/infrastructure remain manually
provisioned using existing destination setup; acknowledged external objects retain
the `createSchemas=false` rule. Selected sequence/function/synonym providers alone
do not force that mode. Missing application data or triggers can change runtime
behavior despite successful compilation; no equivalence guarantee is introduced.

## Implementation Plan

1. Perform feature-20 probes plus focused test-Compose probes for body-less packages,
   synonym visibility/dependency edges, sequence bounds/cache/KEEP/start behavior,
   function metadata, and mixed creation ordering. Record pinned-image results.
2. Implement the combined contracts in `src/model.ts` and the superseding ADR.
   Update `src/cli.ts`, `scripts/clone-config.ts`, and fixtures for seven selection
   arrays, v2 policy grants/sequenceStarts, and required v6 model fields.
3. Add catalog readers/queries/decoders for sequences and synonyms; extend planned
   `src/catalog-programs.ts` for functions/direct packages and body presence.
   Update `src/catalog-reader.ts`, `src/catalog-queries.ts`,
   `src/catalog-schemas.ts`, `src/catalog-decoding.ts`, and `src/progress.ts`.
4. Update `src/catalog.ts`, `src/extract.ts`, and `src/catalog-views.ts` for explicit
   object assembly, dependency-type-aware traversal, synonym resolution facts,
   and separate table-origin dependencies. Preserve existing batching and closure.
5. Implement provider/synonym analysis with planned `src/programs.ts`, new
   `src/operation-order.ts`, and `src/semantic.ts`. Extend `src/validate.ts` and
   `src/index-grants.ts` to satisfy prerequisites internally and validate grants
   at exact targets. Keep planned `src/object-grants.ts` aligned with graph edges.
6. Add `src/sequences.ts` and `src/synonyms.ts`, extend planned
   `src/program-ddl.ts`, integrate operation scheduling into `src/prepare.ts`, and
   update `src/schema-owners.ts` and `src/transform.ts` reports. Generation must
   still independently revalidate before publication.
7. Extend `scripts/compose-destination.ts` setup/verification/replay,
   `scripts/clone-retry-input.ts`, and workflow tests. Preserve source credential
   separation, reset ordering, exact preamble recognition, and immutable bundles.
8. Update README and planned `examples/objects.json` with all supported collections,
   whole-package/body-less examples, explicit sequence reset/overrides, local
   synonyms, and manual type/infrastructure prerequisites. Regenerate v6 examples.
   Extend `src/dictionary.ts` Overview counts for functions/packages/sequences/
   synonyms; JSON remains authoritative for program text and dependency metadata.
9. Run the tests below and the inherited feature-20 checks. Document verified
   source/destination versions and unsupported cases before marking feature 21
   implemented. Feature 20 remains superseded, not a separate completed release.

## Test Plan

Extend the feature-20 test files and add proposed new
`test/sequences.test.ts`, `test/synonyms.test.ts`,
`test/catalog-sequences.test.ts`, `test/catalog-synonyms.test.ts`,
`test/operation-order.test.ts`, and
`test/integration/program-dependencies.test.ts`.

- Model/CLI/config: old selection/policy input normalization, strict new v6 fields,
  unknown fields, roots of the wrong routine kind, duplicates across member/direct
  roots, and function/sequence/synonym/body-less-package-only selections.
- Catalog: bound identities and type-aware cache keys; read-only execution; no
  NEXTVAL/CURRVAL; exact 28-digit and negative integers; unknown flags, inaccessible
  synonym target, hidden package body versus authoritative absence, complete source,
  result-set closure, and identical data at batch size 1/default.
- Sequences: ascending/descending resets, custom source START WITH ignored,
  advanced/exhausted LAST_NUMBER ignored for target start, explicit override,
  invalid bounds/increment/cache, cache/no-cache, cycle/no-cycle, order/no-order,
  KEEP/NOKEEP, identity association, scalable/sharded/session rejection, and unchanged
  `test/identity.test.ts` semantics. Capture fixture sequence state before/after
  extraction without consuming it to prove source preservation.
- Synonyms: local table/view/function/package/sequence/type targets, multi-hop
  selected and acknowledged external chains, exact mappings, unresolved targets,
  cycles, private-owner visibility, public fallback rejection, database-link
  rejection, and grants on base objects. Final checks detect wrong targets even
  when synonym names/counts/status appear correct.
- Programs: ordinary standalone/packaged functions, overloads and wrong-kind
  selections, DETERMINISTIC/RESULT_CACHE preservation, direct constants/type-only
  package, legitimate no-body and incomplete required-body cases, all roots
  coalesced once, and specialized forms blocking the entire selected package.
- Ordering: sequence before table default; function before index; package body
  before call-capable DDL; function depending on a table followed by an index on
  that table; scalar-function view dependencies; required grants before consumers;
  legitimate recursion through aliases; and real table/virtual-column/function
  cycles rejected with stable object context. Ensure an index prerequisite does
  not create a false table prerequisite edge.
- Transform/validate/generate: immutable source facts, SEQUENCE_RESTART and grant
  reports, deterministic ordering under shuffled inputs, namespace collisions,
  missing/extra roots, exact external discharge, strict revalidation of edited
  targets, long source transport, and unchanged non-overwrite/completion guarantees.
- Destination integration: seed test-only functions, sequences, synonyms, and
  body-less packages in `test/docker/oracle/source-init/01-seed.sql`; update cleanup
  in `test/scripts/` for the explicit test project. Use independently written
  catalog assertions in `test/integration/independent-facts.ts`, not exporter
  equality alone. Verify sequence properties and alias targets directly.
- On disposable destination only, isolated sequences yield the expected first
  and subsequent values, including descending/cycling fixtures and overrides.
  Do not expect rollback to restore sequence state. Call seeded functions to
  verify return values, alias resolution, and cross-schema privileges. Test the
  function-based index as a non-SYS application user. Distinguish explicit test
  invocations from operational verification.
- Extend `test/compose-destination.test.ts`, `test/clone-workflow.test.ts`,
  `test/clone-retry-input.test.ts`, and `test/integration/local-clone.test.ts` for
  new owner sets, body-less verification, wrong synonym mapping, wrong sequence
  parameters, missing grants, v6 replay/retry, old-bundle rejection before reset,
  and repeated sequence restart on fresh local destinations.
- Extend `test/dictionary.test.ts` for accurate new Overview counts and empty
  relational worksheets. Preserve text escaping and workbook limits.

Implementation validation commands, verified in `package.json`:

```sh
npm run typecheck
npm test
npm run build
npm run schema -- --help
npm run test:integration
```

Integration uses the explicit seeded test Compose environment. The opt-in
clone/retry test provisions its own disposable operational destination and refuses
to adopt existing resources; it does not authorize replacement of a user's local
destination.

## Acceptance Criteria

- [x] Feature-20 procedure functionality and unchanged acceptance criteria are
  implemented and verified as part of this feature, with this plan's replacements
  applied. No separate procedure-only release or intermediate contract is required.
- [x] Functions, direct packages, sequences, and local private synonyms selected
  by exact name are represented and recreated without manual DDL authoring.
- [x] Packaged roots coalesce into one whole package; valid body-less direct
  packages work and hidden bodies are never silently omitted.
- [x] Sequences restart at the direction-appropriate bound unless explicitly
  overridden; all supported definition attributes and exact integers survive.
- [x] Source extraction performs no sequence consumption, application execution,
  DDL, or privilege changes. Source facts remain immutable downstream.
- [x] Private aliases retain exact local targets/chains, confer no inferred
  privileges, and do not automatically select additional exported objects.
- [x] Supported mixed object dependencies and grants are ordered correctly;
  unresolved dependencies, actual cycles, and unsupported variants block SQL.
- [x] Existing relational selection semantics and index/FK/view grant behavior
  remain intact, with internal function/package providers accepted where supported.
- [x] Generated SQL and local verification detect invalid programs, wrong sequence
  definitions, incorrect synonym mappings, and absent explicit direct grants.
- [x] No operational validation consumes sequence values or deliberately invokes
  application routines; implicit execution by function-dependent DDL is documented.
- [x] External types/infrastructure and omitted triggers/data are clearly separated
  from the promise of successful compilation and reconstruction.
- [x] Old artifacts require re-extraction; v6 retry retains the saved policy/SQL,
  and all generation/publication/security invariants continue to hold.
- [x] Independent Oracle and offline tests pass; examples, README, and ADR reflect
  this combined scope rather than the superseded procedure-only restrictions.

## Implementation Verification

Completed on 2026-09-28 against Oracle AI Database Free 23.26.3.0.0
(the pinned test image). See [ADR 0009](../adr/0009-explicit-program-dependency-reconstruction.md)
for catalog findings, supported boundaries, and replay requirements.

- `npm run typecheck`, `npm run build`, and CLI help passed.
- `npm test`: 448 passed, no failures or skips.
- `npm run test:integration`: 9 passed, no failures; the opt-in local clone test
  was skipped by default and passed separately with
  `ORACLE_LOCAL_CLONE_INTEGRATION=1`.
- Fresh test-Compose initialization passed with the new source fixtures.
  Independent Oracle assertions cover exact Unicode/long program source,
  compiler settings, direct grants, package-body visibility, sequence definitions
  and reset/override behavior, aliases, non-SYS function-based indexes, and
  non-consuming extraction/operational verification.
- Disposable local clone/retry passed with programs, a body-less package, an
  explicit cross-owner grant, a synonym, and a retained sequence-start override.
- Changed TypeScript formatting and `git diff --check` passed. Format-6 examples
  and workbook counts were regenerated. Feature 20 remains superseded.

## Risks and Open Questions

No requester decisions remain open. Implementation verification gates:

- Exact body-presence visibility, legal body-less declarations, and synonym
  dependency edges vary with source access/version. Fail incomplete metadata;
  never equate missing ALL rows with authoritative absence.
- The operation graph is broader than the current view ordering. Preserve object
  provenance and independent validation, and regression-test existing ordering.
  Some valid source schemas still require unsupported cyclic creation strategies.
- Sequence restart deliberately discards allocation state and original custom
  starting values. Exact arithmetic, cache/cycle limits, and non-consuming
  verification require independent Oracle tests.
- Synonym metadata can expose base dependencies without exposing every alias used
  in stored text. No general SQL parser or complete runtime dependency discovery
  is promised; missing aliases can still be discovered at destination compilation.
- A function-dependent DDL operation may execute application code or initialize
  packages on the disposable destination. Compilation-only checks do not establish
  complete runtime behavior or absence of side effects.
- Manual type/infrastructure setup, omitted trigger behavior, dynamic SQL, and
  absent application rows remain outside this reconstruction guarantee.
