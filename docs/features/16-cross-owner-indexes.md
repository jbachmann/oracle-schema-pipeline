# Feature: Preserve cross-owner indexes

- Status: Implemented
- Date: 2026-09-28
- Request: Reconstruct supported indexes under their original owner even when
  that owner differs from the indexed table's owner.

## Context and Scope

Given an extracted table with a supported cross-owner index, transformation,
validation, generation, and local clone must preserve the index's exact owner,
name, definition, and constraint associations without manual JSON edits.
The requester selected automatic preservation and automatic generation/execution
of grants required for reconstruction; no policy opt-in is required.

Included: currently supported nonpartitioned index types, standalone indexes,
enabled PK/unique constraint backing indexes, indexes on selected tables and
included one-hop parents, schemas that own only indexes, and both values of
`createSchemas`, plus object grants derived from exact index dependencies.
Existing expression/prerequisite rules continue to apply.

Excluded: ownership remapping, new index types, partitioned/domain indexes,
disabled candidate-key lifecycle support, copying original grants, arbitrary
destination orchestration, and exporting external functions or packages.
Selection must not expand to unrelated tables in an index owner's schema.

Affected stages: extraction captures index-specific dependencies; transformation
preserves them and reports planned grants; validation and generation use them. Local destination setup
and verification are included at the existing orchestration boundary.

### Oracle example

With application schemas and quotas provisioned, a privileged fixture session
creates:

```sql
CREATE TABLE APP.CUSTOMER (ID NUMBER, EMAIL VARCHAR2(100));
CREATE UNIQUE INDEX INDEX_SCHEMA.CUSTOMER_PK_IX ON APP.CUSTOMER (ID);
ALTER TABLE APP.CUSTOMER ADD CONSTRAINT CUSTOMER_PK PRIMARY KEY (ID)
  USING INDEX INDEX_SCHEMA.CUSTOMER_PK_IX;
CREATE INDEX INDEX_SCHEMA.CUSTOMER_EMAIL_IX ON APP.CUSTOMER (EMAIL);
```

The extracted table reference remains `APP.CUSTOMER`; both index references
retain `INDEX_SCHEMA`, including the constraint's `backingIndex` reference.
With `createSchemas=true`, generated SQL creates both schemas once with the
existing destination tablespace/quota policy, then the table, both qualified
indexes, and the constraint using `"INDEX_SCHEMA"."CUSTOMER_PK_IX`.
Validation reports no `CROSS_OWNER_INDEX` error. No owner is rewritten.

## Research Findings

Verified in this repository:

- `src/model.ts` already stores independent index `reference` and constraint
  `backingIndex` owner/name pairs. Current documents use format 4; policy uses
  version 1. `examples/policy.json` has no cross-owner setting.
- `src/catalog-tables.ts` selects indexes by `table_owner` and `table_name`,
  retaining each index's `OWNER`. Member queries use the index's own owner/name.
  `src/catalog-constraints.ts` retains backing-index ownership.
- `src/catalog.ts` includes index dependencies by joining index identity to the
  indexed table; it does not assume that their owners match. Prerequisites are
  attributed to the table under the existing contract.
- `src/transform.ts` preserves index metadata. Its report combines recorded
  changes with fresh validation; the cross-owner error is not ordinarily stored
  in the generated target document itself.
- `src/validate.ts` rejects ownership differences unconditionally. Independent
  checks already cover duplicate qualified index names, supported definitions,
  missing backing indexes, and backing-index suitability.
- `src/ddl.ts` already renders separately qualified index/table identities and
  qualified `USING INDEX`. `src/prepare.ts` creates indexes before constraints,
  but derives schema creation only from table and view owners.
- `scripts/compose-destination.ts` has the same omission in `setupChecks`.
  `verificationChecks` already enumerates index identities, but checks object
  existence/status rather than the indexed table or constraint association.
