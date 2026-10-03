# ADR 0009: Explicit table selection and extraction-time FK omissions

- Status: Accepted
- Date: 2026-10-01
- Supersedes: ADR 0001's one-hop scope and complete-FK source-fact assumptions;
  ADR 0003's automatic view-table inclusion and table-role precedence.

## Decision

A successful extraction contains exactly the unique explicitly selected tables,
using exact owner/name identities. No foreign key or view path authorizes another
table definition, prerequisite read, or table prefetch. All tables have role
`target`. Selected views still discover recursive local view dependencies; a
local TABLE edge outside the allowlist fails with `UNSELECTED_VIEW_TABLE`, naming
the view and table and instructing the operator to add the table.

Extraction immutably filters complete table definitions. Retain a foreign key if
and only if its parent is selected, including self-references. Record one
`OMIT_UNSELECTED_FK` change diagnostic per exclusion, naming the constraint and
qualified parent. The omitted definition is not stored elsewhere. Source
diagnostics and the later transformation report retain the audit record.

Catalog assembly remains strict. Referenced-key metadata may still be read for an
excluded FK; hidden or malformed metadata remains a catalog error. Unselected
parent table definitions are never read. Existing bounded catalog batching remains.

Source and target format version is 6; table roles are restricted to `target`.
V5 and older artifacts require re-extraction. Dictionary, transform, validation,
generation, and clone retry enforce the new contract without migration. Selection
version 2, policy version 1, progress version 1 and completion-manifest version 1
are unchanged, as is legacy CLI table-list parsing.

Transformation preserves constraints and extraction diagnostics. Semantic analysis
expects exactly `targetTables`; FK and view edges cannot authorize extra tables.
Validation independently rejects `FK_OUTSIDE_SELECTION`, including with a modeled
extra parent, and retains missing-parent and ordered candidate-key checks.
Generation independently validates before rendering.

## Consequences

Partial selections are predictable and can exclude unsupported parent tables.
Operators must explicitly select desired FK endpoints and local view base tables.
Source and dictionary constraints intentionally omit excluded relationships; their
audit diagnostics explain these omissions. Previously generated SQL is unchanged;
operators must regenerate it to obtain these semantics.

All other invariants remain: source read-only access, offline later stages, strict
decoding, deterministic ordering, no-overwrite publication, credential exclusion,
and the separate fixed local destination orchestration boundary of ADR 0008.
