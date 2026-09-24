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