- Seeded integration/reset helpers contain fixed schema lists; adding an
  index-only fixture schema requires updating cleanup and verification lists.

External facts, accessed 2026-09-28:

- Oracle's [CREATE INDEX reference](https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/CREATE-INDEX.html)
  documents the executor's `CREATE ANY INDEX` requirement when creating in another
  schema, index-owner quota requirements, and index-owner `EXECUTE` privileges for
  user-defined functions used in function-based indexes.
- Oracle's [constraint reference](https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/constraint.html)
  supports qualified `USING INDEX schema.index`, with an error if the named index
  cannot enforce the constraint.
- Oracle's requested version-23 documentation URLs redirected to version 26.
  The repository's pinned Oracle image must therefore verify the behavior before
  implementation is accepted; documentation alone is not runtime evidence.

Inference: ordinary cross-owner indexes can use the existing privileged replay
model without granting `INDEX` to every index owner. The implementation must prove
this with a fixture whose index-only owner has quota but no such object grant.
Offline validation cannot establish the executor's actual destination privileges.

## Decisions and Boundaries

- Automatically preserve ownership for every otherwise-supported index.
- No new policy or CLI flag. Policy version 1 remains unchanged. Add exact
  per-index dependencies and advance source/target format to 5. Format-4 artifacts
  require re-extraction: table-level dependencies cannot reliably identify which
  index owner needs a grant. Follow the existing explicit version rejection
  convention; never interpret missing dependency metadata as an empty list.
- Keep source metadata unchanged. Ownership preservation is not a transformation
  omission. Report synthesized grants as `INDEX_REQUIRED_GRANT` change entries
  naming the privilege, referenced object, and grantee.
- With `createSchemas=true`, provision the distinct union of table, view, and
  index owners using the existing schema DDL and quota policy. With `false`, emit
  no schema DDL; operators provision all owners, storage quotas, and prerequisites.
- Use the existing privileged execution model and synthesize required object
  grants automatically. Keep acknowledged external dependencies and the existing
  `createSchemas=false` prerequisite setup rule. Operators provision external
  objects; the generated script supplies required index-owner object grants.
  The replay account must already be authorized to create objects and issue those
  grants. It cannot bootstrap its own missing administrative privileges.
  Do not grant broad system privileges to application schemas or copy unrelated
  source grants.
- An index-only owner is a schema required by included objects, not an external
  object prerequisite and not a request to extract that owner's other objects.

## Proposed Design

### Core pipeline

Remove only the owner-equality rejection in `validateIndexes`. Preserve all
other structural, state, duplicate-name, and constraint compatibility checks.
Continue keying indexes by exact owner/name, not table owner or index name alone.

Introduce a small pure helper in proposed `src/schema-owners.ts` returning the
sorted, deduplicated union of table, view, and included index owners. Use it in
`src/prepare.ts` and `scripts/compose-destination.ts` to prevent provisioning and
setup checks from diverging. Preserve exact case and use ordinal ordering.
Do not derive owners from unresolved `backingIndex` references or prerequisites.

Retain existing qualified DDL rendering and phase order: schemas, tables,
comments, required index grants, indexes, local constraints, then existing
subsequent phases. Preserve deterministic ordering. Existing same-owner SQL stays
equivalent apart from the format header and newly required grants.

### Required grants and dependency contract

Add required `dependencies` to each `IndexDefinition` in `src/model.ts`, using
strict entries `{ reference: { owner, name }, type, databaseLink }` with the same
field shapes as `viewDependencySchema`. An empty array means extraction found no
external dependency for that index; absent data is invalid in format 5.

In `src/catalog-tables.ts` (or a focused catalog helper), query the selected
ALL/DBA dependency family by exact index owner/name and dependent type `INDEX`.
Retain direct dependency identity and type, reject incomplete rows, and sort and
deduplicate exact references. Do not infer function names by parsing expressions.
Use the existing Oracle-maintained-object exclusions consistently. Preserve
existing table-level prerequisite reporting; require each external index edge to
also have a matching prerequisite acknowledgment, even for manually edited input.

