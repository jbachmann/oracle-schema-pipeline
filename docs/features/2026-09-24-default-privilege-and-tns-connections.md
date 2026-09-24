# Feature: Least-Privilege Catalog Extraction and TNS Connections

- Status: Planned
- Date: 2026-09-24
- Request: Let operators select least-privilege `ALL_*` or administrative
  `DBA_*` catalog views, and connect through either a full `tnsnames.ora` path
  plus alias or a raw Oracle connection string.

## Context and Scope

Extraction currently queries `DBA_*` views exclusively and therefore requires
administrative dictionary access. The CLI accepts `--dsn`, but it cannot point the
Thin driver at a particular `tnsnames.ora` file.

Included:

- Add `--catalog-scope all|dba`, defaulting to `all`, and route every extraction
  query consistently through the selected view family.
- Support a normal Oracle login (the `Default` connection role in clients such as
  SQL Developer), without `SYSDBA`, `SELECT ANY DICTIONARY`,
  `SELECT_CATALOG_ROLE`, or direct grants on `DBA_*` views.
- Extract objects owned by the connected user and cross-schema objects visible in
  `ALL_*` views through ordinary object privileges or roles.
- Preserve full-database extraction through `DBA_*` views when the operator
  explicitly selects `--catalog-scope dba` and the login has sufficient
  dictionary privileges.
- Preserve raw `--dsn` input for Easy Connect strings and complete Oracle Connect
  Descriptors.
- Add `--tnsnames <full-path-to-tnsnames.ora> --tns-alias <alias>` as an
  alternative connection form.
- Produce explicit errors for incomplete connection options, unreadable or
  incorrectly named TNS files, unknown aliases, and selected or dependent objects
  whose required metadata is not visible.
- Update unit, CLI, and Docker-backed Oracle integration coverage and user
  documentation.

Excluded:

- Automatically detecting privileges, silently falling back between `ALL_*` and
  `DBA_*`, or requiring `SYSDBA` specifically for DBA catalog mode.
- Granting database privileges or modifying the source database.
- Thick-mode Oracle Client initialization, wallets, external authentication, or
  password-bearing connection configuration.
- Parsing or rewriting a `tnsnames.ora` file, copying it to a temporary directory,
  or accepting an arbitrary filename in place of `tnsnames.ora`.
- Expanding extraction beyond objects visible to the connected user.

Approved assumptions:

- “Default privileges” means a normal connection rather than the `SYSDBA`
  authentication role. The account still needs `CREATE SESSION`; selected
  cross-schema objects must be visible through ordinary grants.
- The supplied full path names a readable file whose basename is exactly
  `tnsnames.ora`. The CLI passes its parent directory as node-oracledb `configDir`.
- `--dsn` remains the single raw connection option. A new `--raw-tns` synonym is
  unnecessary and would create two names for the same driver input.
- `--catalog-scope` defaults to `all` so an omitted option remains safe for a
  normally authenticated, least-privileged user. Existing administrative users
  select `--catalog-scope dba` when they require database-wide visibility.

Affected stage: `extract` only. Transform, validate, generate, and dictionary
remain offline and unchanged.

## Research Findings

### Verified repository facts

- `src/cli.ts` requires `--dsn` and `--user`, obtains the password from a hidden
  prompt or `ORACLE_PASSWORD`, and passes `--dsn` directly as `connectString`.
- `src/catalog.ts` uses 18 distinct `DBA_*` views: constraints, constraint
  columns, dependencies, encrypted columns, external tables, index columns,
  index expressions, indexes, materialized views, object tables, objects, table
  and column comments, table columns, identity columns, tables, users, and views.
- `README.md` currently directs operators to use `SELECT_CATALOG_ROLE` and the
  integration test extracts as `SYSTEM`.
- Only extraction imports node-oracledb. Output writes are non-overwriting, and
  credentials are not accepted as command arguments.
- The project currently depends on node-oracledb 6.10.x in Thin mode.

### Verified external facts

