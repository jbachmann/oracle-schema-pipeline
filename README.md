# Oracle schema pipeline — TypeScript

A catalog-driven exporter with a versioned JSON intermediate representation.
Tables, views and sequences use catalog facts; explicitly selected programs use
DBMS_METADATA.GET_DDL. No DDL string rewriting, source staging tables, or DBMS_OUTPUT
is used. Within the core pipeline only extraction connects to Oracle. The separate
`db:clone` orchestrator also provisions and verifies its disposable local destination
([ADR 0008](docs/adr/0008-disposable-local-destination-orchestration.md)).

**Status:** TypeScript checking, compilation, local tests, and a live Oracle Free
round-trip integration suite pass. Read the supported-subset section before a
production extraction.

## Pipeline

| Command      | Input                          | Output                                     | Oracle connection?                    |
| ------------ | ------------------------------ | ------------------------------------------ | ------------------------------------- |
| `extract`    | Explicit table list            | `source.json`                              | Source PDB, read-only catalog queries |
| `transform`  | Source model and target policy | `target.json` and diagnostic/change report | No                                    |
| `validate`   | Target model                   | Diagnostics; exit 2 for semantic errors    | No                                    |
| `generate`   | Validated target model         | Ordered SQL script                         | No                                    |
| `dictionary` | Source model                   | Formatted XLSX data dictionary             | No                                    |

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
npm run schema -- dictionary --input examples/source.json --output my-dictionary.xlsx
```

The package includes synthetic `examples/source.json`, its target model,
`target.json.report.json`, and the resulting `clone.sql` for inspection. They are
not files captured from a real source database. Choose new output names: existing
files are never overwritten.

## Source data dictionary workbook

`dictionary` is an offline presentation branch from `source.json`; it does not
change the four-stage reconstruction pipeline or connect to Oracle. The generated
workbook uses this fixed sheet order:

1. `Metadata`
2. `Tables`
3. `Columns`
4. `Constraints`
5. `Indexes`
6. `Views`
7. `View Dependencies`
8. `Prerequisites`
9. `Diagnostics`

| Sheet               | Columns                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `Metadata`          | Property, Value                                                                                                |
| `Tables`            | Owner, Table Name, Role, Comment, Source Tablespace, Source Compression, Unsupported Features, counts          |
| `Columns`           | Table identity/role, Position, Column Name, Comment, datatype details, null/default flags, identity, Collation |
| `Constraints`       | Table/constraint identity, kind/member details, parent/check/delete/index details, state flags                 |
| `Indexes`           | Table/index identity, type/state flags, compression, ordered key details                                       |
| `Views`             | Identity/role, Columns, Query, view attributes, Unsupported Features                                           |
| `View Dependencies` | View identity/role, dependency position/identity/type/database link                                            |
| `Prerequisites`     | Required-by identity, referenced identity, Type, Database Link                                                 |
| `Diagnostics`       | Severity, Code, Object, Message                                                                                |

Tables and columns retain exact nullable comments. The remaining sheets expose
the source contract's physical summaries, ordered constraint/index members, view
facts and dependency edges, prerequisites, and extraction diagnostics. Headers
are frozen and filterable; long text is wrapped. Rows use deterministic ordinal
ordering and booleans use `TRUE`/`FALSE`.

Every source string is written as literal text, including values beginning with
`=`, `+`, `-`, `@`, tabs, or apostrophes. The workbook contains no formulas,
macros, external links, or data connections. Values exceeding Excel's 32,767
character or 253 line-feed cell limits, or its 1,048,576-row sheet limit, fail
instead of being truncated. Output uses the same exclusive `.partial` commit
behavior as other artifacts. The generated example is
`examples/data-dictionary.xlsx`.

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

Use the existing credentials supplied by your database administrator. The utility
does not require a particular username, role, proxy login, or fixture account, and
never creates source users or changes their privileges. Do not run the Docker seed
SQL against an existing database; it only provisions the disposable example database.

Extraction defaults to `--catalog-scope all`. It queries only `ALL_*` views using
the supplied account's existing visibility. Required metadata hidden from that
account causes extraction to fail rather than silently omit it. The utility does
not automatically detect catalog access or retry with another scope.

If you do not know which scope will work, start with the default. If it fails
because required metadata is inaccessible, retry with `--catalog-scope dba` using
the **same supplied credentials**. This attempts dictionary reads with the access
the account already has; it does not elevate privileges or switch users:

```bash
npm run schema -- extract --dsn source-host:1521/SOURCEPDB \
  --catalog-scope dba --user EXPORT_READER \
  --objects objects.json --output source.json
