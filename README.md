# Oracle schema pipeline — TypeScript

A catalog-driven exporter with a versioned JSON intermediate representation.
The source database is queried for facts, not for CREATE/ALTER statements.
No DBMS_METADATA.GET_DDL, DDL string rewriting, source staging tables, or DBMS_OUTPUT
is used. Only the extraction command connects to Oracle; all other commands run offline.

**Status:** TypeScript checking, compilation, local tests, and a live Oracle Free
round-trip integration suite pass. Read the supported-subset section before a
production extraction.

## Pipeline

| Command | Input | Output | Oracle connection? |
|---|---|---|---|
| `extract` | Explicit table list | `source.json` | Source PDB, read-only catalog queries |
| `transform` | Source model and target policy | `target.json` and diagnostic/change report | No |
| `validate` | Target model | Diagnostics; exit 2 for semantic errors | No |
| `generate` | Validated target model | Ordered SQL script | No |

The source model remains unchanged. The target model retains source provenance
but applies the one-hop FK rule. Storage decisions belong to the target policy and
generator, not the source extractor. Every intentional FK omission is reported.
SQL generation validates again, so omitting the separate validation command does
not bypass the gate.

## Install and try the offline example

Node.js 22+ and npm are required. The database driver is `oracledb` in Thin mode;
Oracle Instant Client is not required for this connection configuration.

```bash
npm ci
npm run schema -- transform --input examples/source.json --policy examples/policy.json --output my-target.json
npm run schema -- validate --input my-target.json
npm run schema -- generate --input my-target.json --output my-clone.sql
```

The package includes synthetic `examples/source.json`, its target model,
`target.json.report.json`, and the resulting `clone.sql` for inspection. They are
not files captured from a real source database. Choose new output names: existing
files are never overwritten.

## Extract a real database

Create `objects.json` using exact catalog spelling, normally uppercase:

```json
{
  "version": 2,
  "tables": [{ "owner": "APP", "name": "CHILD" }],
  "views": [{ "owner": "REPORTING", "name": "OPEN_ORDERS" }]
}
```

An object reference has separate `owner` and `name` properties so quoted identifiers
containing periods or spaces are unambiguous. Names are preserved, not uppercased.

Connect to the source PDB containing the tables, not the CDB root:

```bash
npm run schema -- extract \
  --dsn source-host:1521/SOURCEPDB \
  --user EXPORT_READER \
  --objects objects.json \
  --output source.json
```

The password is requested through a hidden terminal prompt. For unattended runs,
use `ORACLE_PASSWORD` from your normal secret mechanism. Passwords are not accepted
as CLI parameters or written into artifacts.

Have a DBA supply a catalog reader with CREATE SESSION and sufficient access to
the DBA_* views used in `src/catalog.ts` (SELECT_CATALOG_ROLE is the straightforward
option). This version requires no source CREATE TABLE privilege or setup SQL.
The source account does not execute generated SQL and performs no source DML/DDL.

The full source model is written locally as UTF-8 JSON. Catalog LONG expressions
are read directly, including DATA_DEFAULT, SEARCH_CONDITION and COLUMN_EXPRESSION.
The truncating SEARCH_CONDITION_VC alternative is not used. Result sets are read to
completion. Memory is proportional to the selected metadata, and strings are not
limited by DBMS_OUTPUT or a VARCHAR2 staging column. Very large models still need
sufficient Node.js heap memory.

Keep source schema DDL stable during extraction. Separate catalog queries are not
a single point-in-time schema snapshot.

## One-hop selection and preserved source facts

For `A -> B -> C`, selecting A fetches table definitions for **A and B only**.
The source model records both A's FK to B and B's FK to C. It records C's reference
and referenced key columns, but never fetches C's table definition.
Transformation removes B's outgoing FK and records why it was omitted.

If B is also explicitly selected, C is a direct parent of an input and is included.
Parent-only FKs are always removed, even if their endpoints happen to be included
through another target. Incoming child tables are not discovered. Self-references,
cycles, cross-schema references and composite column order are retained.

