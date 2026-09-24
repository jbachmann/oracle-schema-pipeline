# Feature: Strict catalog decoding and faithful view metadata

- Status: Implemented
- Date: 2026-09-24
- Priority: High
- Request: Preserve catalog facts faithfully and reject ambiguous or unknown metadata.

## Scope and approved decisions

Catalog rows are decoded at runtime before domain assembly. Unexpected or null
flags, malformed fields, duplicate identities/expressions, missing comments and
incomplete ordered members fail explicitly with object/field context.

The requester approved format v4 and re-extraction of old artifacts on 2026-09-24.
Complete Oracle view TEXT owns restriction SQL. Structured readOnly/checkOption
fields report catalog facts; generation never adds a second restriction clause.
Both source and target v3 documents fail with actionable re-extraction guidance.
Selection version 2 and policy version 1 are unchanged.

Affected stages: extract/model/generate, with existing validation and dictionary
consumers receiving corrected facts. New view families and arbitrary SQL parsing
remain excluded. See [ADR 0004](../adr/0004-strict-catalog-decoding.md), which
supersedes ADR 0003's v3 compatibility statement.

## Implementation

- `src/catalog-decoding.ts` separates result-set transport and decoding, with
  `CATALOG_UNKNOWN_VALUE`, `CATALOG_CARDINALITY`, and
  `CATALOG_INCOMPLETE_METADATA` errors. Result sets close on failure.
- `src/catalog.ts` uses explicit runtime row schemas without view-row `any`.
  Identity, column, constraint, index, expression, and dependency identities are
  checked before Maps or assembly. Constraint/index/view members require contiguous
  positions; internal table column IDs allow legitimate gaps but not duplicates.
  Identity-column flags must agree with identity rows.
- View READ_ONLY agrees with constraint O; constraint V reports CASCADED. Restriction
  cardinality and state are checked. Retained SQL text is not parsed or stripped.
- Source/target schemas and extraction use v4. Examples, README, and ADRs describe
  compatibility and restriction ownership. Independent semantic validation and
  dictionary rendering retain their existing code paths.
- Version extraction now recognizes the Oracle AI Database product name rather
  than silently returning `unknown`.

## Research and supported coverage

A read-only live probe on Oracle AI Database Free 23.26.3.0.0 verified that stored
view TEXT includes WITH READ ONLY and WITH CHECK OPTION; named restriction names
were omitted from TEXT. O/V facts were independently present in DBA_CONSTRAINTS.
Ordinary views and both restriction types are covered by live replay tests.
Older source versions are not integration-certified by this change.

Oracle documents [READ_ONLY](https://docs.oracle.com/en/database/oracle/oracle-database/21/refrn/ALL_VIEWS.html)
and [O/V types](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_CONSTRAINTS.html).
Sources accessed 2026-09-24. Documentation is not treated as proof of TEXT behavior
on untested versions.

## Validation

- `npm test`: 87 passing tests, including unknown/null flags, duplicates, missing
  metadata, ordered-member failures, paged decoding, cleanup on decode/fetch failure,
  faithful view facts, exactly-once SQL, and v3 rejection.
- `npm run typecheck` and `npm run build`: pass.
- `npm run test:integration`: full 98-table/five-view round trip and independent
  ordinary/read-only/check-option probes pass on the disposable Oracle services.
  Probes compare workbook cells and independent catalog queries, and verify DML
  acceptance for an ordinary view and rejection for restricted views.

## Acceptance criteria

- [x] Unknown catalog flags cannot silently become supported states.
- [x] Ambiguous and incomplete metadata fails with stable object/field context.
- [x] View restrictions survive extraction, presentation, and replay exactly once.
- [x] Compatibility behavior is documented and regression-tested.
- [x] Existing pipeline invariants and stated compatibility behavior remain covered.
- [x] README and relevant architecture decisions describe the final behavior.

## Remaining limits

SQL fragments remain trusted and opaque: manually authored v4 documents must keep
SQL and descriptive restriction fields consistent. The exporter does not reconstruct
restriction names absent from TEXT. Extraction remains read-only with explicit
ALL/DBA scope and no fallback; later stages remain offline, generation revalidates,
output never overwrites, and errors exclude raw row/SQL contents.