```

If neither scope exposes the required metadata, the utility cannot reconstruct
those selected objects completely and reports failure without publishing a source
document. This does not imply that you can obtain additional grants. Other errors,
such as unsupported metadata, are not resolved by switching catalog scope.

`--dsn` accepts either an Easy Connect string or a complete Oracle Connect
Descriptor. Quote descriptors so the shell passes them as one argument. Never put
a password in a connection argument; command arguments can be visible locally.

Thin-mode TNS aliases require the exact, absolute path to a readable regular file
named `tnsnames.ora` and an alias:

```bash
npm run schema -- extract \
  --tnsnames /etc/oracle/network/admin/tnsnames.ora --tns-alias SOURCEPDB \
  --user EXPORT_READER --objects objects.json --output source.json
```

The file path and alias form is mutually exclusive with `--dsn`. The parent
directory is passed to node-oracledb as `configDir`; the file is never copied,
rewritten, logged, or included in an artifact.

The password is requested through a hidden terminal prompt. For unattended runs,
use `ORACLE_PASSWORD` from your normal secret mechanism. Passwords are not accepted
as CLI parameters or written into artifacts.

`--catalog-scope dba` requires sufficient access to the selected `DBA_*` views,
such as `SELECT_CATALOG_ROLE`; it does not require `SYSDBA` specifically. The
default `all` mode needs no dictionary role. Neither mode requires source CREATE
TABLE privilege or setup SQL. The source account performs no source DML/DDL.

The full source model is written locally as UTF-8 JSON. Catalog LONG expressions
are read directly, including DATA_DEFAULT, SEARCH_CONDITION and COLUMN_EXPRESSION.
The truncating SEARCH_CONDITION_VC alternative is not used. Result sets are read to
completion. Memory is proportional to the selected metadata, and strings are not
limited by DBMS_OUTPUT or a VARCHAR2 staging column. Very large models still need
sufficient Node.js heap memory.

Keep source schema DDL stable during extraction. Separate catalog queries are not
a single point-in-time schema snapshot.

## Extraction progress and measured performance

Add `--progress-json` to `extract` to write versioned JSON-lines events to stderr:

```bash
npm run schema -- extract --dsn source-host:1521/SOURCEPDB \
  --user EXPORT_READER --objects objects.json --output source.json \
  --progress-json 2> extraction-progress.jsonl