## Intermediate model

Both models have `formatVersion: 3`, a `kind` discriminator, source version/time,
original table and view target lists, table and view definitions, prerequisites and diagnostics. The target
adds `targetVersion: "23"` and the applied policy. The model is Oracle-aware, not a
universal database abstraction.

`src/model.ts` contains readable Zod schemas and their inferred TypeScript types.
The same definitions validate files at runtime; unknown fields and unsupported
format versions fail explicitly. Important facts include:

- Column order, exact Oracle datatype/precision/scale and BYTE/CHAR semantics.
- Nullable table and column comments, preserved exactly from `DBA_TAB_COMMENTS`
  and `DBA_COL_COMMENTS` and emitted before indexes and constraints.
- Defaults as Oracle SQL expressions, DEFAULT ON NULL, virtual/invisible columns,
  identity generation/options and source nullability/collation.
- PK/UK/not-null/check/FK definitions, ordered FK column pairs, referenced candidate
  key, delete rule and enabled/validated/deferrable/initially-deferred/RELY states.
- Index identity, ordered column or expression keys, sort direction, uniqueness,
  visibility/type/status, plus explicit PK/UK-to-index references.
- Source storage summaries, unsupported features and discovered prerequisites.

Expressions remain SQL fragments, not parsed expression trees. JSON files containing
expressions are executable input to the SQL generator: only use models from trusted
sources. Runtime shape validation is not a SQL-expression sandbox.

Oracle records NOT NULL in its constraint catalog as a check predicate. The adapter
recognizes the exact quoted-column `IS NOT NULL` form and normalizes it to `not-null`.
An explicitly written equivalent CHECK can therefore normalize the same way. Other
check predicates remain unchanged SQL expressions.

## Target policy

An example `policy.json` is included:

```json
{
  "version": 1,
  "createSchemas": true,
  "defaultTablespace": "USERS",
  "maxStringSize": "STANDARD",
  "externalPrerequisites": []
}
```

Omitting `--policy` uses these defaults. The transformation always omits
parent-only outgoing FKs; there is no recursive mode or silent fallback.

The generator always omits source tablespaces, allocation clauses, physical
compression settings and storage parameters. It uses deferred segment creation
for supported heap tables and their indexes. The report records this policy per
table. Captured physical facts remain in the model for provenance, but are not
replayed. Dictionary records and later inserted data still consume space;
this does not bypass Oracle Free capacity limits.

`maxStringSize` validates model lengths against the intended target configuration;
it does not change the database parameter. Set EXTENDED only when the target has
been configured appropriately. Character sets and NLS behavior also need to be
compatible with the intended reconstruction.

With `createSchemas: true`, generated users are schema-only (`NO AUTHENTICATION`)
and receive unlimited quota on the specified, already-existing target tablespace.
Quota does not preallocate space. Original source passwords, roles and application
privileges are not copied. Use `createSchemas: false` for preprovisioned schemas;
their actual default tablespaces and quotas then control allocation.

Non-table prerequisites are recorded, not recursively exported. To use them,
provision the destination object and direct grants, use `createSchemas: false`, and
acknowledge each prerequisite explicitly:

```json
{
  "createSchemas": false,
  "externalPrerequisites": [
    { "reference": { "owner": "APP", "name": "NEXT_VALUE" }, "type": "SEQUENCE" }
  ]
}
```

The acknowledgment is a declaration by the operator, not a live verification.
Unacknowledged references and remote dependencies block SQL generation. Catalog
prerequisite detection is incomplete for dynamic/string-based references and some
defaults; review expressions and required built-in components independently.

## Generation order

1. Optional schema-only users.
2. Every included table, with named NOT NULL constraints in column definitions.
3. Table and column comments.
4. Every modeled index once, including supporting indexes.
5. PK/UK/check constraints. PK/UK uses the already-created index explicitly.
6. Cross-schema REFERENCES grants.
7. Only original-target outgoing FKs.
8. Conventional views in dependency order.

