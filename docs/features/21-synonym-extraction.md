# Feature 21: Explicit synonym extraction and reconstruction

- Status: Implemented and verified
- Date: 2026-09-29
- Request: Users populate a synonyms collection in objects.json before extraction.

## Outcome and approved scope

Users explicitly select private and PUBLIC synonyms by exact owner/name. Extraction
captures their definitions; replay creates aliases before consumers and verifies
local resolution. Users approved private/public support, explicit target selection,
rejection of remote links, and rejection of missing or unverifiable targets.

Included stages: extract, transform, validate, generate, dictionary, clone and retry.
Targets and intermediate aliases are selected separately or supplied as external
prerequisites. Existing table/view closure still applies. No recursive synonym
export, SQL parsing, source execution, grant export, or runtime-behavior guarantee.

Example selection:

```json
{
  "version": 2,
  "tables": [{ "owner": "APP", "name": "T" }],
  "synonyms": [{ "owner": "PUBLIC", "name": "APP_TABLE" }]
}
```

Source fixture and expected generated alias:

```sql
CREATE TABLE APP.T (ID NUMBER);
CREATE PUBLIC SYNONYM APP_TABLE FOR APP.T;
-- Generated before the table:
CREATE NONEDITIONABLE PUBLIC SYNONYM "APP_TABLE" FOR "APP"."T";
```

## Contract and design

Selection version 2 adds optional `synonyms`, default []. At least one object of
any supported kind is required. Deduplicate selection references and reject private
namespace collisions. PUBLIC names occupy their own namespace.

Document format 7 requires `targetSynonyms` and `synonyms`; reject older source,
target and retry artifacts with re-extraction guidance. Policy and completion
manifest versions do not change. Each definition contains:

- `reference`: selected owner/name.
- `target`: exact immediate catalog target owner/name.
- `databaseLink`: captured nullable string; non-null is unsupported.
- `editionable`: boolean.
- `resolution`: nonempty ordered hops with `reference`, supported `type`, and
  `target` (mapping for intermediate aliases, null for the terminal).
- `unsupportedFeatures`: strings that block generation if present.

Read configured ALL/DBA synonyms and objects with bound identities, strict row
schemas, complete result-set reads and safe errors. Inspect chains without
exporting targets. Require a local supported terminal: TABLE, VIEW, SEQUENCE,
PACKAGE, PROCEDURE or FUNCTION. Preserve root mapping even when resolution falls
back to PUBLIC; require DBA scope to establish absence of private shadowing.

Offline validation checks path continuity, cycles, selected-definition agreement,
namespace collisions, exact selections, unsupported flags and typed prerequisites.
Resolve explicit SYNONYM facts to terminal dependencies for creation ordering and
narrow SELECT/EXECUTE grants. Keep original facts; never rewrite program text.
Create aliases deterministically after schemas, before other objects, with quoted
identifiers and no OR REPLACE. Never provision PUBLIC as a schema.

Check exact destination alias mappings and terminal validity without application
calls. Verify captured PUBLIC fallback remains unshadowed. Preserve program final
VALID checks and fail mixed creation cycles. Cross-owner program grants remain
operator setup, with existing external policy and createSchemas=false rules.

## Failure behavior

- `SYNONYM_METADATA_UNAVAILABLE`: selected alias or mapping missing/inaccessible.
- `UNRESOLVED_SYNONYM_TARGET`: target missing, ambiguous, inaccessible, or path inconsistent.
- `SYNONYM_CYCLE`: repeated identity in a chain.
- `UNSUPPORTED_SYNONYM`: remote link, unsupported target type, common or editioned variant.
- Existing strict catalog decoding codes cover malformed rows and unknown flags.
- Existing prerequisite/type/namespace diagnostics cover absent acknowledgements or collisions.
- Replay mapping/target mismatches raise `OSP_SYNONYM_INVALID`; name conflicts
  propagate Oracle errors; missing grants may fail creation/compilation.

## Implementation and validation

1. Add versioned model, catalog reader and explicit extraction.
2. Extend typed dependencies, prerequisites and offline synonym validation.
3. Emit early aliases, resolve grants/order, and verify mappings and targets.
4. Extend schema ownership, CLI, dictionary, clone and retry compatibility.
5. Add offline and Oracle coverage, regenerate examples and document ADR 0010.

Tests cover optional/synonym-only selections, no target expansion, quoted names,
private/public aliases, chains, external prerequisites, namespace collisions,
deterministic SQL, old formats, owner/restricted/DBA visibility, malformed flags,
missing targets, cycles, remote links, dependency sequencing and narrow grants.
Oracle round trips exercise every supported terminal type, public calls, package
calls, sequence defaults, function-based indexes, mapping tampering, existing-name
conflicts, missing grants, and source sequence-position preservation. Local
clone/retry includes a selected alias. Run typecheck, build, offline tests, Oracle
integration and opt-in local clone/retry tests.

## Research and invariants

Oracle allows aliases before their targets and requires separate base-object
privileges. See [CREATE SYNONYM](https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/CREATE-SYNONYM.html)
and [ALL_SYNONYMS](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_SYNONYMS.html),
accessed September 29, 2026. ADR 0010 narrowly supersedes synonym exclusion and the
format-6 contract. Read-only extraction, offline stages, fail-closed generation and
non-overwriting publication remain intact. Dynamic SQL and catalog-omitted edges
remain outside automatic dependency guarantees.

## Verification evidence

- All 487 offline tests pass, along with typecheck, build, formatting and diff checks.
- The complete Oracle suite passes (9 tests; opt-in local workflow run separately).
- Focused Oracle coverage also verifies external intermediate aliases whose catalog
  status remains INVALID after target creation. Exact mapping and terminal validity
  are the acceptance criteria; no application calls are emitted by verification.
- The example source transforms and validates with no blocking errors; generated
  SQL matches the updated example and the format-7 workbook has been regenerated.

- Opt-in local clone/retry passes, including immutable retained artifacts, exact
  synonym mapping checks and a destination-only package call through the alias.

## Acceptance criteria

- [x] Optional explicit private/public synonym selection is supported end to end.
- [x] Targets are inspected without automatic export; external chains require setup.
- [x] Missing, remote, cyclic, unsupported and inconsistent metadata fails closed.
- [x] Dependencies and narrow grants resolve to underlying objects without SQL parsing.
- [x] Clone and retry verify mappings, terminal validity and selected programs.
- [x] Format-7 compatibility, documentation, ADR and examples are updated.
- [x] Offline and independent Oracle validation pass with source access read-only.
