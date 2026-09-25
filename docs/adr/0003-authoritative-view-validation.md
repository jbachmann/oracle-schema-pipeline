# ADR 0003: Conventional views and authoritative semantic validation

- Status: Accepted
- Date: 2026-09-24

## Decision

Supersede ADR 0001's exclusion of views and its table-only selection description.
The existing strict format v3 supports explicitly selected conventional views and
recursive local TABLE/VIEW dependencies. Table selection still includes only
one-hop FK parents of explicitly requested tables. View dependencies and FK parents
do not expand outgoing FKs. Table roles take precedence in this order: target,
direct-parent, view-dependency. ADR 0002 continues to govern comments; all other
ADR 0001 invariants remain unchanged.

One indexed semantic analysis computes root reachability and dependency ordering
for validation and generation. Local view edges are deduplicated; adjacency and
indegree traversal orders dependency layers by ordinal object key. Missing edges
and cycles block generation. Unreachable views cannot authorize extra tables.

Validation checks modeled facts independently of extraction annotations: shared
table/view identities, duplicate view column names, editioning, typed, superview
and container-data flags, conflicting read-only/check-option settings, explicit
unsupported collation, and datatype limits. Feature annotations remain additional
blocking evidence. Null and USING_NLS_COMP collation retain existing behavior.
TIMESTAMP fractional precision must be 0..9; embedded precision and modeled scale
must agree when both are present.

## Consequences

Strict v3 shapes remain unchanged. Previously accepted inconsistent artifacts now
fail with blocking diagnostics; supported artifacts preserve semantics. Transform
reports use the same validation, and generation independently revalidates every
input before rendering SQL. No automatic repair or dependency expansion occurs.
Trusted SQL fragments remain opaque, not parsed or sandboxed. Extraction remains
read-only and all subsequent stages remain offline. Output never overwrites files.

ADR 0004 supersedes the v3 compatibility statement: format v4 makes complete view
text own restriction syntax and requires re-extraction of older artifacts. The
semantic validation and dependency rules in this decision continue to apply.

## Generation preflight (2026-09-24)

Validation now combines typed semantic analysis with internal SQL preparation.
Each public validate/assert/generate boundary strictly parses unknown input once;
internal analysis consumes that parsed document without reparsing or cloning it.
Preparation consumes the same dependency ordering and returns ordered SQL operations
with object provenance and diagnostics. It never calls validation or generation,
so the dependency direction remains acyclic. Only successful independent validation
allows generation to join operations into the final script; prepared objects are
not accepted as generation inputs or persisted in the document.

Preparation checks physical UTF-8 lines, including all emitted syntax, against the
unchanged 2,400-byte SQL*Plus limit. `SQL_LINE_LIMIT` identifies the object, the
operation-local line number, measured bytes, and limit. Existing datatype, identity,
and comment failure codes remain stable; `UNRENDERABLE_INDEX_KEY` covers index keys
that cannot be quoted. Errors in one operation do not suppress diagnostics for
other operations. SQL fragments remain trusted and opaque; no wrapping or rewriting
is introduced. Checks run per operation without constructing a second full script
for validation, leaving room for future streaming. Transform/validate semantic
errors still use exit 2, generation failure uses exit 1, and publication stays
non-overwriting. The JSON contract and supported SQL output remain unchanged.