```

Normal stdout and source artifact content are unchanged. Without the flag there
are no progress events. Events contain `version: 1`, a generated `runId`, `stage`,
`event` (`start`, `complete`, or `failure`), and monotonic `elapsedMs` for that
operation. Query events add a stable `queryCategory` and, on successful completion,
`rows` after all pages have been fetched, decoded, and closed. Table/view traversal
events and single-object queries include `object: {owner, name}`. Stages are `password`, `connection`, `extract`, `object`,
`query`, and `publication`; terminal CLI errors use `cli`. In interactive progress mode, `password/start`
replaces the plain-text prompt; type the password normally (input remains hidden).
For unattended capture, supply `ORACLE_PASSWORD`. A start without a terminal
event identifies an outstanding operation; these are operation events, not periodic
heartbeats or percentage estimates. A completed extraction precedes publication;
only `publication/complete` means the source artifact was published.

Failures include an allowlisted catalog code (`CATALOG_UNKNOWN_VALUE`,
`CATALOG_CARDINALITY`, `CATALOG_INCOMPLETE_METADATA`) or `EXTRACTION_FAILED`.
With progress enabled, CLI failures also use JSON and omit raw error messages.
Events never include passwords, usernames used to connect, DSNs/descriptors, TNS
contents, SQL/binds, expression text, or driver messages. Schema object identifiers
are included intentionally. Events are separate from semantic diagnostics and
source/target formats are unchanged. Library callers can share an optional
`ExtractionProgress(callback)` between `OracleCatalog` and `extractSource`;
synchronous observer exceptions are ignored so telemetry cannot alter extraction.
If a library caller's row-count callback throws, the operation still completes
successfully and its completion event omits `rows`; the reporting error is not exposed.

Table metadata, constraints, indexes (including dependencies), prerequisites and
view metadata use sequential batches of up to 32 exact owner/name pairs **across
objects**. FK column batches include referenced constraint identities without
expanding table selection. Views batch the currently discovered pending set;
a deep chain that reveals one view at a time remains incremental. Index reads
retain each index's owner and associated table, including cross-owner indexes.

No concurrent queries share a connection. Missing required metadata, duplicate or
out-of-batch rows and incomplete ordered members fail explicitly. Complete LONG
reads and ALL/DBA visibility remain unchanged. Failed batches publish no partial
prepared definitions; earlier complete batches remain available. Batch size bounds
query selections and temporary staging, not total model memory.

Library catalogs may implement optional `prefetchForeignKeys`, `prefetchTables`
and `prefetchViews` methods, each taking `ObjectReference[]` and returning
`Promise<void>`. Existing catalogs without these methods continue to work.
Prefetch emits query events before per-object assembly events. Object timings
therefore exclude prefetched database work; use query-category timings and the
overall extraction time to assess database cost. Multi-object query events omit
`object`. Counts measure executions, not every internal fetch/network round trip.

Run `npm run benchmark:extraction` for isolated synthetic comparisons at batch sizes
1, 16, 32 and 64 (or append `-- 32` for one size). Each JSON line reports the
workload, total and per-category execution counts, elapsed milliseconds, sampled
peak RSS, process peak RSS and a metadata hash excluding extraction time.
The runner verifies identical hashes across sizes. There is no CLI batch-size flag.

The fresh 74-table fixture fell from 889 to 37 queries. For 74 independently
selected views sharing one base table, view queries fell from 296 to 12 (309 to
25 total). Metadata hashes match the baseline and the one-table/one-index fixture
remains 13 queries. These are simulated transport results, not production speed
guarantees. See the [measurement report](docs/benchmarks/cross-object-extraction.md),
[historical report](docs/benchmarks/extraction.md) and
[ADR 0007](docs/adr/0007-extraction-observability-and-batching.md).

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

Both models have `formatVersion: 5`, a `kind` discriminator, source version/time,
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

With `createSchemas: true` (the default), generation creates missing owners and
skips existing users, including `SYS`. New users are schema-only (`NO AUTHENTICATION`)
and receive the configured default tablespace and unlimited quota on that
already-existing tablespace. Quota does not preallocate space. Existing users retain
their authentication, privileges, default tablespace, and quota; source passwords,
roles, and application privileges are not copied. Generated PL/SQL checks
`ALL_USERS` before creation; role-name conflicts and other creation errors remain
fatal. Existing tables and other objects retain their usual errors: this does not
make replay idempotent. Use `createSchemas: false` to emit no user creation and
require every owner to be preprovisioned for local cloning.

Non-table prerequisites are recorded, not recursively exported. To use them,
provision the destination object and direct grants, use `createSchemas: false`, and
acknowledge each prerequisite explicitly:

```json
{
  "createSchemas": false,
  "externalPrerequisites": [
    {
      "reference": { "owner": "APP", "name": "NEXT_VALUE" },
      "type": "SEQUENCE"
    }
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

Validation and transformation reports also preflight the final rendered SQL lines.
A physical line above the conservative 2,400-byte SQL*Plus limit produces a
`SQL_LINE_LIMIT` error naming the table, index, constraint, view, or schema, with
its operation-local line number and measured UTF-8 byte count. Quoted identifiers,
DDL prefixes, separators, and multibyte text count toward the limit. Long comments
still use the existing bounded dynamic DDL renderer; expressions are not rewritten.
Datatype, identity, and comment rendering failures retain their existing codes;
unrenderable index keys use `UNRENDERABLE_INDEX_KEY`.

Generation independently parses, validates, and prepares every input before opening
SQL output files. Transform and validate return exit code 2 for these diagnostics;
transform still publishes its reviewable target/report bundle. Failed generation
returns exit code 1. This preflight checks known rendering constraints, not arbitrary
SQL syntax or destination privileges. Supported models retain identical SQL output.

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
  indexes, unusable indexes and internal SYS_OP_* index
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

No application rows, view comments, schema comments,
triggers, jobs, security policies, comments on other
object types, original grants, statistics, or full
physical configuration are exported. System-managed LOB indexes and generated
hidden columns are not emitted as independent objects. This version reconstructs
a supported relational slice; it is not a universal database backup.

Source and target artifacts older than format 7 are rejected; re-extract them.
The object-selection document remains version 2.

## Diagnostics and file behavior

`transform` writes both target JSON and `<output>.report.json`; use `--report` to
choose another report path. A completion manifest is written last to
`<output>.complete.json`; use `--completion` to choose another path. All three
paths are preflighted before processing. The report includes deliberate changes
plus validation errors/warnings. It exits with status 2 for semantic errors but retains the files
for review. Correct the policy, model, or implementation and rerun to new filenames.

`validate` prints diagnostics and optionally writes `--report`. It exits 2 on
semantic errors. Malformed files/command failures exit 1. `generate` validates again
and writes no SQL if validation fails (exit 1). This distinction separates a
reviewable transformation result from an unsuccessful generation command.

A complete transform bundle has a manifest with independent `version: 1` and an
ordered `artifacts` array (target, report). Each entry contains `role`, canonical
absolute `path`, `bytes`, and lowercase hex `sha256`. Model `formatVersion` and
JSON/SQL/XLSX payloads are unchanged. Completion means publication succeeded,
not that the model is semantically valid: exit 2 still produces a complete bundle.

Consumers requiring both target and report must require the manifest and verify
its roles, paths, byte lengths, and SHA-256 hashes against their expected files.
`verifyCompletion` in `src/completion.ts` performs this check; the clone workflow
uses it before validation and generation. Standalone validate/generate still accept
existing model files without a manifest and independently validate their input.

The separate final pathnames are not a filesystem transaction. All bundle bytes
are staged before any final file appears, but publication can stop after a subset.
`OUTPUT_INCOMPLETE` reports a failure after one or more bundle files were published;
no completion manifest is published for that failed bundle. Earlier failures can
report `OUTPUT_EXISTS`, `OUTPUT_PUBLICATION_UNSUPPORTED`, or an I/O error. Keep
complete files for inspection and retry with fresh target, report, and manifest
paths. Never infer bundle completion from the target file alone.

Supported storage is a local filesystem providing atomic, exclusive hard links.
Network and other filesystems without those semantics are outside the guarantee;
unsupported link operations fail closed. This has been exercised on the local
macOS filesystem; other platforms need deployment-specific verification.

All file-writing commands accept `--temp-dir`. It defaults to
`.oracle-schema-tmp` under the CLI's current working directory; relative configured
paths also resolve there. Destination parent directories must already exist.
Staging and every destination must share a filesystem; otherwise the command
fails with `OUTPUT_PUBLICATION_UNSUPPORTED` and configuration guidance before
staging artifact bytes. No copying fallback or alternate staging location is used.

The writer creates a private, unique `publication-*` staging directory, writes each
file with mode `0600`, synchronizes and closes it, then publishes with an exclusive
hard link. Readers see complete bytes at each final pathname. Existing files,
including dangling symlinks, are rejected with `OUTPUT_EXISTS`; destination aliases
are rejected with `OUTPUT_PATH_CONFLICT`. Names differing only by case or Unicode
normalization in the same directory are conservatively treated as conflicts even
on case-sensitive disks. Final exclusive publication guards against competing writers after preflight. Output directories must remain stable
and trusted during publication.

File synchronization precedes publication. Destination directory synchronization
is attempted after each link. `OUTPUT_DURABILITY_WARNING` means the file is
published but directory synchronization failed; atomic visibility does not promise
survival of a power loss. `OUTPUT_CLEANUP_WARNING` also preserves the committed
outcome. Neither warning means a published file is absent.

Normal success and failure remove only the current invocation's staging directory.
A killed process may leave its unique directory behind; stale directories never
block retries and are never automatically adopted or deleted by another invocation.
After verifying the owner process has stopped, remove its staging directory.
Never edit staged files: a leftover staged file can share an inode with a published
artifact. Use new output names when retrying after any final artifact was published.
No existing artifact is overwritten.

## Readable code organization

| Module                    | Responsibility                                                    |
| ------------------------- | ----------------------------------------------------------------- |
| `model.ts`                | Shared document schemas, TypeScript types, object identifiers     |
| `catalog.ts`              | Oracle catalog adapter, complete expressions and ordered metadata |
| `extract.ts`              | One-hop selection, independently testable through SourceCatalog   |
| `transform.ts`            | Pure source-to-target policy and change reporting                 |
| `validate.ts`             | Cross-object references and supported-feature checks              |
| `types.ts`, `identity.ts` | Focused datatype and identity rendering                           |
| `generate.ts`             | Ordered SQL generation from a validated model                     |
| `files.ts`                | Atomic artifact and bundle publication                            |
| `completion.ts`           | Completion manifest and artifact verification                     |
| `cli.ts`, `password.ts`   | Commands and source connection credentials                        |

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
DSN overrides are rejected; listener discovery always uses the explicit
`oracle-schema-pipeline-test` project and `test/docker/docker-compose.yml`.

### Clone a remote structure into a disposable local database

**Migration:** `npm run db:clone` now replaces the entire local destination and its
volume after generation succeeds. The old seeded commands are `test:db:clone` and
`test:db:reset-destination`; `db:reset-destination` has been removed. Old
`oracle-schema-pipeline` resources are never adopted or deleted. Stop/remove those
manually if desired, or choose different ports for the new projects.

Follow [one-time configuration setup](config/example/README.md), then run:

```bash
npm run db:clone
```

This reads ignored `config/local/config.json`, extracts the explicit remote object
selection, creates a dictionary, transforms, validates and generates SQL. Source
access is read-only; application rows are not copied. The root Compose file contains
only the destination, in project `oracle-schema-pipeline-local`, on a local Docker
socket endpoint. Source and destination environment/DSN overrides are not used.
The listener binds to `127.0.0.1:1522` by default, service `FREEPDB1`.

Before any source connection, local preflight checks the Docker endpoint, daemon,
Compose, pinned Oracle image, and destination identity. Each check prints its start
and completion or failure; the active check reports elapsed time every 10 seconds.
A missing image triggers a download with recognized layer statuses and byte counters
when Docker supplies them. Cached images need no download. Docker output varies;
when counters are unavailable, status lines and elapsed-time updates remain useful.
These append-only lines also work in redirected logs. Elapsed time means the command
is still waiting, not necessarily that a download is advancing. Unknown registry
text and raw errors are excluded from progress output.

Only after all artifacts and preflight checks succeed does the command remove the
old container and volume, including a stopped destination, then start a fresh
Oracle database. Optional trusted prerequisite SQL executes once before replay.
Missing required setup configuration fails before reset. Destination setup
verification runs after startup and prerequisite SQL, before replay. Generation creates schema owners with
`NO AUTHENTICATION`; these are not login accounts. Inspect using a privileged local
account and the configured destination bootstrap password.

Each attempt retains a private `artifacts/db-clone-<UTC timestamp>-<random>/` folder:
`objects.json`, `policy.json`, `source.json`, `data-dictionary.xlsx`, `target.json`,
`report.json`, `target.json.complete.json`, `clone.sql`, and `run-result.json` when
publication succeeds. Failed runs may contain a subset. Results record stage,
reset status, timestamps, error code, image ID and optional setup hash/length.
They exclude credentials, DSNs, raw subprocess errors and setup SQL. No prior
artifact is overwritten. Review `report.json` for pipeline diagnostics.

For `CLONE_PREREQUISITE_FAILED`, check `lastStage` in `run-result.json`.
`prerequisite` means the configured SQL failed; `setup-verification` means the
required destination state could not be verified. The console and result now
include `errorDetail` with the unmet requirement and repair guidance when a setup
check fails, plus `oracleErrorCodes` when available. Checks require an online
`defaultTablespace`, matching `maxStringSize`, existing schema owners when
`createSchemas=false`, and valid `externalPrerequisites` in
`FREEPDB1`. Raw SQL client output is not retained.

Success requires modeled objects to exist and be valid; this is bounded checking,
not complete semantic equivalence. The destination stays running. After reset,
startup/setup/replay failures lose the old database and may leave partial new
structure. Fix configuration and run again; the command never retries replay into
a partial database. Before reset, failures leave the previous database intact.

To retry from an existing generated bundle after correcting destination setup:

```bash
npm run db:clone-retry -- "./artifacts/db-clone-<timestamp>-<suffix>"
```

This command **deletes and rebuilds the fixed local destination and its volume**,
with the same safeguards as `db:clone`. It starts replay from the beginning;
it does not resume partial SQL. It needs `clone.sql`, `target.json`, `report.json`,
and `target.json.complete.json` at their original paths. A prior successful
`run-result.json` is unnecessary. SQL alone is insufficient; if generation never
finished, run a normal clone or prepare the complete bundle offline.

Retry performs no extraction, dictionary, transformation, generation, or source
connection. It reads current destination settings and optional `prerequisiteSql`
from `config/local/config.json`; source, objects, and policy settings are ignored
and may be omitted. The saved target policy determines prerequisite requirements.
Current prerequisite bytes are guarded and their hash is recorded for this attempt.
Saved SQL retains its original bytes: older unconditional `CREATE USER` statements
can still fail on existing users. Generate a fresh bundle at new output paths to
obtain conditional creation; retry never upgrades or overwrites an old bundle.

Before reset, retry validates the target and completion bundle, checks the supported
SQL preamble, and publishes independent exact copies in a fresh
`artifacts/db-clone-retry-<timestamp>-<suffix>/` directory. A new completion manifest
and `retry-input.json` record the snapshot; the latter contains only ordered SQL,
target, and report byte lengths and SHA-256 hashes. The original folder stays
unchanged, and the new folder can be retried again. These hashes record consumed
bytes; they do not prove SQL corresponds to the model. Use trusted local artifacts.

Old model versions and moved folders with mismatched completion paths are rejected.
`CLONE_RETRY_INPUT_INVALID` identifies unsupported or invalid artifacts;
`OUTPUT_INCOMPLETE` identifies missing or mismatched completion bundles. Failures
before reset preserve the destination; failures after reset leave a partial database
and retained artifacts. Correct the input or current setup and invoke retry again.
`npm run db:clone-retry -- --help` requires no configuration or Docker access.

A per-user lock, `oracle-schema-pipeline-local-<uid>.lock` under the Node.js
system temporary directory, prevents concurrent runs across checkouts. SIGINT/SIGTERM stop
children and attempt to publish failure/release the owned lock. A missing result
means incomplete, never success. After SIGKILL or machine failure, verify no clone
process remains active before manually removing a stale lock; preserve its run
artifacts. No automatic retention cleanup occurs.

The operational image is pinned to Oracle Free digest
`sha256:f988b0c04c4c386cd306a2a914c0d7a9702d83acc31b064a28ad8eb6278a8fba`.
Live testing used Oracle `23.26.3.0.0`, image ID
`sha256:cdf2f86bedfa41904dfd7dbf27defe90d46a2fb8b34d85ad1c279f2bda839420`.
The locally available image is amd64; architecture emulation may be required on ARM.
Arbitrary source Oracle releases are not guaranteed compatible.

Seeded helpers remain available separately:

```bash
npm run test:db:reset-destination
npm run test:db:clone
```

They use `test/docker/` and `test/scripts/`, retain the four-schema seeded behavior,
and cannot reset the operational project's storage.

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

### Authoritative semantic validation

Strict v4 artifacts are checked independently of extraction annotations. Invalid
models previously accepted may now be rejected: unrelated views/tables, table/view
name collisions, duplicate view columns, specialized view flags (editioning,
typed, superview, container-data), conflicting read-only/check-option settings,
unsupported explicit collation, and invalid or inconsistent timestamp precision.
TIMESTAMP fractional precision supports 0 through 9.

Only requested view roots expand local TABLE/VIEW dependencies recursively. Only
requested tables expand one-hop FK parents. Table roles take precedence as target,
direct-parent, then view-dependency. Missing dependencies and cycles block SQL;
view layers use ordinal object-key ordering shared with validation. Transform
reports expose these diagnostics and generation independently revalidates input.
No model repair or SQL-expression parsing is performed. See
[ADR 0003](docs/adr/0003-authoritative-view-validation.md).

### Cross-owner indexes and format v5

Supported indexes retain their exact owner and name, including indexes backing
primary-key and unique constraints and indexes on included one-hop parents.
Index-only schemas join table and view owners in conditional schema creation.
Missing owners receive the configured default tablespace and quota; existing
users keep their settings. With `createSchemas=false`,
provision every owner and its quota in advance. Index ownership does not expand
table selection into that owner's schema.

Format v5 requires a `dependencies` array on every index. Re-extract format-4
artifacts; table-level prerequisites cannot identify the correct grant recipient.
Selection version 2 and policy version 1 remain unchanged.

For exact local FUNCTION or PACKAGE dependencies of function-based indexes,
generation emits deduplicated `GRANT EXECUTE` statements to the index owner before
creating indexes. Transformation reports these as `INDEX_REQUIRED_GRANT` changes;
local clone verifies the direct grants and table/backing-index associations.
Built-in functions and ordinary cross-owner indexes need no additional object
grants. Synonyms, remote edges, and unsupported dependency types fail closed with
`UNSUPPORTED_INDEX_DEPENDENCY`.

External functions/packages must already exist and be acknowledged in
`externalPrerequisites`, using `createSchemas=false` as with other prerequisites.
The replay account must have authority to create objects in other schemas and
issue the required object grants (including `CREATE ANY INDEX` for cross-schema
index creation). Generated grants do not grant administrative privileges or copy
source security policy. Offline validation cannot verify destination privileges.
Missing owners, insufficient quota, or denied grants stop replay; failed grants
are never skipped or retried with broader privileges.

### Strict catalog decoding and format v4

Extraction validates driver rows before assembling objects. Unknown enum flags,
malformed or missing values, duplicate identities and expressions, missing comment
rows, and incomplete ordered constraint/index/view members fail with
`CATALOG_UNKNOWN_VALUE`, `CATALOG_CARDINALITY`, or
`CATALOG_INCOMPLETE_METADATA`. Errors identify the object and field without dumping
SQL fragments. Result sets close on both decoding and fetch failure. Catalog scope
remains explicit; `all` never falls back to `dba`.

Format v4 preserves the full Oracle view `TEXT`, including its restriction syntax.
`readOnly` records `ALL_VIEWS.READ_ONLY`, cross-checked against the `O` constraint;
`checkOption` is `CASCADED` for a `V` constraint and `NONE` otherwise. These fields
are descriptive facts used by validation and the dictionary, not instructions to
append SQL. Generation emits the retained text once. SQL fragments remain trusted
and opaque: editing a restriction requires keeping text and descriptive facts in
agreement. The pipeline does not parse arbitrary SQL to verify that agreement.

Both source and target v3/v4 artifacts are rejected with a re-extraction message.
Re-extract from Oracle and transform again; changing only `formatVersion` cannot
recover facts omitted by the old exporter. Object-selection version 2 and policy
version 1 are unchanged. Live restriction coverage is Oracle AI Database Free
23.26.3.0.0; the stricter adapter is not yet integration-certified on older Oracle
versions. See [ADR 0004](docs/adr/0004-strict-catalog-decoding.md).

### Independent reconstruction verification and CI

The round trip retains model equality and checks both databases against fixed
expectations from the seed DDL: datatype parameters, character semantics, ordered
keys, exact comments/default literals, view restrictions, required grants, and
object validity. Destination-only inserts and updates check numeric rounding,
literal defaults, and read-only/check-option enforcement, then roll back. Source
verification and extraction issue only reads. SQL comparison preserves quoted
text (including repeated spaces, escaped quotes, and parentheses); only whitespace
between tokens and enclosing expression parentheses are ignored.

Only the disposable integration suite extracts as `SYSTEM[SCHEMA_READER]` using
default `ALL_*` scope. This is
Oracle proxy authentication: the existing environment-supplied SYSTEM password
authenticates the connection, while the session has the reader's `CREATE SESSION`
and explicit object `SELECT` grants only. Neither reader has roles or catalog-wide
privileges. `LIMITED_READER` can see a child table and a view but cannot see their
required dependencies; both extraction requests must fail. No reader passwords
are stored in fixtures. Destination extraction still exercises explicit DBA scope.
These accounts model sufficient and insufficient visibility for tests; their names,
proxy authentication, and exact grants are not requirements for real source accounts.
The production CLI always uses the supplied `--user` and existing privileges.

Existing source volumes created before these fixtures must be recreated for the
suite. For a **disposable Compose pair only**, the reproducible clean run is:

```bash
npm ci
npm run typecheck
npm run build
npm test
docker compose -p oracle-schema-pipeline-test -f test/docker/docker-compose.yml down --volumes
docker compose -p oracle-schema-pipeline-test -f test/docker/docker-compose.yml up -d --wait --wait-timeout 1200
ORACLE_INTEGRATION_USE_EXISTING=1 npm run test:integration
docker compose -p oracle-schema-pipeline-test -f test/docker/docker-compose.yml down --volumes
```

GitHub Actions runs `Offline checks` on pushes and pull requests. Configure that
job as a required branch-protection check in repository settings; workflow files
alone cannot enforce branch protection. `Disposable Oracle integration` is a
manual workflow for catalog, generation, and fixture changes. It provisions fresh
Compose volumes and removes them even after failures; it is not a required PR
check or scheduled job. Workflows use read-only repository permissions and Node
22 ([GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)).
The Oracle job needs Docker Compose, access to the Oracle container registry,
enough disk for two database volumes and the image, and enough RAM for two Oracle
Free instances (allow 16 GiB for the runner). The workflow uses `ubuntu-24.04`;
select a larger runner if the repository's hosted-runner allocation is smaller.
The Compose image remains `latest`, so record the tested database version when
reporting results; this is reproducible provisioning, not an image-version pin.
No production DSNs or credentials are configured in CI, and database logs/artifacts
are not uploaded because they can contain credentials or source metadata.

The disposable operational integration suite is opt-in:
`ORACLE_LOCAL_CLONE_INTEGRATION=1 npm run test:integration`. It uses a temporary
checkout/config, listener 1529, and refuses pre-existing operational resources.
It cleans up only the operational resources it creates; CI also tears down the test project.

## Selected programs and sequences (format 7)

Selection version 2 also accepts optional `packages`, `procedures`, `functions`,
`sequences`, and `synonyms` arrays, each containing exact `{ "owner": "APP", "name": "ONE" }`
references. At least one object across all seven kinds is required; table/view-only
selection files remain valid. For example:

```json
{
  "version": 2,
  "packages": [{ "owner": "APP", "name": "COUNTER_API" }],
  "procedures": [{ "owner": "APP", "name": "PING" }],
  "functions": [{ "owner": "APP", "name": "ONE" }],
  "sequences": [{ "owner": "APP", "name": "COUNTER_SEQ" }]
}
```

A package selection includes its specification and existing body. Extraction reads
full DBMS_METADATA DDL as the owner or, with `--catalog-scope dba`, an authorized
catalog reader with enabled SELECT_CATALOG_ROLE (or SYS authority). Ordinary EXECUTE grants do not establish
complete body visibility. Missing/inaccessible metadata fails extraction; there is
no privilege elevation or source-text fallback. Source programs are never compiled
or executed. The DDL is trusted executable input and reaches clone.sql unchanged;
exclude programs containing embedded credentials from published artifacts. Existing
2,400-byte SQL line limits still apply. Direct SQL*Plus users must configure an
AL32UTF8 client to preserve Unicode; local clone orchestration does this explicitly.

Programs do not expand the selection. Included typed definitions satisfy modeled
prerequisites; unselected application dependencies must be acknowledged through
`externalPrerequisites` with `createSchemas=false` and provisioned through the
existing `prerequisiteSql` workflow. Cross-owner program access likewise needs
operator-provided direct grants: catalog dependencies cannot identify required DML
privileges. Known cross-owner table expressions receive the narrowly required
sequence SELECT or program EXECUTE grant. Oracle-maintained references are
recorded as platform requirements.
Dynamic SQL and runtime/environment behavior are outside the guarantee. The
pinned Oracle catalog also omits some virtual-column function dependencies.
Such relationships need explicit prerequisite facts in the reviewable document
and any required operator setup; selection alone cannot discover them. SQL text
is not parsed to guess missing dependencies.

Sequence bounds, increments and caches remain exact integers. Ascending sequences
restart at their minimum; descending sequences restart at their maximum, reported
as `SEQUENCE_POSITION_RESET`. Neither the current position nor a historical custom
start is preserved, and extraction never calls NEXTVAL. Supported conventional,
scale/extend, session and keep options are preserved where valid. Sharded sequences,
Oracle-maintained/application-common variants, explicit identity backing sequences
and unverified combinations fail closed. Identities retain their existing handling.

Generation orders modeled dependencies, permits pure program cycles, and rejects
mixed creation cycles. Package-body cycles can use the previously created
specifications; mutually recursive standalone units that Oracle cannot compile
without temporary stubs still fail validity checks. The pipeline does not invent
stub DDL. Selected units must all exist and be VALID after bounded,
selected-unit compilation before clone success. This does not test runtime behavior.
Program/sequence-only owners are provisioned and verified. Dictionary workbooks
include the new counts but keep their existing table/view scope without program DDL.

Source/target documents now require **format 7**. Re-extract format-6 or older
artifacts, including retry inputs; changing the version number is not a migration.
Policy and completion-manifest versions are unchanged. See
[ADR 0009](docs/adr/0009-program-and-sequence-extraction.md).

## Selected synonyms

Add an optional `synonyms` collection to selection version 2 in `objects.json`.
List the synonym itself, using exact catalog spelling; extraction reads its target.
Use `PUBLIC` as the owner for public synonyms:

```json
{
  "version": 2,
  "tables": [{ "owner": "APP", "name": "CUSTOMERS" }],
  "synonyms": [
    { "owner": "REPORTING", "name": "CUSTOMERS" },
    { "owner": "PUBLIC", "name": "CUSTOMER_LIST" }
  ]
}
```

Synonym-only selections are valid. Selecting an alias does **not** select its target:
select each intermediate synonym and terminal object separately, or acknowledge
and provision them with the existing external-prerequisite policy. External setup
requires `createSchemas: false`. Existing table/view dependency closure is unchanged.

Extraction uses ALL/DBA synonym and object catalogs, retaining the exact mapping,
editionability, and resolved local chain. Missing or inaccessible targets, loops,
database links (including intermediate links), unsupported target types, selected
Oracle-maintained aliases, common objects, and edition-specific definitions fail
closed. Terminals must be tables, views, sequences, packages, procedures or functions.
PUBLIC fallback through a missing schema object requires DBA catalog scope: absence
in ALL_OBJECTS alone cannot prove that a private object does not shadow the alias.

Generated SQL creates aliases before tables, views and programs, without
`OR REPLACE`. PUBLIC is never provisioned as a user. Consumers follow recorded
underlying dependencies; narrow grants apply to underlying objects. Synonym
creation does not grant access. Early-created synonyms may remain marked INVALID
until resolution; verification checks mappings and underlying targets. Cross-owner
program access still requires operator
setup, and explicit synonym dependency facts in views need selected alias metadata
to establish their target type. SQL text is preserved, not parsed for alias usage.

Replay verifies exact mappings, terminal-object validity and PUBLIC fallback
shadowing (requiring DBA catalog visibility for the absence check); the local clone helper independently checks the same facts in DBA
catalogs. Redirected aliases and missing grants fail the relevant verification or
program-compilation gate. These checks do not execute application routines or prove
dynamic SQL behavior. Format 7 is required for source, target, and retry artifacts;
re-extract older documents.