- Oracle distinguishes authentication mode from dictionary privileges. A normal
  connection may query `DBA_*` views only when it separately has `SYSDBA`,
  `SELECT ANY DICTIONARY`, `SELECT_CATALOG_ROLE`, or direct view privileges.
  `ALL_*` views instead describe objects accessible through the current user's
  ownership, privileges, or roles. [Oracle Database 23 static dictionary view
  reference](https://docs.oracle.com/en/database/oracle/oracle-database/23/refrn/about-static-data-dictionary-views.html)
  (accessed 2026-09-24).
- node-oracledb Thin mode accepts Easy Connect strings, full Connect Descriptors,
  and TNS aliases as `connectString`. A raw descriptor can therefore already be
  passed through `--dsn`, for example:

  ```text
  --dsn '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=example.com)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=sales.example.com)))'
  ```

  [node-oracledb 6.10 connection handling](https://node-oracledb.readthedocs.io/en/v6.10.0/user_guide/connection_handling.html)
  (accessed 2026-09-24).
- In Thin mode, node-oracledb does not search traditional Oracle Client locations
  automatically. `configDir` must identify the directory containing
  `tnsnames.ora`; `getNetworkServiceNames(configDir)` can enumerate its aliases.
  [node-oracledb optional Oracle configuration](https://node-oracledb.readthedocs.io/en/latest/user_guide/initialization.html)
  and [API reference](https://node-oracledb.readthedocs.io/en/latest/api_manual/oracledb.html)
  (accessed 2026-09-24).

### Inferences requiring implementation verification

- The corresponding `ALL_*` views normally expose the columns currently consumed
  from `DBA_*`, but visibility can differ by object type and grant path. The
  implementation must compare every query against supported Oracle 19 and 23
  instances and must not assume that seeing a table guarantees complete index,
  constraint, comment, dependency, identity, or special-table metadata.
- Cross-schema foreign keys and view dependencies can expose a selected object
  while withholding some referenced metadata. Existing completeness checks cover
  several cases, but catalog tests must prove that every newly possible partial
  result fails instead of producing a plausible incomplete document.

## Decisions and Boundaries

- Add an explicit `--catalog-scope all|dba` option. Default to `all`; reject any
  other value before opening a connection.
- Never probe privileges or fall back between families. `all` uses only `ALL_*`;
  `dba` uses only `DBA_*`. A privilege failure in `dba` mode remains an
  actionable extraction error rather than retrying with reduced visibility.
- A normal login is supported when all metadata required for the explicit
  selection and one-hop dependencies is visible. The feature does not promise
  extraction of arbitrary objects merely because the session can connect.
- Preserve the existing `--dsn <value>` interface for raw Easy Connect strings or
  Connect Descriptors. Connect strings must not contain passwords, and help text
  must state that command arguments may be visible to other local processes.
- TNS-file mode requires both `--tnsnames` and `--tns-alias`. It is mutually
  exclusive with `--dsn`.
- Validate `--tnsnames` before prompting for a password: it must be an absolute,
  readable regular file named `tnsnames.ora`. Resolve its parent directory for
  `configDir`; do not rewrite, copy, or log file contents.
- Enumerate aliases with `getNetworkServiceNames(configDir)` and compare the
  requested alias case-insensitively before connecting. An absent alias is a
  stable CLI error naming the alias and file path but not printing file contents.
- For TNS-file mode, call `getConnection` with `connectString: <alias>` and
  `configDir: <parent-directory>`. Raw `--dsn` mode supplies no `configDir` and
  retains current behavior.
- Catalog absence and catalog invisibility cannot always be distinguished through
  `ALL_*`. Use stable wording such as `Missing or inaccessible ...` and name the
  exact object/metadata category. Never silently omit a selected object,
  dependency, constraint component, index key/expression, comment row, identity,
  or special-table marker.
- The source JSON contract and `formatVersion: 3` do not change. Connection inputs
  and catalog scope are operational CLI state and must not enter artifacts. For a
  selection visible in both modes, the source documents must be identical.
- ADR 0001 requires no replacement. The design strengthens its read-only and
  least-privilege intent while retaining the rule that only extraction connects.

## Proposed Design

### Connection option resolution

Add a focused connection-option resolver, preferably `src/connection.ts`, so CLI
validation can be unit-tested without opening a database connection. It receives
the parsed `dsn`, `tnsnames`, and `tnsAlias` values plus filesystem and alias-list
dependencies, and returns one of:

```ts
{ connectString: string }
{ connectString: string; configDir: string }
```

The resolver applies these stable cases:

| Inputs | Result |
|---|---|
| `--dsn <raw>` only | `{ connectString: raw }` |
| `--tnsnames <absolute-file> --tns-alias <alias>` | Alias plus the file's parent as `configDir` |
| No connection form | `Missing --dsn or --tnsnames/--tns-alias. See --help.` |
| `--dsn` plus either TNS-file option | Mutually-exclusive-options error |
| Only one TNS-file option | Error naming the missing paired option |
| Relative, missing, unreadable, non-file, or differently named path | Actionable TNS-path error |
| Alias absent from parsed file | `TNS alias <alias> not found in <path>.` |

`src/cli.ts` adds the connection options and `--catalog-scope`, invokes the
resolver before password reading, and spreads its result into
`oracle.getConnection`. Help includes one Easy Connect example, one raw
descriptor example, one file-plus-alias example, and both catalog scopes.

### Selectable catalog adapter

Define a closed `CatalogScope = 'all' | 'dba'` type and pass it from `src/cli.ts`
to `OracleCatalog`. In `src/catalog.ts`, map each logical catalog source to an
explicit pair of `ALL_*` and `DBA_*` identifiers while retaining owner predicates
and deterministic ordering. Do not derive identifiers from unchecked text and do
not use free-form string replacement. The paired sources are:

- `ALL_TABLES` / `DBA_TABLES`, `ALL_TAB_COLS` / `DBA_TAB_COLS`,
  `ALL_TAB_COLUMNS` / `DBA_TAB_COLUMNS`, and `ALL_TAB_IDENTITY_COLS` /
  `DBA_TAB_IDENTITY_COLS`
- `ALL_CONSTRAINTS` / `DBA_CONSTRAINTS` and `ALL_CONS_COLUMNS` /
  `DBA_CONS_COLUMNS`
- `ALL_INDEXES` / `DBA_INDEXES`, `ALL_IND_COLUMNS` / `DBA_IND_COLUMNS`, and
  `ALL_IND_EXPRESSIONS` / `DBA_IND_EXPRESSIONS`
- `ALL_TAB_COMMENTS` / `DBA_TAB_COMMENTS` and `ALL_COL_COMMENTS` /
  `DBA_COL_COMMENTS`
- `ALL_VIEWS` / `DBA_VIEWS`, `ALL_OBJECTS` / `DBA_OBJECTS`, and
  `ALL_DEPENDENCIES` / `DBA_DEPENDENCIES`
- `ALL_EXTERNAL_TABLES` / `DBA_EXTERNAL_TABLES`, `ALL_OBJECT_TABLES` /
  `DBA_OBJECT_TABLES`, `ALL_MVIEWS` / `DBA_MVIEWS`,
  `ALL_ENCRYPTED_COLUMNS` / `DBA_ENCRYPTED_COLUMNS`, and `ALL_USERS` /
  `DBA_USERS`

Review each selected column and join rather than mechanically renaming strings.
If an `ALL_*` view lacks a required column on a supported Oracle version, derive
the fact from another non-administrative `ALL_*`/`USER_*` view only when it is
semantically equivalent; otherwise reject that object with a documented error.
Do not weaken unsupported-feature detection to make extraction succeed.

Add explicit cardinality/completeness checks around catalog collections where an
empty or partial `ALL_*` result could currently be interpreted as “feature not
present.” At minimum cover selected table/view existence, constraint columns and
referenced constraint resolution, index key positions and function expressions,
column/comment parity, identity-column parity, and declared dependencies.

`databaseVersion()` may retain `PRODUCT_COMPONENT_VERSION` only after integration
coverage proves it is readable by the least-privileged fixture user. Otherwise use
the public node-oracledb connection server-version property through a small
catalog constructor dependency without broadening privileges.

The two scopes differ only in visibility and privilege requirements. They share
the same mapping, completeness validation, diagnostics, `SourceCatalog`
interface, and output model. `dba` mode must not bypass fail-closed checks merely
because it has broader visibility.

### Contract, diagnostics, and security

No model, transform, validation, generation, or SQL ordering changes are needed.
Connection descriptors, paths, aliases, usernames, and passwords are not written
to source documents, reports, generated SQL, or normal success logs. Driver errors
may be surfaced, but application-added diagnostics must not echo a password or
the contents of a network configuration file.

The source connection remains query-only. Tests must assert that catalog SQL is
`SELECT` only, the selected query family never mixes `ALL_*` and `DBA_*`, and no
query uses `DBMS_METADATA`, DDL, DML, or PL/SQL.

## Implementation Plan

1. Add connection-mode parsing and validation in `src/connection.ts`, including
   absolute regular-file validation, exact basename validation, alias lookup, and
   stable option-conflict diagnostics.
2. Extend `src/cli.ts` with `--tnsnames`, `--tns-alias`, and
   `--catalog-scope all|dba`; default the scope to `all`, resolve all options
   before password acquisition, pass `configDir` only for alias mode, and update
   help examples while preserving `--dsn` behavior.
3. Add the closed catalog-scope type and explicit view-pair map in
   `src/catalog.ts`. Audit every current `DBA_*` query, add its `ALL_*` equivalent,
   and select the complete family from the constructor scope. Preserve owner
   predicates, LONG-expression handling, ordered result sets, caching, and exact
   mapping.
4. Add or strengthen catalog cardinality and positional checks so restricted
   visibility cannot silently become absent metadata. Standardize actionable
   `Missing or inaccessible` errors.
5. Extend `test/catalog.test.ts` to exercise both complete query families, assert
   that neither mode mixes prefixes, compare equivalent mapped output, preserve
   full LONG values and deterministic order, and reject partial constraints,
   indexes, identities, dependencies, and comments in either mode.
6. Add `test/connection.test.ts` for the option matrix, raw descriptors, absolute
   TNS paths, case-insensitive aliases, path failures, alias failures, and
   sanitized diagnostics. Use temporary files and injected alias enumeration; do
   not require Oracle.
7. Change `docker/oracle/source-init/01-seed.sql` to create a dedicated extraction
   user authenticated normally with only `CREATE SESSION` and the minimum
   ordinary object privileges required for the integration selection. Do not
   grant `DBA`, `SELECT_CATALOG_ROLE`, `SELECT ANY DICTIONARY`, direct `DBA_*`
   access, or source DDL privileges.
8. Extend `test/integration/oracle-roundtrip.test.ts` to extract with that user in
   raw `--dsn --catalog-scope all` mode, assert its prohibited dictionary access
   and explicit `--catalog-scope dba` extraction fail, and compare the successful
   model with the established structural expectations. Extract the same selection
   with the existing administrative account and `--catalog-scope dba`; compare
   documents after excluding only established nondeterministic source metadata.
9. Add an integration TNS fixture outside credential-bearing source files. Run a
   second extraction through an absolute `tnsnames.ora` path and alias, compare it
   with raw-DSN extraction, and cover an unknown alias rejection. Ensure generated
   temporary output paths remain non-overwriting.
10. Update `README.md` prerequisites and examples: `all` default versus explicit
    `dba`, normal authentication versus dictionary privileges, exact visibility
    limits of `ALL_*`, raw Easy Connect/raw descriptor quoting,
    full-path-plus-alias syntax, Thin-mode lookup behavior, and secret-handling
    cautions.
11. Run `npm run typecheck`, `npm test`, `npm run build`, and
    `npm run test:integration`. Verify every referenced CLI example with
    `npm run schema -- --help` and the Docker fixture.

## Test Plan

Unit and CLI tests:

- Existing raw Easy Connect `--dsn host:1521/service` resolves unchanged.
- A complete raw descriptor is passed byte-for-byte as `connectString`.
- A valid absolute `/path/to/tnsnames.ora` and case-insensitive alias resolve to
  the alias plus `/path/to` as `configDir`.
- Missing, conflicting, paired-option, relative-path, wrong-basename,
  nonexistent, unreadable, directory, malformed-file, and absent-alias cases fail
  before password prompting with stable diagnostics.
- Diagnostics never include TNS file contents or password environment values.
- `--catalog-scope` omitted and `--catalog-scope all` produce only the approved
  `ALL_*` sources; `--catalog-scope dba` produces only the paired `DBA_*`
  sources. All binds and explicit owner filters remain present.
- Invalid scope values fail before connection and password prompting.
- Equivalent visible selections map to identical source definitions in `all` and
  `dba` modes.
- Owned-schema table/view metadata maps identically to the current fixture.
- Cross-schema metadata visible through ordinary grants maps identically.
- Each simulated partial catalog result rejects with the affected qualified name
  and metadata category.

Oracle integration tests:

- The dedicated extractor connects normally and cannot select from a representative
  `DBA_*` view.
- It extracts the owned and granted cross-schema fixture objects through `ALL_*`
  with complete tables, views, comments, identities, constraints, indexes,
  dependencies, and one-hop parents.
- The dedicated extractor fails explicitly in `dba` mode without falling back;
  an administrative catalog reader succeeds in `dba` mode.
- `all` and `dba` extractions of the same fully visible selection are structurally
  equivalent and preserve identical ordering.
- Raw Easy Connect and TNS-alias extraction produce equivalent source structure;
  connection-specific values do not appear in artifacts.
- A selected object lacking sufficient visibility fails explicitly and creates no
  partial output file.
- Existing transform, validation, generation, replay, comments, views, and
  deterministic ordering assertions continue to pass.

## Acceptance Criteria

- [ ] Extraction succeeds for the integration user using normal authentication,
      `CREATE SESSION`, and ordinary object grants, with no administrative
      dictionary privilege.
- [ ] `--catalog-scope` defaults to `all`; explicit `all` uses only `ALL_*`, and
      explicit `dba` uses only `DBA_*`.
- [ ] `dba` succeeds for an appropriately privileged normal login and fails
      clearly for a login without dictionary access; no automatic fallback occurs.
- [ ] Neither catalog scope writes to Oracle.
- [ ] Every selected and one-hop object is complete, or extraction fails with a
      stable qualified `Missing or inaccessible` diagnostic.
- [ ] `--dsn` accepts existing Easy Connect values and raw Connect Descriptors
      without behavioral regression.
- [ ] `--tnsnames <absolute-path-to-tnsnames.ora> --tns-alias <alias>` connects in
      Thin mode and rejects invalid paths and aliases before password prompting.
- [ ] The two connection forms are mutually exclusive, and partial option sets
      fail with actionable help.
- [ ] Connection configuration and credentials do not enter artifacts or normal
      logs; existing hidden-prompt/`ORACLE_PASSWORD` behavior remains intact.
- [ ] Source document `formatVersion: 3` and all offline-stage behavior remain
      compatible and deterministic.
- [ ] Source output remains non-overwriting, and failed extraction leaves no
      partial artifact.
- [ ] Unit tests cover success, boundaries, conflicts, visibility gaps, and
      explicit rejection; Oracle integration covers both connection forms.
- [ ] `npm run typecheck`, `npm test`, `npm run build`, and
      `npm run test:integration` pass.
- [ ] README states that `all` requires no administrative dictionary role and
      that `dba` requires `SYSDBA`, `SELECT ANY DICTIONARY`,
      `SELECT_CATALOG_ROLE`, or sufficient direct catalog grants.

## Risks and Open Questions

- Oracle's `ALL_*` visibility rules differ by object type and grant path. The
  integration privilege matrix may reveal that some currently modeled facts are
  unavailable for role-granted or cross-schema objects. The implementation must
  fail closed or document a narrower ordinary-grant requirement; `all` mode must
  not fall back to `DBA_*`.
- Maintaining paired identifiers creates query-drift risk. Centralized typed
  mappings and parity tests must ensure new catalog queries are implemented for
  both scopes.
- Function-based index expressions, referenced constraints, and dependency rows
  are the highest-risk partial-visibility areas and need explicit Oracle 19/23
  verification.
- A `tnsnames.ora` file can reference other local files with `IFILE` or contain
  environment-specific network settings. Passing its directory to node-oracledb
  preserves driver semantics; application code must not attempt to flatten it.