This eliminates the previous need to strip foreign-key DDL or guess whether
DBMS_METADATA already emitted a supporting index. Composite FK order and the
referenced candidate key are validated before generation.

Identity columns are generated from recognized IDENTITY_OPTIONS metadata. Numeric
bounds remain decimal strings and are checked with BigInt, avoiding JavaScript
number precision loss. Source identity sequence defaults are not replayed.
The declared identity start is reconstructed; this does not copy live next-value
state, cached values, or table data. Unknown or advanced identity flags block SQL.

## Supported subset and deliberate rejection

Supported: ordinary nonpartitioned heap tables; common Oracle scalar numeric,
character, date/timestamp, interval, RAW and LOB types; ordinary identity options;
virtual and invisible columns; defaults/check SQL; nondeferrable NOT NULL/checks;
enabled PK/UK; FK states; conventional nonpartitioned B-tree/reverse/bitmap and
function-based indexes whose keys can be represented directly.

Generation rejects, rather than approximates:

- IOTs, partitioning, clusters, nested/secondary tables, temporary/external/object
  tables, materialized-view storage, encrypted columns and Oracle-maintained tables.
- Custom/unknown datatypes, explicit nondefault collations, domain/partitioned
  indexes, unusable indexes, cross-owner indexes and internal SYS_OP_* index
  expressions. Some descending indexes expose such expressions and need an
  additional normalization implementation before this version can reproduce them.
- Disabled PK/UK index lifecycle cases and unusual supporting indexes. Supporting
  indexes currently must be normal ascending indexes with exactly the ordered
  candidate-key columns. A deferrable candidate key needs a nonunique index.
- Unknown identity metadata fields, advanced identity modes, missing references,
  duplicate identities, inconsistent states and unresolved prerequisites.

Unsupported structures can still appear in source JSON, with recorded features;
transformation produces a target and report with blocking diagnostics. Some
unrepresentable or inaccessible catalog metadata fails extraction itself explicitly.

No application rows, view comments, schema comments, standalone sequences,
triggers, stored programs, synonyms, jobs, security policies, comments on other
object types, original grants, statistics, or full
physical configuration are exported. System-managed LOB indexes and generated
hidden columns are not emitted as independent objects. This version reconstructs
a supported relational slice; it is not a universal database backup.

Format v2 source and target artifacts are intentionally rejected; re-extract them.
The object-selection document remains version 2.

## Diagnostics and file behavior

`transform` writes both target JSON and `<output>.report.json`; use `--report` to
choose another report path. The report includes deliberate changes plus validation
errors/warnings. It exits with status 2 for semantic errors but retains the files
for review. Correct the policy, model, or implementation and rerun to new filenames.

`validate` prints diagnostics and optionally writes `--report`. It exits 2 on
semantic errors. Malformed files/command failures exit 1. `generate` validates again
and writes no SQL if validation fails (exit 1). This distinction separates a
reviewable transformation result from an unsuccessful generation command.

Writes use a `.partial` file then a non-overwriting copy. An interrupted write or
failed final copy may leave the partial file; use a new path on retry. The two
transform artifacts are not an atomic pair: if writing the report fails, the target
may already exist. No existing artifact is overwritten.

## Readable code organization

| Module | Responsibility |
|---|---|
| `model.ts` | Shared document schemas, TypeScript types, object identifiers |
| `catalog.ts` | Oracle catalog adapter, complete expressions and ordered metadata |
| `extract.ts` | One-hop selection, independently testable through SourceCatalog |
| `transform.ts` | Pure source-to-target policy and change reporting |
| `validate.ts` | Cross-object references and supported-feature checks |
| `types.ts`, `identity.ts` | Focused datatype and identity rendering |
| `generate.ts` | Ordered SQL generation from a validated model |
| `files.ts` | Non-overwriting UTF-8 artifact writes |
| `cli.ts`, `password.ts` | Commands and source connection credentials |

