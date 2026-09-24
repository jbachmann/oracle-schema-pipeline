# Feature request

Copy this document for each request. One externally observable capability per
request. Replace every placeholder marked `<required>`.

## Summary

<required: one sentence describing the capability>

## User outcome

Given <required input/context>, when <required action>, then <required result>.

## Oracle example

```sql
-- Required minimal source object or catalog condition.
```

Expected model, diagnostic, or generated SQL:

```text
<required>
```

## Scope

- Included: <required>
- Excluded: <required>
- Affected stages: <extract | transform | validate | generate>

## Contract and compatibility

- JSON model change: <none | describe fields and versioning>
- Existing artifact behavior: <required>
- Migration or backward-compatibility behavior: <required>

## Failure behavior

- Unsupported case: <required diagnostic or extraction error>
- Ambiguous/incomplete metadata: <required behavior>
- Must never happen: <required silent-loss or unsafe-output cases>

## Acceptance criteria

- [ ] Minimal supported example produces the expected artifact.
- [ ] Unsupported variants fail with a stable, actionable diagnostic.
- [ ] Existing source and target documents retain stated compatibility.
- [ ] Source access remains read-only and offline stages remain offline.
- [ ] Generated SQL is independently validated and deterministic.
- [ ] Unit fixtures cover success, boundary, and rejection cases.
- [ ] Oracle round-trip coverage is added when catalog or SQL behavior changes.
- [ ] README and ADR updates are included when behavior or invariants change.

## Invariant check

List any conflict with
[`ADR 0001`](adr/0001-catalog-driven-oracle-schema-pipeline.md). Write `none` when
there is no conflict. A conflict requires a new ADR that supersedes the affected
decision.

<required>
