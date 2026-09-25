# Source preservation verification

The Docker verification helper is:

```sh
VERIFY_CLONE_SOURCE=1 node --import tsx test/scripts/verify-clone-source.ts
```

It requires Docker and refuses existing containers in either the
`oracle-schema-pipeline-test` or `oracle-schema-pipeline-local` project and existing
source/destination data volumes. It creates the test source on port 1538 and the
operational destination on port 1539, leaving both running for inspection.
It does not delete unrelated Docker resources.

The helper copies the current pipeline into a temporary workspace and supplies
generated test credentials through private runtime configuration. It invokes the
actual `npm run db:clone` command. Repository `config/local` files are untouched
by this helper. Evidence is written under `artifacts/source-safety-*`.

The fixture contains four schemas (IAM, CATALOG, COMMERCE, FINANCE), 98 tables,
five views, and eight committed rows across seven tables. The rows exercise
identity columns, foreign keys, defaults, Unicode, NULL values, and JSON/CLOB
content. All fixture table rows are compared, including the empty tables.

The source comparison also covers object IDs and DDL timestamps, columns and
defaults, constraints and their members, indexes and expressions, sequences
(including `LAST_NUMBER`), views, comments, object/system/role grants, users, and
triggers. Sorted snapshots must be identical. Independent destination assertions
check selected seed semantics, comments, datatype boundaries, view restrictions,
grants, object validity, and the expected empty table contents. The clone copies
schema definitions, not source rows.

This establishes preservation of the fixture's application state during the
tested run. It does not claim that Oracle's internal audit records, statistics,
or background activity remain unchanged, or prove behavior for every possible
source configuration.

## Live run on 2026-09-25

The isolated run passed. Its evidence is in
[`artifacts/source-safety-Wh5NLv`](../artifacts/source-safety-Wh5NLv/).
The source before/after snapshot SHA-256 was:

```text
5f86d91711442e2b9d15cc10e74ef8be693f7d8e9e04ec10c6cb215d82f37123
```

For a second verification from the repository itself, `config/local/config.json`,
`objects.json`, and `policy.json` were populated with the Docker test endpoints,
all 98 tables and five views, and the default reconstruction policy. The original
local configuration was backed up privately; its location is recorded in
`artifacts/source-safety-Wh5NLv/config-backup-location.txt`.

The repository-local run also passed, with the same source snapshot hash before
and after. Its [verification report](../artifacts/source-safety-Wh5NLv/repository-verification.json)
records the command, working directory, comparisons, and successful run result.
The [clone artifacts](../artifacts/db-clone-2026-09-25T21-03-53-986Z-9UADsA/)
contain the extracted model, generated SQL, dictionary workbook, and run result.
The destination contains 98 empty tables, five valid views, and the generated
indexes. Both Docker databases were left running, and the repository's local
configuration remains pointed at the test source.

The first attempt stopped before cloning because the listener accepted
connections before fixture initialization completed. The helper now waits for the
seed completion marker directly before inserting sample rows or taking a baseline.