To extend support, first add/capture the required model facts, then add target
validation and a renderer. Add a fixture demonstrating the semantic behavior. Do
not weaken a rejection merely to get SQL output.

## Verify and replay

```bash
npm run typecheck
npm test
npm run build
node dist/src/cli.js --help
```

### Live round-trip integration test

The integration suite starts the Compose services, discovers their published
listener ports, extracts all 98 seeded source tables, transforms and validates the
model, generates SQL, replays it into the destination, re-extracts the destination,
and compares both logical structures. It also checks table counts, foreign keys,
and invalid objects.

```bash
npm run test:integration
```

The test deliberately drops and recreates `IAM`, `CATALOG`, `COMMERCE`, and
`FINANCE` in `oracle-destination`. Never point it at a destination containing data
you need. The source is read-only.

Override Compose ports when the defaults are occupied:

```bash
ORACLE_SOURCE_PORT=1621 ORACLE_SOURCE_EM_PORT=5600 \
ORACLE_DESTINATION_PORT=1622 ORACLE_DESTINATION_EM_PORT=5601 \
npm run test:integration
```

To test an already-running Compose pair without calling `docker compose up`, use:

```bash
ORACLE_INTEGRATION_USE_EXISTING=1 npm run test:integration
```

`ORACLE_PWD` defaults to the same development password as the Compose file.
`ORACLE_SOURCE_DSN` and `ORACLE_DESTINATION_DSN` can override automatic listener
discovery.

### Populate the destination without testing

Run the complete operational flow without structural comparison or teardown:

```bash
npm run db:clone
```

This starts both Compose services, waits for source seeding, extracts all seeded
tables, transforms and validates the model, generates SQL, and loads it into the
destination. Containers and volumes remain running. Pipeline files are retained
under `artifacts/db-clone-<timestamp>/`.

The command is intentionally non-destructive. If any managed destination schema
already exists, it exits without dropping or replacing anything. Use a fresh
destination volume for each clone. The Compose port and DSN environment overrides
described above also apply.

To clear only the pipeline-managed schemas from the destination and then run the
clone again:

```bash
npm run db:reset-destination
npm run db:clone
```

The reset drops `FINANCE`, `COMMERCE`, `CATALOG`, and `IAM` with `CASCADE` from
`oracle-destination`. It never touches the source, other destination schemas, the
container, or its named volume.

For a real replay, review the SQL and run it as an appropriately privileged
administrator connected directly to the destination PDB, with UTF-8 client input:

```text
sqlplus /nolog
SQL> CONNECT sys@localhost:1521/FREEPDB1 AS SYSDBA
SQL> @clone.sql
```

Use a disposable target for initial trials. DDL commits implicitly; a failed replay
leaves earlier objects in place. The generated file is not idempotent. SQL*Plus
errors stop replay. Lines over a conservative 2,400 UTF-8 byte threshold are rejected
rather than wrapped inside expressions; those need a reviewed SQLcl-specific policy.

The 21 local tests cover catalog adaptation with LONG text over 32 KB, one-hop
selection, source immutability, target validation, ordered generation, index reuse,
composite/stateful FKs, identity precision, defaults, SQL expressions, identifiers,
large Unicode JSON and file overwrite protection. They use synthetic models and a
simulated database boundary; they do not prove Oracle acceptance of emitted SQL.

The next live acceptance check is: extract a representative Oracle 19c fixture,
transform/generate, replay into Oracle Free 23, re-extract with the same original
target list, and compare logical facts against the intended target. Allow deliberate
storage changes and generated identity names; verify table/FK scope, key order,
constraint states, expression behavior, nullability, indexes and DBA_SEGMENTS.
No live round-trip validation or automatic semantic model comparator is included.

References:
- https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/ALL_TAB_COLS.html
- https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/ALL_CONSTRAINTS.html
- https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/ALL_IND_EXPRESSIONS.html
- https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/ALL_TAB_IDENTITY_COLS.html