Build a pure required-grant derivation shared by transformation reporting and SQL
preparation. For each supported function-based index, synthesize `EXECUTE` on its
external FUNCTION or PACKAGE dependencies to the index owner when different from
the dependency owner. Grant at package level for a packaged function. Do not grant
to every index owner on the table merely because they share table-level
prerequisites. Reject unresolved synonyms, remote dependencies, or other dependency
kinds whose grant semantics are not implemented with
`UNSUPPORTED_INDEX_DEPENDENCY`; do not guess a grantee or privilege. Existing
unsupported datatype/index checks still apply.

Emit grants after schemas/tables exist and before index creation, sorted and
deduplicated by privilege, object owner/name, and grantee. Quote identifiers and
omit `WITH GRANT OPTION`. A required grant may be emitted even if already held;
no destination access is added to offline stages. The executor must have authority
to issue object grants. No additional `INDEX` grant is expected for ordinary
indexes under the privileged replay model; add one only if the pinned-image tests
establish a requirement for the supported execution path. An `INDEX` object grant
to the owner cannot substitute for the replay account's `CREATE ANY INDEX`.

Example for a provisioned, acknowledged deterministic function:

```sql
GRANT EXECUTE ON "UTIL"."NORMALIZE_EMAIL" TO "INDEX_SCHEMA";
CREATE INDEX "INDEX_SCHEMA"."CUSTOMER_NORMALIZED_IX"
  ON "APP"."CUSTOMER" ("UTIL"."NORMALIZE_EMAIL"("EMAIL"));
```

A fixture must establish the actual dependency shape for standalone and packaged
functions on the pinned Oracle image before accepting the extractor. This is
required feature work, not an operator workaround for missing grants.

### Orchestration

Apply the complete owner set to `setupChecks`: owners must be absent when
generation creates schemas and present when operators provision them. Keep these
checks at their existing lifecycle point; this feature does not redesign clone
preflight or add online checks to core validation.

Extend destination verification for indexes to check owner/name plus
`TABLE_OWNER`/`TABLE_NAME` in `DBA_INDEXES`. For modeled PK/unique constraints with
a backing index, verify `INDEX_OWNER`/`INDEX_NAME` in `DBA_CONSTRAINTS`. Keep checks
limited to modeled objects; do not turn this into a general schema comparison.
Verify synthesized direct object grants in `DBA_TAB_PRIVS`, using the same
required-grant derivation to identify expected object/grantee/privilege tuples.
Use the existing escaped SQL literals and clone failure handling. Generated grants
execute during normal replay; a failed grant stops replay before dependent indexes.

### Failure behavior

- Retire the generated `CROSS_OWNER_INDEX` diagnostic; do not replace it with a
  warning for supported ownership differences.
- Preserve `DUPLICATE_INDEX`, `MISSING_BACKING_INDEX`,
  `UNSUPPORTED_BACKING_INDEX`, `INVALID_DEFERRABLE_INDEX`, `UNSUPPORTED_INDEX`,
  and other existing diagnostics when their independent conditions apply.
- Preserve catalog decoding failures for incomplete/ambiguous index metadata,
  including missing keys/expressions. Do not invent defaults or move the index.
- Retain external-prerequisite failures. Acknowledgment identifies provisioned
  external objects; generated grants establish the required direct privileges.
  Missing/unsupported dependency metadata blocks generation. A failed grant must
  never be skipped or retried with broader privileges.
- Missing schemas, quota, or executor privileges fail during existing destination
  checks/replay, with the existing stage failure result. Offline validation must
  not report that destination grants have been checked.
- Do not suppress user-supplied error diagnostics already embedded in a target.
  Regenerate such edited artifacts from source rather than stripping errors.

## Implementation Plan

