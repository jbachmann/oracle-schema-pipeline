# ADR 0010: Explicit synonym reconstruction

- Status: Accepted
- Date: 2026-09-29
- Supersedes: ADR 0001's synonym exclusion and ADR 0009's document format only.

## Decision

Selection version 2 accepts optional `synonyms`, defaulting to an empty array.
Each entry is an exact owner/name reference; owner PUBLIC denotes a public alias.
Source and target documents use format 7 with required `targetSynonyms` and
`synonyms`. Older artifacts, including retained retry inputs, require re-extraction.
Policy and completion-manifest versions remain unchanged.

Extraction reads ALL_SYNONYMS/DBA_SYNONYMS and corresponding object catalogs.
Definitions preserve the immediate catalog mapping, null database link,
editionability, and ordered resolution facts. Each resolution hop records identity,
type and its immediate mapping, or null for a terminal object. Only explicitly
selected aliases become definitions. Inspecting a chain never exports its targets.
Existing table/view closure rules remain unchanged.

Terminals are local TABLE, VIEW, SEQUENCE, PACKAGE, PROCEDURE or FUNCTION objects.
Missing/inaccessible/ambiguous metadata, loops and remote links fail extraction.
Selected Oracle-maintained aliases, common objects, edition-specific definitions
and unsupported target types fail closed. A schema-qualified target can resolve
through PUBLIC; absence in ALL_OBJECTS cannot prove lack of a hidden private
object, so such fallback requires DBA catalog scope. Capture both the original
mapping and the resolved PUBLIC identity; verify lack of shadowing on replay.

Aliases are created deterministically after schemas and before other objects.
Oracle permits their targets to be created later. Render structured metadata with
quoted identifiers and explicit editionability, without OR REPLACE. PUBLIC never
becomes a user. Existing destination names fail rather than being replaced.

Explicit SYNONYM dependency facts resolve to captured terminals for consumer
ordering and narrow grants. Original facts remain in artifacts. Do not guess alias
usage from matching names or parse SQL. Unselected chain members and terminals
require explicit external-prerequisite acknowledgement and setup. Synonyms do not
confer privileges; cross-owner program access retains existing explicit setup.
Pure program cycles retain bounded compilation, and mixed creation cycles fail.

Generated SQL checks exact mappings and terminal validity without invoking
application routines. Early-created synonyms can remain INVALID until resolution
even with valid targets; external alias setup checks therefore verify captured
mappings rather than requiring the synonym itself to report VALID. Local destination verification independently uses DBA views.
Metadata checks do not guarantee dynamic SQL, runtime grants, or opaque-expression
relationships absent from source catalogs. All core connections remain extraction
only, source reads remain read-only, offline stages remain offline, and artifact
publication never overwrites outputs.

## Evidence

- [ALL_SYNONYMS](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_SYNONYMS.html)
- [CREATE SYNONYM](https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/CREATE-SYNONYM.html)

Accessed September 29, 2026. Oracle integration coverage lives in
`test/integration/synonyms.test.ts`; local clone/retry coverage includes a selected
package alias. Offline tests cover catalog visibility, strict decoding, dependency
ordering, exact rendering, prerequisite handling, and malformed artifacts.