1. Add Oracle fixture coverage establishing cross-owner standalone and PK/unique
   backing-index behavior on the pinned image. Include an index-only owner with
   quota and no `INDEX` object grant, and a built-in function expression index.
   Add standalone and packaged deterministic-function fixtures whose destination
   index owners initially lack EXECUTE, then prove generated grants enable replay.
   Keep fixture provisioning within the explicit test Compose project.
2. Extend `src/model.ts`, `src/catalog-tables.ts`, catalog row decoding, and
   `src/extract.ts` for format 5 and per-index dependencies. Update fixtures,
   examples, version diagnostics, `scripts/compose-destination.ts`
   `generatedReplay` header recognition, and `test/model.test.ts`. Add shared
   required-grant derivation, validation, transformation reporting, and emission.
   Add the pure owner-union helper and unit coverage, then wire it into schema
   emission and local-clone setup. Remove the validation rejection after these
   provisioning paths are covered.
3. Add extraction/transform/DDL regression cases in `test/catalog.test.ts`,
   `test/catalog-batching.test.ts`, `test/extract.test.ts`, `test/validate.test.ts`,
   `test/prepare.test.ts`, and `test/pipeline.test.ts`. Change production catalog
   or renderer code beyond dependency/grant support only where tests require it.
4. Extend `scripts/compose-destination.ts` verification and
   `test/compose-destination.test.ts` for index/table and constraint/index identity.
5. Update `test/docker/oracle/source-init/01-seed.sql`,
   `test/integration/oracle-roundtrip.test.ts`, and
   `test/integration/independent-facts.ts`. Update fixture schema cleanup and
   enumeration in `test/scripts/reset-compose-destination.ts` and
   `test/scripts/clone-compose-database.ts` so the index-only owner does not leak
   or break repeated runs. Cover orchestration in
   `test/integration/local-clone.test.ts` using its existing isolation rules.
6. Update `README.md` with automatic preservation, `createSchemas` behavior,
   format-5 re-extraction, privileged replay/grant authority, and automatic
   index-owner grant generation.
   Run the verification commands below and record results in the implementing PR.

## Test Plan

- Success: standalone ordinary/unique indexes and PK/unique backing indexes in
  another schema; nonunique backing indexes for deferrable keys; all currently
  supported index types retain their existing rules and rendering.
- Boundaries: index-only owners, repeated owners, quoted/mixed-case identifiers,
  same index name in distinct schemas, shared index owner across different table
  schemas, one-hop parent indexes, and both `createSchemas` values.
- Rejection: duplicate index identity across tables, backing reference with wrong
  owner, missing backing index, incompatible backing columns, unsupported types,
  partitioned/unusable indexes, and missing/unacknowledged external dependencies.
- Catalog: ALL and DBA query families and single/batched index member reads use
  the index owner; extraction preserves ownership and rejects detectable missing
  metadata. Do not claim ALL catalog access proves completeness beyond visibility.
- Compatibility: format-5 same-owner fixtures retain equivalent SQL except for
  required grants/header; format-4 artifacts fail with actionable re-extraction
  guidance. Policies remain version 1. Source objects remain unchanged after
  transformation and generation.
- Determinism: permuted table/index input yields the same schema owner ordering
  and existing canonical SQL ordering, with each schema/index emitted once.
- Grants: verify exact per-index recipients, duplicate suppression, quoted names,
  deterministic order, grant-before-index ordering, already-held privileges,
  dependency-owner equality, and no unrelated/system/grant-option grants. Cover
  built-in functions requiring no grant and missing/ambiguous dependency failures.
  Verify standalone and package EXECUTE grants using independent DBA_TAB_PRIVS
  queries and successful function-based index creation/DML. Include grant-denied
  replay failure and ensure dependent indexes are not attempted afterward.
- Oracle: independently query `DBA_INDEXES` and `DBA_CONSTRAINTS` to assert exact
  ownership, indexed table, key order, and backing-index reuse. Include destination
  duplicate-key probes with rollback for constraint enforcement.
- Replay failures: use isolated destination fixtures to demonstrate missing
  executor privilege, missing owner, and insufficient quota failures. Exercise
  segment allocation when checking quota so deferred creation cannot mask it.
  Do not change privileges or metadata on a real source.
- Local clone: index-only schema setup succeeds with automatic provisioning;
  `createSchemas=false` requires the preprovisioned schema; verification rejects
  wrong table/index associations. Existing non-overwriting publication and
  generation revalidation tests remain required.

Commands (defined in `package.json`):

```sh
npm run typecheck
npm test
npm run build
npm run test:integration
```

## Acceptance Criteria

- [x] The minimal example completes without a cross-owner diagnostic or JSON edits.
- [x] Owners/names are preserved for standalone and constraint-supporting indexes.
- [x] Index-only schemas are provisioned or required consistently with policy.
- [x] Oracle confirms exact table and constraint associations, without duplicate
  backing-index creation or unnecessary object grants for ordinary indexes.
- [x] Existing unsupported/incomplete cases still fail with stable diagnostics.
- [x] Required object grants are generated, reported, executed before indexes,
  and verified; operators need not manually grant index-owner EXECUTE.
- [x] Format-5 dependency metadata is complete; format-4 input requests
  re-extraction. Version-1 policies need no new option.
- [x] Source access stays read-only; transform, validate, and generate stay offline.
- [x] Output is independently revalidated, deterministic, and never overwritten.
- [x] Unit and isolated Oracle integration coverage passes; README is updated.

## Invariant Check

No conflict with ADR 0001 invariants or ADR 0008's orchestration boundary.
Preserving an already-modeled index owner extends supported reconstruction;
it does not copy source security policy or widen source access. Synthesized
object grants follow the existing REFERENCES/SELECT generation precedent.
No superseding ADR is required; document the format change in the README.

## Risks and Open Questions

No requester decisions remain open. Runtime verification is still required for
cross-owner backing indexes, function-based indexes, and privilege/quota behavior
on the pinned image. Automatic grants require authoritative index dependency
metadata and an executor authorized to issue grants; they do not provision external
functions or confer missing administrative authority on that executor. Existing
ALL-catalog visibility limits remain unchanged. If runtime
evidence contradicts the proposed support, resolve it before shipping rather than
silently remapping ownership or weakening validation.

## Implementation and Verification

Implemented on 2026-09-28. Format 5 requires per-index dependencies; shared
owner/grant derivation drives offline preparation, reporting, and destination
checks. The seeded index-only schema is dropped after table schemas during resets:
Oracle otherwise rejects dropping an index used by another schema's constraint.

Verification on the pinned image (Oracle 23.26.3.0.0):

- `npm run typecheck` and `npm run build`: passed.
- `npm test`: 322 tests passed.
- `ORACLE_LOCAL_CLONE_INTEGRATION=1 npm run test:integration`: all 6 tests passed,
  with no skips, including the local-clone lifecycle suite.
- Focused cross-owner Oracle coverage verifies standalone/function/package and
  constraint indexes, exact direct grants, DML enforcement, absent owners,
  allocated-segment quota failures, insufficient executor privileges, and stopping
  SQL*Plus replay at a denied grant. An executor's INDEX object grant cannot
  substitute for CREATE ANY INDEX; ordinary index owners need no INDEX grant.
- Local clone verifies automatic index-only schema creation, rejection when a
  preprovisioned index owner is absent, successful replay after provisioning, and
  rejection of incorrect backing-index associations. The existing operational
  volume was removed with explicit requester approval before this isolated suite.

The existing subprocess timeout test now permits two seconds for child startup;
its previous 250 ms deadline failed under concurrent test/Oracle load. Source
credentials remain outside arguments and artifacts, and core catalog access stays
read-only. Selection and policy versions remain unchanged.
